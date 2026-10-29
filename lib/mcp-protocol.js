/**
 * Minimal MCP (Model Context Protocol) server core: JSON-RPC 2.0 message
 * handling for `initialize`, `ping`, `tools/list` and `tools/call`, plus
 * `notifications/cancelled` abort wiring. Transport-agnostic — the HTTP
 * carrier in ./http-server.js feeds parsed payloads in and serializes replies.
 *
 * Protocol versions: 2025-06-18 (current), 2025-03-26 (streamable HTTP),
 * 2024-11-05 (HTTP+SSE). A client requesting a supported version gets it back;
 * anything else is answered with the newest supported version.
 *
 * @module @liuxinye/dsh-ai-chat-mcp/mcp-protocol
 */

/** Newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

/**
 * Build one MCP server over a tool list.
 *
 * @param options.serverInfo - `{ name, version }` reported by `initialize`.
 * @param options.instructions - optional guidance text for the calling model.
 * @param options.tools - tool descriptors: `{ name, title, description,
 *   inputSchema, handler(args, meta) }`. `handler` resolves to a result object
 *   or throws; thrown errors become `isError` tool results.
 * @param options.resources - optional resource provider `{ templates, list(),
 *   read(uri) }` exposed through the MCP resources capability.
 * @param options.logger - host logger.
 */
export function createMcpServer({ serverInfo, instructions, tools, resources, logger }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  /** In-flight `tools/call` requests, for `notifications/cancelled`. */
  const inflight = new Map()
  let initialized = false

  const toolDescriptors = () =>
    tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))

  function errorReply(id, code, message, data) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }
  }

  function resultReply(id, result) {
    return { jsonrpc: '2.0', id, result }
  }

  /** One inbound JSON-RPC message that expects a reply. */
  async function handleRequest(message, context) {
    const { id, method, params } = message
    try {
      switch (method) {
        case 'initialize': {
          initialized = true
          const requested = params?.protocolVersion
          return resultReply(id, {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              ...(resources === undefined ? {} : { resources: { subscribe: false, listChanged: false } }),
            },
            serverInfo,
            ...(instructions === undefined ? {} : { instructions }),
          })
        }
        case 'ping':
          return resultReply(id, {})
        case 'tools/list':
          return resultReply(id, { tools: toolDescriptors() })
        case 'tools/call':
          return await handleToolCall(id, params, context)
        case 'resources/list':
          return await handleResourcesList(id)
        case 'resources/templates/list':
          return resultReply(id, { resourceTemplates: resources?.templates ?? [] })
        case 'resources/read':
          return await handleResourcesRead(id, params)
        default:
          return errorReply(id, METHOD_NOT_FOUND, `unknown method: ${String(method)}`)
      }
    } catch (error) {
      logger?.warn?.('ai-chat-mcp: request %s failed: %s', method, error instanceof Error ? error.message : String(error))
      return errorReply(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
    }
  }

  async function handleResourcesList(id) {
    if (resources === undefined) return errorReply(id, METHOD_NOT_FOUND, 'resources are not enabled')
    try {
      return resultReply(id, { resources: await resources.list() })
    } catch (error) {
      return errorReply(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
    }
  }

  async function handleResourcesRead(id, params) {
    if (resources === undefined) return errorReply(id, METHOD_NOT_FOUND, 'resources are not enabled')
    const uri = params?.uri
    if (typeof uri !== 'string' || uri.length === 0) return errorReply(id, INVALID_PARAMS, 'uri must be a non-empty string')
    try {
      return resultReply(id, await resources.read(uri))
    } catch (error) {
      return errorReply(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
    }
  }

  async function handleToolCall(id, params, context) {
    const name = params?.name
    const tool = byName.get(name)
    if (tool === undefined) return errorReply(id, INVALID_PARAMS, `unknown tool: ${String(name)}`)
    const args = params?.arguments ?? {}
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return errorReply(id, INVALID_PARAMS, 'arguments must be an object')
    }
    const controller = new AbortController()
    const external = context?.signal
    const onExternalAbort = () => controller.abort(external?.reason)
    if (external !== undefined) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }
    inflight.set(id, controller)
    const progressToken = params?._meta?.progressToken
    const canReport = progressToken !== undefined && context?.notify !== undefined
    let progress = 0
    let lastReportAt = 0
    const reportProgress = (message) => {
      if (!canReport) return
      progress += 10
      lastReportAt = Date.now()
      try {
        context.notify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken, progress, total: 100, ...(message === undefined ? {} : { message }) },
        })
      } catch {
        /* transport gone */
      }
    }
    // Heartbeat for tools that report no milestones of their own.
    const heartbeat = setInterval(() => {
      if (Date.now() - lastReportAt >= 15_000) reportProgress('working…')
    }, 15_000)
    heartbeat.unref?.()
    const startedAt = Date.now()
    try {
      const value = await tool.handler(args, { signal: controller.signal, reportProgress })
      const isError = value?.isError === true
      const payload = value?.value ?? value
      const text = typeof value?.text === 'string' ? value.text : JSON.stringify(payload, null, 2)
      logger?.info?.('ai-chat-mcp: tools/call %s ok (%dms)', name, Date.now() - startedAt)
      return resultReply(id, {
        content: [{ type: 'text', text }],
        ...(isError ? { isError: true } : {}),
        ...(payload !== null && typeof payload === 'object' && !isError ? { structuredContent: payload } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.info?.('ai-chat-mcp: tools/call %s failed (%dms): %s', name, Date.now() - startedAt, message)
      return resultReply(id, {
        content: [{ type: 'text', text: `tool "${name}" failed: ${message}` }],
        isError: true,
      })
    } finally {
      clearInterval(heartbeat)
      inflight.delete(id)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** Inbound notification or client response: no reply. */
  function handleNotification(message) {
    if (message.method === 'notifications/initialized') initialized = true
    if (message.method === 'notifications/cancelled') {
      const controller = inflight.get(message.params?.requestId)
      controller?.abort(new Error(message.params?.reason ?? 'cancelled by client'))
    }
    return undefined
  }

  /**
   * Feed one parsed transport payload (single message or batch) through the
   * server. Resolves to the ordered replies to serialize; notifications and
   * client responses produce none.
   *
   * @param payload - parsed JSON-RPC message, batch array, or invalid value.
   * @param context - `{ signal, notify }`; `notify` streams server messages
   *   (progress) before the final replies when the transport supports it.
   */
  async function handleMessage(payload, context = {}) {
    const batch = Array.isArray(payload) ? payload : [payload]
    const replies = []
    for (const message of batch) {
      if (message === null || typeof message !== 'object') {
        replies.push(errorReply(null, INVALID_REQUEST, 'message must be a JSON object'))
        continue
      }
      if (message.jsonrpc !== '2.0') {
        replies.push(errorReply(message.id ?? null, INVALID_REQUEST, 'jsonrpc must be "2.0"'))
        continue
      }
      if (message.method === undefined) {
        // A client response to a server-initiated request; we send none.
        continue
      }
      if (message.id === undefined) {
        handleNotification(message)
        continue
      }
      replies.push(await handleRequest(message, context))
    }
    return replies
  }

  /** Reply for a payload that failed JSON parsing. */
  function parseErrorReply() {
    return [errorReply(null, PARSE_ERROR, 'parse error')]
  }

  return {
    serverInfo,
    handleMessage,
    parseErrorReply,
    isInitialized: () => initialized,
  }
}

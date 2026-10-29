/**
 * AI Chat MCP — Host half of the AI Chat MCP bundle.
 *
 * Opens an MCP (Model Context Protocol) server from the Harness itself so
 * external tools — Claude Desktop, Cursor, n8n, scripts — can create DeepSeek
 * Harness sessions, run conversation turns and get assistant answers, read
 * transcripts, search sessions, cancel running work and select models.
 *
 * Transports live in ./http-server.js (Streamable HTTP at /mcp plus optional
 * legacy HTTP+SSE at /sse), the MCP protocol in ./mcp-protocol.js, the tool
 * surface in ./tools.js and the Harness conversation driver in ./chat.js.
 * Stdio-only MCP clients use ./stdio-bridge.mjs, which forwards stdio JSON-RPC
 * to the HTTP endpoint.
 *
 * @module @liuxinye/dsh-ai-chat-mcp
 */

import { randomBytes } from 'node:crypto'
import { createChatDriver } from './chat.js'
import { createMcpServer } from './mcp-protocol.js'
import { createHttpServer } from './http-server.js'
import { buildTools, buildResources } from './tools.js'

/** Plugin row name shown by the Loader. */
export const name = 'ai-chat-mcp'

/** The session services that back the conversation surface. */
export const inject = ['sessionController', 'sessionQuery', 'sessions', 'agents', 'workspaceController', 'workspaceRegistry']

/** Config defaults; `cordis.patch.yml` overrides them. */
const DEFAULTS = Object.freeze({
  /** Interface the MCP endpoint binds to. */
  host: '127.0.0.1',
  /** TCP port of the MCP endpoint. */
  port: 8391,
  /** Optional bearer token required of every client; 'auto' generates one per start. */
  authToken: '',
  /** Default wait budget for one conversation turn (ms). */
  defaultTimeoutMs: 600000,
  /** Largest accepted request body (bytes). */
  maxBodyBytes: 1024 * 1024,
  /** Also serve the legacy HTTP+SSE transport. */
  enableLegacySse: true,
  /** Keep-alive comment interval for open SSE responses (ms). */
  keepAliveMs: 15000,
  /** Requests settling faster than this answer with one JSON body (ms). */
  jsonGraceMs: 3000,
})

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i

/**
 * Validate and normalize the row config.
 *
 * @param {Record<string, unknown>} config - raw `cordis.patch.yml` row config.
 * @param logger - host logger.
 */
function normalizeConfig(config, logger) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  settings.host = typeof settings.host === 'string' && settings.host.length > 0 ? settings.host : DEFAULTS.host
  settings.port = Number.isInteger(settings.port) && settings.port >= 0 && settings.port <= 65535 ? settings.port : DEFAULTS.port
  settings.authToken = typeof settings.authToken === 'string' ? settings.authToken.trim() : ''
  for (const field of ['defaultTimeoutMs', 'maxBodyBytes', 'keepAliveMs', 'jsonGraceMs']) {
    const value = settings[field]
    settings[field] = Number.isFinite(value) && value > 0 ? value : DEFAULTS[field]
  }
  settings.enableLegacySse = settings.enableLegacySse !== false
  if (settings.authToken === 'auto') {
    settings.authToken = `dsh_${randomBytes(24).toString('hex')}`
    settings.autoToken = true
  }
  if (!LOOPBACK.test(settings.host) && settings.authToken.length === 0) {
    logger.error?.(
      'ai-chat-mcp: refusing to bind non-loopback host %s without authToken; set config.authToken ("auto" generates one per start) in cordis.patch.yml',
      settings.host,
    )
    settings.port = -1
  }
  return settings
}

/**
 * Mount the AI Chat MCP server.
 *
 * @param ctx - Cordis context carrying the session services.
 * @param config - row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const settings = normalizeConfig(config, logger)
  const chat = createChatDriver(ctx, settings, logger)
  const mcp = createMcpServer({
    serverInfo: { name: 'dsh-ai-chat-mcp', version: '0.2.0' },
    instructions:
      'This server exposes the local DeepSeek Harness agent. Use dsh_chat for one-shot conversations ' +
      '(it creates a session when needed), dsh_session_create + dsh_session_prompt for multi-turn work, ' +
      'and dsh_session_read to inspect earlier turns. Sessions are shared with the local DSH UI.',
    tools: buildTools(chat),
    resources: buildResources(chat),
    logger,
  })
  const transport = createHttpServer({ mcp, settings, logger, serverInfo: mcp.serverInfo })
  if (settings.port >= 0) {
    transport.start()
    const origin = `http://${settings.host === '0.0.0.0' ? '<this-host>' : settings.host}:${settings.port}`
    const mode = settings.authToken.length === 0 ? 'open on loopback (no token)' : settings.autoToken === true ? 'token generated for this start' : 'bearer token configured'
    logger.info?.('ai-chat-mcp: endpoint %s/mcp (legacy %s/sse) — %s', origin, origin, mode)
    if (settings.autoToken === true) {
      logger.warn?.(
        'ai-chat-mcp: authToken "auto" generated a token for this start (it changes on every start). ' +
          'Clients must send Authorization: Bearer %s',
        settings.authToken,
      )
    }
  }
  return () => {
    transport.close()
    chat.dispose()
  }
}

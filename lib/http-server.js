/**
 * HTTP carrier for the AI Chat MCP server.
 *
 * Endpoints:
 *   POST /mcp      Streamable HTTP transport (protocol 2025-03-26+). Fast
 *                  requests answer with one JSON body; requests still running
 *                  after `jsonGraceMs` upgrade to an SSE stream with keep-alive
 *                  comments and a final `message` event per reply.
 *   GET  /sse      Legacy HTTP+SSE transport (protocol 2024-11-05). Sends an
 *                  `endpoint` event carrying the per-connection POST target.
 *   POST /message  Legacy transport message ingest; replies stream over /sse.
 *   GET  /health   Small liveness probe with the server identity.
 *
 * Security: loopback bind by default, optional bearer token (required for
 * non-loopback binds), and an Origin check against DNS rebinding for browser
 * callers.
 *
 * @module @liuxinye/dsh-ai-chat-mcp/http-server
 */

import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i

/** Constant-time token comparison. */
function tokenMatches(expected, actual) {
  if (typeof actual !== 'string') return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(actual).digest()
  return timingSafeEqual(a, b)
}

function isLoopbackHost(hostname) {
  return LOOPBACK.test(hostname ?? '')
}

export function createHttpServer({ mcp, settings, logger, serverInfo }) {
  /** Legacy SSE connections, keyed by their message endpoint session id. */
  const legacyStreams = new Map()
  let keepAliveTimer

  function sendJson(response, status, body, headers = {}) {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
      ...headers,
    })
    response.end(payload)
  }

  /** Read one bounded request body and parse it as JSON. */
  function readJsonBody(request, maxBytes) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        resolve(value)
      }
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          finish({ error: 'body-too-large' })
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('error', () => finish({ error: 'read-failed' }))
      request.on('end', () => {
        if (done) return
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (raw.length === 0) {
          finish({ error: 'empty-body' })
          return
        }
        try {
          finish({ value: JSON.parse(raw) })
        } catch {
          finish({ error: 'parse-error' })
        }
      })
    })
  }

  /** Authorize one request: bearer token plus Origin/DNS-rebinding checks. */
  function authorize(request) {
    const origin = request.headers.origin
    if (typeof origin === 'string' && origin !== 'null' && origin !== '') {
      let hostname
      try {
        hostname = new URL(origin).hostname
      } catch {
        return { status: 403, message: 'forbidden origin' }
      }
      if (!isLoopbackHost(hostname)) return { status: 403, message: 'forbidden origin' }
    }
    if (settings.authToken.length > 0) {
      const header = request.headers.authorization
      const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
      if (!tokenMatches(settings.authToken, presented)) {
        return { status: 401, message: 'unauthorized' }
      }
    }
    return undefined
  }

  function corsHeaders(request) {
    const origin = request.headers.origin
    return {
      'access-control-allow-origin': typeof origin === 'string' && origin.length > 0 ? origin : '*',
      'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-expose-headers': 'mcp-session-id',
    }
  }

  /** Open one SSE response stream with keep-alive comments. */
  function openSse(response, cors) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...cors,
    })
    response.write(': open\n\n')
    return {
      event(name, data) {
        response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      },
      comment(text) {
        response.write(`: ${text}\n\n`)
      },
      close() {
        response.end()
      },
    }
  }

  /**
   * Streamable HTTP POST: answer fast requests with one JSON body and upgrade
   * slow ones to an SSE stream that keeps the connection alive until the last
   * reply.
   */
  async function handleStreamablePost(request, response, cors) {
    const body = await readJsonBody(request, settings.maxBodyBytes)
    if (body.error === 'body-too-large') {
      sendJson(response, 413, { error: 'request body too large' }, cors)
      return
    }
    const parsed = body.error === undefined ? body.value : undefined
    if (parsed === undefined && body.error !== 'parse-error') {
      sendJson(response, 400, { error: body.error }, cors)
      return
    }

    // Notifications and responses are acknowledged with 202 and no body.
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    const expectsReply = body.error === 'parse-error' || messages.some((m) => m && typeof m === 'object' && m.method !== undefined && m.id !== undefined)
    if (!expectsReply) {
      if (body.error === undefined) await mcp.handleMessage(parsed, {})
      response.writeHead(202, cors)
      response.end()
      return
    }

    // A client that asked for progress gets a stream from the first byte, so
    // no milestone is lost to the JSON grace window below.
    const wantsStream = messages.some((m) => m && typeof m === 'object' && m.params?._meta?.progressToken !== undefined)

    let stream
    /** Notifications emitted before the stream opens are buffered and flushed. */
    const pendingNotifications = []
    const notify = (message) => {
      if (stream !== undefined) stream.event('message', message)
      else if (pendingNotifications.length < 100) pendingNotifications.push(message)
    }
    const controller = new AbortController()
    response.on('close', () => {
      if (!response.writableEnded) controller.abort(new Error('client disconnected'))
    })
    const run =
      body.error === 'parse-error'
        ? Promise.resolve(mcp.parseErrorReply())
        : mcp.handleMessage(parsed, { signal: controller.signal, notify })

    const grace = wantsStream
      ? Promise.resolve('streaming')
      : new Promise((resolve) => {
          const timer = setTimeout(() => resolve('streaming'), settings.jsonGraceMs)
          timer.unref?.()
          const settle = () => {
            clearTimeout(timer)
            resolve('ready')
          }
          run.then(settle, settle)
        })

    if ((await grace) === 'ready') {
      const replies = await run
      sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0] ?? null, cors)
      return
    }

    stream = openSse(response, cors)
    for (const notification of pendingNotifications) stream.event('message', notification)
    pendingNotifications.length = 0
    const keepAlive = setInterval(() => stream.comment('keepalive'), settings.keepAliveMs)
    keepAlive.unref?.()
    try {
      const replies = await run
      for (const reply of replies) stream.event('message', reply)
    } catch (error) {
      logger.warn?.('ai-chat-mcp: stream failed: %s', error instanceof Error ? error.message : String(error))
    } finally {
      clearInterval(keepAlive)
      stream.close()
    }
  }

  /** Legacy HTTP+SSE transport: one event stream per connection. */
  function handleLegacySse(request, response, cors) {
    const id = randomUUID()
    const stream = openSse(response, cors)
    legacyStreams.set(id, stream)
    // The legacy endpoint event carries a raw URI, not a JSON value.
    response.write(`event: endpoint\ndata: /message?sessionId=${id}\n\n`)
    response.on('close', () => {
      legacyStreams.delete(id)
      stream.close()
    })
  }

  /** Legacy transport ingest: replies are pushed to the /sse stream. */
  async function handleLegacyMessage(request, response, cors) {
    const url = new URL(request.url ?? '/', 'http://ai-chat-mcp.invalid')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const stream = legacyStreams.get(sessionId)
    if (stream === undefined) {
      sendJson(response, 404, { error: 'unknown session' }, cors)
      return
    }
    const body = await readJsonBody(request, settings.maxBodyBytes)
    if (body.error !== undefined) {
      sendJson(response, body.error === 'body-too-large' ? 413 : 400, { error: body.error }, cors)
      return
    }
    response.writeHead(202, cors)
    response.end()
    const replies = await mcp.handleMessage(body.value, {})
    for (const reply of replies) stream.event('message', reply)
  }

  const server = createServer(async (request, response) => {
    const cors = corsHeaders(request)
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors)
      response.end()
      return
    }
    const denial = authorize(request)
    if (denial !== undefined) {
      sendJson(
        response,
        denial.status,
        { error: denial.message },
        denial.status === 401 ? { 'www-authenticate': 'Bearer', ...cors } : cors,
      )
      return
    }
    const url = new URL(request.url ?? '/', 'http://ai-chat-mcp.invalid')
    try {
      if (url.pathname === '/mcp') {
        if (request.method === 'POST') {
          await handleStreamablePost(request, response, cors)
          return
        }
        response.writeHead(405, { allow: 'POST, OPTIONS', ...cors })
        response.end()
        return
      }
      if (url.pathname === '/sse' && settings.enableLegacySse) {
        if (request.method === 'GET') {
          handleLegacySse(request, response, cors)
          return
        }
        response.writeHead(405, { allow: 'GET, OPTIONS', ...cors })
        response.end()
        return
      }
      if (url.pathname === '/message' && settings.enableLegacySse) {
        if (request.method === 'POST') {
          await handleLegacyMessage(request, response, cors)
          return
        }
        response.writeHead(405, { allow: 'POST, OPTIONS', ...cors })
        response.end()
        return
      }
      if (url.pathname === '/health') {
        sendJson(response, 200, { ok: true, ...serverInfo }, cors)
        return
      }
      sendJson(response, 404, { error: 'not found' }, cors)
    } catch (error) {
      logger.warn?.('ai-chat-mcp: request failed: %s', error instanceof Error ? error.message : String(error))
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' }, cors)
      else response.end()
    }
  })

  server.on('error', (error) => {
    logger.error?.('ai-chat-mcp: server error: %s', error instanceof Error ? error.message : String(error))
  })

  keepAliveTimer = setInterval(() => {
    for (const stream of legacyStreams.values()) stream.comment('keepalive')
  }, settings.keepAliveMs)
  keepAliveTimer.unref?.()

  return {
    start() {
      server.listen(settings.port, settings.host, () => {
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : settings.port
        logger.info?.(
          'ai-chat-mcp: MCP server listening on http://%s:%s/mcp (legacy: /sse)%s',
          settings.host,
          port,
          settings.authToken.length > 0 ? ' [token protected]' : '',
        )
      })
    },
    close() {
      clearInterval(keepAliveTimer)
      for (const stream of legacyStreams.values()) stream.close()
      legacyStreams.clear()
      server.close()
    },
  }
}

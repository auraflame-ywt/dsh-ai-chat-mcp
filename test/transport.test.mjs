/** Standalone transport smoke test (mock chat driver, no DSH runtime). */
import { createHttpServer } from '../lib/http-server.js'
import { createMcpServer } from '../lib/mcp-protocol.js'

const tools = [
  { name: 'fast', title: 'Fast', description: 'fast tool', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ text: 'quick', value: { ok: true } }) },
  { name: 'slow', title: 'Slow', description: 'slow tool', inputSchema: { type: 'object', properties: {} }, handler: async () => { await new Promise((r) => setTimeout(r, 4500)); return { text: 'done-slow', value: { ok: true } } } },
  { name: 'reporting', title: 'Reporting', description: 'reports progress', inputSchema: { type: 'object', properties: {} }, handler: async (args, meta) => { meta.reportProgress('milestone'); return { text: 'reported', value: { ok: true } } } },
]

const mcp = createMcpServer({ serverInfo: { name: 't', version: '0' }, tools, logger: console })
const settings = {
  host: '127.0.0.1',
  port: 18391,
  authToken: 'secret',
  defaultTimeoutMs: 60000,
  maxBodyBytes: 65536,
  enableLegacySse: true,
  keepAliveMs: 1000,
  jsonGraceMs: 300,
}
const server = createHttpServer({ mcp, settings, logger: console, serverInfo: mcp.serverInfo })
server.start()
await new Promise((r) => setTimeout(r, 200))

const BASE = 'http://127.0.0.1:18391'
const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}

// 1. auth: no token -> 401
{
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check('auth rejects missing token', res.status === 401, `status=${res.status}`)
}
// 2. health with token
{
  const res = await fetch(`${BASE}/health`, { headers: { authorization: 'Bearer secret' } })
  const body = await res.json()
  check('health with token', res.status === 200 && body.ok === true, JSON.stringify(body))
}
// 3. fast tool -> JSON body within grace
{
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fast', arguments: {} } }),
  })
  const ct = res.headers.get('content-type') ?? ''
  const body = await res.json()
  check('fast tool answers as JSON', ct.includes('application/json') && body.result.content[0].text === 'quick', `ct=${ct}`)
}
// 4. slow tool -> SSE stream with keepalive + final message
{
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } }),
  })
  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  check('slow tool streams SSE', ct.includes('text/event-stream') && text.includes('done-slow') && text.includes(': keepalive'), `ct=${ct} bytes=${text.length}`)
}
// 4b. fast tool with progressToken must stream SSE and carry progress
{
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'reporting', arguments: {}, _meta: { progressToken: 'tok' } } }),
  })
  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  check(
    'progressToken forces SSE with progress',
    ct.includes('text/event-stream') && text.includes('notifications/progress') && text.includes('milestone') && text.includes('reported'),
    `ct=${ct}`,
  )
}
// 5. notification -> 202
{
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  check('notification returns 202', res.status === 202, `status=${res.status}`)
}
// 6. parse error -> JSON-RPC parse error
{
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: '{oops',
  })
  const body = await res.json()
  check('parse error reported', body.error?.code === -32700, JSON.stringify(body))
}
// 7. legacy SSE: endpoint event + reply over stream
{
  const controller = new AbortController()
  const res = await fetch(`${BASE}/sse`, { headers: { authorization: 'Bearer secret' }, signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const readUntil = async (needle) => {
    while (!buf.includes(needle)) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
    return buf
  }
  await readUntil('event: endpoint')
  const endpoint = buf.split('event: endpoint\ndata: ')[1].split('\n')[0]
  check('legacy endpoint event', endpoint.startsWith('/message?sessionId='), endpoint)
  await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fast', arguments: {} } }),
  })
  await readUntil('"id":9')
  check('legacy reply over SSE', buf.includes('quick'), '')
  controller.abort()
}
// 8. GET /mcp -> 405
{
  const res = await fetch(`${BASE}/mcp`, { headers: { authorization: 'Bearer secret' } })
  check('GET /mcp is 405', res.status === 405, `status=${res.status}`)
}

server.close()
const failed = results.filter(([, ok]) => !ok).length
console.log(failed === 0 ? 'ALL TRANSPORT TESTS PASS' : `${failed} TRANSPORT TESTS FAILED`)
process.exit(failed === 0 ? 0 : 1)

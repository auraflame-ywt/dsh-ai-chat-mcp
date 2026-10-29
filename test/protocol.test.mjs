/** Standalone MCP protocol tests (mock chat driver, no DSH runtime). */
import { createMcpServer } from '../lib/mcp-protocol.js'
import { buildTools, buildResources } from '../lib/tools.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}

const chat = {
  createSession: async (r) => ({ sessionId: 's-1', agentPreset: 'default', cwd: r.cwd ?? null, title: r.title ?? null }),
  promptAndWait: async (r, onProgress) => {
    onProgress?.('prompt accepted, waiting for the turn to settle')
    onProgress?.('agent started turn 3')
    onProgress?.('tool bash')
    onProgress?.('assistant output received')
    return { sessionId: r.sessionId, requestId: 'r-1', turn: 3, status: 'completed', answer: '答案', timedOut: false, error: null, usage: null, tools: [{ name: 'bash', status: 'ok' }], elapsedMs: 10 }
  },
  listSessions: async () => ({ items: [{ sessionId: 's-1', title: '标题', updatedAt: 1793256724736, running: false, blank: false, agentAvailable: true, cwd: '/tmp', parentSessionId: null, origin: null }], total: 1 }),
  readTranscript: async (r) => ({ sessionId: r.sessionId, messages: [], messageCount: 0, truncated: false, toolCalls: [] }),
  searchSessions: async () => ({ items: [], hasMore: false }),
  cancelSession: async () => ({ sessionId: 's-1', accepted: true }),
  renameSession: async (r) => ({ sessionId: r.sessionId, title: r.title }),
  forkSession: async () => ({ sessionId: 's-2', sourceSessionId: 's-1' }),
  archiveSession: async (r) => ({ sessionId: r.sessionId, archivedSessionIds: [r.sessionId] }),
  unarchiveSession: async (r) => ({ sessionId: r.sessionId, unarchivedSessionIds: [r.sessionId] }),
  modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, providers: [], failures: [] }),
}

const mcp = createMcpServer({
  serverInfo: { name: 't', version: '0' },
  instructions: 'test',
  tools: buildTools(chat),
  resources: buildResources(chat),
  logger: console,
})

// 1. initialize advertises tools + resources
{
  const [reply] = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  check('initialize advertises resources', reply.result.capabilities.resources?.subscribe === false, JSON.stringify(reply.result.capabilities))
}
// 2. tool list includes the management tools
{
  const [reply] = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = reply.result.tools.map((t) => t.name)
  check('archive tools present', names.includes('dsh_session_archive') && names.includes('dsh_session_unarchive'), names.join(','))
}
// 3. progress notifications with milestones
{
  const notifications = []
  const [reply] = await mcp.handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsh_chat', arguments: { message: 'hi' }, _meta: { progressToken: 'tok-1' } } },
    { notify: (msg) => notifications.push(msg) },
  )
  const progress = notifications.filter((n) => n.method === 'notifications/progress')
  const messages = progress.map((n) => n.params.message)
  check('progress milestones delivered', progress.length === 4 && messages.includes('tool bash'), JSON.stringify(messages))
  check('progress token echoed', progress.every((n) => n.params.progressToken === 'tok-1'))
  check('progress counter monotonic', progress.every((n, i) => i === 0 || n.params.progress > progress[i - 1].params.progress))
  check('chat result still complete', reply.result.structuredContent.status === 'completed')
}
// 4. no progressToken -> no notifications
{
  const notifications = []
  await mcp.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_chat', arguments: { message: 'hi' } } }, { notify: (msg) => notifications.push(msg) })
  check('no progress without token', notifications.length === 0)
}
// 5. resources
{
  const [list] = await mcp.handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' })
  check('resources/list', list.result.resources[0]?.uri === 'dsh://session/s-1', JSON.stringify(list.result.resources))
  const [templates] = await mcp.handleMessage({ jsonrpc: '2.0', id: 6, method: 'resources/templates/list' })
  check('resources/templates/list', templates.result.resourceTemplates[0]?.uriTemplate === 'dsh://session/{sessionId}')
  const [read] = await mcp.handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'dsh://session/s-1' } })
  check('resources/read', read.result.contents[0]?.uri === 'dsh://session/s-1')
  const [bad] = await mcp.handleMessage({ jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'dsh://nope/x' } })
  check('resources/read rejects unknown uri', bad.error?.code === -32603, JSON.stringify(bad.error))
}
// 6. archive tool round trip
{
  const [reply] = await mcp.handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'dsh_session_archive', arguments: { sessionId: 's-1', stopActivity: true } } })
  check('archive tool works', reply.result.structuredContent.archivedSessionIds.length === 1 && reply.result.isError === undefined, JSON.stringify(reply.result.structuredContent))
}
// 7. handler error -> isError result
{
  const failing = createMcpServer({
    serverInfo: { name: 't', version: '0' },
    tools: [{ name: 'boom', title: 'Boom', description: 'd', inputSchema: { type: 'object', properties: {} }, handler: async () => { throw new Error('kaput') } }],
    logger: console,
  })
  const [reply] = await failing.handleMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'boom', arguments: {} } })
  check('handler error becomes isError result', reply.result.isError === true && reply.result.content[0].text.includes('kaput'))
}

const failed = results.filter(([, ok]) => !ok).length
console.log(failed === 0 ? 'ALL PROTOCOL TESTS PASS' : `${failed} PROTOCOL TESTS FAILED`)
process.exit(failed === 0 ? 0 : 1)

/**
 * The MCP tool surface exposed to external clients: session creation,
 * conversation turns, transcripts, search, cancellation, rename, fork and the
 * model catalog.
 *
 * Each handler returns `{ text, value }` — `text` is the model-facing summary
 * and `value` the structured payload — or throws, which the protocol layer
 * turns into an `isError` tool result.
 *
 * @module @liuxinye/dsh-ai-chat-mcp/tools
 */

const SESSION_ID_PROPERTY = { type: 'string', minLength: 1, description: 'Session id returned by dsh_session_create or dsh_session_list.' }

/** Build the tool descriptors for one chat driver. */
export function buildTools(chat) {
  return [
    {
      name: 'dsh_session_create',
      title: 'Create DSH session',
      description:
        'Create a new DeepSeek Harness conversation session. The session appears in the DSH UI session list and uses the user\'s normal agent, tools and skills. Optionally set a working directory, title, agent preset and model.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Absolute working directory for the session. Defaults to the Harness default.' },
          title: { type: 'string', description: 'Initial session title.' },
          agentPreset: { type: 'string', description: 'Agent preset id to run. Defaults to the configured default preset.' },
          provider: { type: 'string', description: 'Model provider id; requires model.' },
          model: { type: 'string', description: 'Model id; requires provider.' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort for the selected model.' },
          workspaceId: { type: 'string', description: 'Optional DSH workspace id to place the session in.' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const created = await chat.createSession(args)
        return { text: `Created session ${created.sessionId}`, value: created }
      },
    },
    {
      name: 'dsh_chat',
      title: 'Chat (one-shot conversation turn)',
      description:
        'Send one user message to DeepSeek Harness and wait for the assistant answer. When sessionId is omitted a new session is created first. The Harness agent may use its tools and skills before answering; the call returns when the turn settles.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', minLength: 1, description: 'User message text.' },
          sessionId: SESSION_ID_PROPERTY,
          cwd: { type: 'string', description: 'Working directory for a newly created session (ignored when sessionId is given).' },
          title: { type: 'string', description: 'Title for a newly created session.' },
          agentPreset: { type: 'string', description: 'Agent preset for a newly created session.' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue waits for the current turn; steer injects into the running turn. Defaults to queue.' },
          timeoutMs: { type: 'integer', minimum: 1000, description: 'Wait budget for this turn in milliseconds. Defaults to the server configuration.' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      async handler(args, meta) {
        if (typeof args.message !== 'string' || args.message.trim().length === 0) throw new Error('message must be a non-empty string')
        let sessionId = args.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          sessionId = (
            await chat.createSession({
              cwd: args.cwd,
              title: args.title,
              agentPreset: args.agentPreset,
            })
          ).sessionId
        }
        const result = await chat.promptAndWait(
          {
            sessionId,
            text: args.message,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            signal: meta?.signal,
          },
          meta?.reportProgress,
        )
        return chatTurnOutput(result)
      },
    },
    {
      name: 'dsh_session_prompt',
      title: 'Send message to session',
      description:
        'Send one user message to an existing DeepSeek Harness session and wait for the turn to settle. Use this for multi-turn conversations after dsh_session_create or dsh_chat.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_ID_PROPERTY,
          message: { type: 'string', minLength: 1, description: 'User message text.' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue waits for the current turn; steer injects into the running turn. Defaults to queue.' },
          timeoutMs: { type: 'integer', minimum: 1000, description: 'Wait budget for this turn in milliseconds.' },
        },
        required: ['sessionId', 'message'],
        additionalProperties: false,
      },
      async handler(args, meta) {
        if (typeof args.message !== 'string' || args.message.trim().length === 0) throw new Error('message must be a non-empty string')
        const result = await chat.promptAndWait(
          {
            sessionId: args.sessionId,
            text: args.message,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            signal: meta?.signal,
          },
          meta?.reportProgress,
        )
        return chatTurnOutput(result)
      },
    },
    {
      name: 'dsh_session_list',
      title: 'List DSH sessions',
      description:
        'List DeepSeek Harness conversation sessions newest-first, with titles, activity and running state. Archived sessions are hidden by default (they left the DSH UI lists); pass includeArchived to see them with their archived flag.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum rows to return. Defaults to 50.' },
          includeArchived: { type: 'boolean', description: 'Include archived sessions, flagged with archived=true. Defaults to false.' },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const value = await chat.listSessions(args)
        return { text: JSON.stringify(value, null, 2), value }
      },
    },
    {
      name: 'dsh_session_read',
      title: 'Read session transcript',
      description: 'Read the conversation transcript of one DeepSeek Harness session: user messages, assistant answers and turn boundaries, plus recent tool activity.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_ID_PROPERTY,
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum messages returned from the tail of the transcript. Defaults to 40.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      async handler(args) {
        const value = await chat.readTranscript(args)
        return { text: JSON.stringify(value, null, 2), value }
      },
    },
    {
      name: 'dsh_session_search',
      title: 'Search DSH sessions',
      description: 'Full-text search across DeepSeek Harness session history; returns matching sessions with snippets.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Search query.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async handler(args) {
        const value = await chat.searchSessions(args)
        return { text: JSON.stringify(value, null, 2), value }
      },
    },
    {
      name: 'dsh_session_cancel',
      title: 'Cancel running turn',
      description: 'Cancel the active turn of one session without dropping its queued messages.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_ID_PROPERTY },
        required: ['sessionId'],
        additionalProperties: false,
      },
      async handler(args) {
        const value = await chat.cancelSession(args)
        return { text: `Cancelled active turn of ${args.sessionId}`, value }
      },
    },
    {
      name: 'dsh_session_rename',
      title: 'Rename session',
      description: 'Set the title of one DeepSeek Harness session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_ID_PROPERTY,
          title: { type: 'string', minLength: 1, description: 'New session title.' },
        },
        required: ['sessionId', 'title'],
        additionalProperties: false,
      },
      async handler(args) {
        const value = await chat.renameSession(args)
        return { text: `Renamed session to "${value.title}"`, value }
      },
    },
    {
      name: 'dsh_session_fork',
      title: 'Fork session',
      description: 'Fork one DeepSeek Harness session into a new session, optionally at an exact event seq (default: the latest completed turn).',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_ID_PROPERTY,
          atSeq: { type: 'integer', minimum: 0, description: 'Inclusive event seq to fork at. Omitted selects the latest completed turn.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      async handler(args) {
        const value = await chat.forkSession(args)
        return { text: `Forked ${args.sessionId} into ${value.sessionId}`, value }
      },
    },
    {
      name: 'dsh_session_archive',
      title: 'Archive session',
      description:
        'Archive one DeepSeek Harness session: it leaves the DSH UI session lists but stays readable through dsh_session_read and restorable through dsh_session_unarchive. This is the supported way to remove a session (the Harness exposes no session deletion). Set stopActivity to also stop its running work. The result carries the full registry archive set in archivedSessionIds.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: SESSION_ID_PROPERTY,
          stopActivity: { type: 'boolean', description: 'Also stop running work owned by this session.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      async handler(args) {
        const value = await chat.archiveSession(args)
        return { text: `Archived ${args.sessionId} (${value.archivedSessionIds.length} sessions in the archive set)`, value }
      },
    },
    {
      name: 'dsh_session_unarchive',
      title: 'Unarchive session',
      description: 'Restore one archived DeepSeek Harness session to the workspace session list.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: SESSION_ID_PROPERTY },
        required: ['sessionId'],
        additionalProperties: false,
      },
      async handler(args) {
        const value = await chat.unarchiveSession(args)
        return { text: `Unarchived ${args.sessionId} (${value.archivedSessionIds.length} sessions remain archived)`, value }
      },
    },
    {
      name: 'dsh_model_catalog',
      title: 'List available models',
      description: 'List the model providers and models a DeepSeek Harness session can select, with the current default selection.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const value = await chat.modelCatalog()
        return { text: JSON.stringify(value, null, 2), value }
      },
    },
  ]
}

/** Shape one settled conversation turn into a tool result. */
function chatTurnOutput(result) {
  const lines = []
  if (result.answer.length > 0) lines.push(result.answer)
  else lines.push(`(no assistant text; turn status: ${result.status})`)
  if (result.status !== 'completed') lines.push(`\n[status: ${result.status}${result.timedOut ? ', timed out' : ''}${result.error ? `, error: ${result.error}` : ''}]`)
  return {
    text: lines.join('\n'),
    value: result,
    isError: result.status === 'error',
  }
}

/** The `dsh://session/<id>` resource provider exposed through MCP resources. */
export function buildResources(chat) {
  return {
    templates: [
      {
        uriTemplate: 'dsh://session/{sessionId}',
        name: 'DSH session transcript',
        description: 'The full conversation transcript of one DeepSeek Harness session as JSON.',
        mimeType: 'application/json',
      },
    ],
    async list() {
      const { items } = await chat.listSessions({ limit: 200 })
      return items.map((item) => ({
        uri: `dsh://session/${item.sessionId}`,
        name: item.title ?? item.sessionId,
        description: `DSH session${item.title ? ` "${item.title}"` : ''} — updated ${new Date(item.updatedAt).toISOString()}`,
        mimeType: 'application/json',
      }))
    },
    async read(uri) {
      const match = /^dsh:\/\/session\/(.+)$/.exec(uri)
      if (match === null) throw new Error(`unknown resource: ${uri}`)
      const transcript = await chat.readTranscript({ sessionId: match[1], limit: 200 })
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(transcript, null, 2) }],
      }
    },
  }
}

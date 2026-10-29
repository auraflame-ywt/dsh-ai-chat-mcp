/**
 * Conversation driver — maps "create a session / run a conversation turn"
 * semantics onto the Harness session services.
 *
 * Everything here runs in the Host process, so it calls the same services the
 * web client drives over Remote:
 *   - `ctx.sessionController` for create / prompt / list / search / cancel /
 *     rename / fork / model selection,
 *   - `ctx.sessionQuery` for cold transcript reads,
 *   - `ctx.sessions` / `ctx.agents` for live state and quiescence checks.
 *
 * Turn settlement follows the durable session log: the prompt carries a
 * `requestId` recorded as the durable user message's `rpcId`; the
 * `agent/inbox/claimed` event correlates that message to its turn; the
 * `turn/end` event for that turn is the authoritative completion. A quiescence
 * check (idle agent with an empty inbox) is the fallback when a turn marker is
 * missed, and a wall-clock timeout returns whatever partial answer exists.
 *
 * @module @liuxinye/dsh-ai-chat-mcp/chat
 */

import { randomUUID } from 'node:crypto'

/** Every durable `turn/end` reason kind, mapped to a stable chat status. */
const TURN_END_KINDS = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked'])

/** Extract concatenated text blocks from a message content block list. */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Best-effort human summary of an unknown error or LLM failure value. */
function describeError(error) {
  if (error === undefined || error === null) return null
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  const parts = []
  if (typeof error.message === 'string') parts.push(error.message)
  if (typeof error.code === 'string') parts.push(`code=${error.code}`)
  if (typeof error.reason === 'string') parts.push(error.reason)
  if (parts.length > 0) return parts.join(' ')
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Sum assistant usage across the attributed steps of one turn. */
function combineUsage(entries) {
  const usage = entries.map((entry) => entry.usage).filter((value) => value && typeof value === 'object')
  if (usage.length === 0) return null
  const last = usage[usage.length - 1]
  const outputTokens = usage.reduce((sum, value) => sum + (value.outputTokens ?? 0), 0)
  return {
    inputTokens: last.inputTokens ?? null,
    outputTokens,
    totalTokens: last.totalTokens ?? null,
    cacheReadTokens: last.cacheReadTokens ?? null,
    cacheWriteTokens: last.cacheWriteTokens ?? null,
    reasoningTokens: last.reasoningTokens ?? null,
  }
}

/**
 * Create the conversation driver and register its durable-event hooks on the
 * plugin context. The returned `dispose` unwinds the hooks.
 *
 * @param ctx - plugin Cordis context carrying the session services.
 * @param config - normalized plugin configuration.
 * @param logger - host logger.
 */
export function createChatDriver(ctx, config, logger) {
  /** @type {Set<object>} in-flight chat waits */
  const pending = new Set()

  const findRecord = (sessionId, predicate) => {
    for (const rec of pending) {
      if (rec.sessionId === sessionId && (predicate === undefined || predicate(rec))) return rec
    }
    return undefined
  }

  /** Attribute assistant text to one chat wait. */
  const consumeEvent = (sessionId, event) => {
    for (const rec of [...pending]) {
      if (rec.sessionId !== sessionId || rec.settled) continue
      const data = event.data
      if (event.type === 'user/message') {
        if (data?.source?.rpcId === rec.requestId && rec.messageId === undefined) {
          rec.messageId = data.id
          rec.acceptSeq = event.seq
        }
        continue
      }
      if (event.type === 'assistant/message') {
        rec.answers.push({
          turn: data.turn,
          step: data.step,
          seq: event.seq,
          text: textOf(data.message?.content),
          usage: data.usage ?? null,
          interrupted: data.interrupted === true,
        })
        rec.onProgress?.('assistant output received')
        continue
      }
      if (event.type === 'tool/call') {
        rec.tools.set(data.callId, { name: data.name, status: 'running', seq: event.seq })
        rec.onProgress?.(`tool ${data.name}`)
        continue
      }
      if (event.type === 'tool/result') {
        const callId = data.message?.toolCallId ?? data.callId
        const entry = rec.tools.get(callId)
        if (entry !== undefined) entry.status = data.error !== undefined || data.message?.isError === true ? 'error' : 'ok'
        continue
      }
      if (event.type === 'turn/end') {
        if (rec.turn !== undefined && data.turn === rec.turn) {
          rec.endReason = data.reason
          settle(rec)
        }
      }
    }
  }

  const onSessionEvent = (session, event) => {
    try {
      consumeEvent(session.id ?? session.header?.id, event)
    } catch (error) {
      logger.warn?.('ai-chat-mcp: session event hook failed: %s', describeError(error))
    }
  }

  const onInboxClaimed = ({ agent, message, turn }) => {
    try {
      const rpcId = message?.source?.rpcId
      if (rpcId === undefined) return
      const sessionId = agent.session.id
      const rec = findRecord(sessionId, (candidate) => candidate.requestId === rpcId)
      if (rec !== undefined) {
        rec.turn = turn
        if (rec.claimSeq === undefined) rec.claimSeq = agent.session.seq
        rec.onProgress?.(`agent started turn ${turn}`)
      }
    } catch (error) {
      logger.warn?.('ai-chat-mcp: inbox claim hook failed: %s', describeError(error))
    }
  }

  const onAgentError = ({ agent, turn, step, error }) => {
    try {
      const sessionId = agent.session.id
      const rec = findRecord(sessionId, (candidate) => candidate.turn === undefined || candidate.turn === turn)
      if (rec !== undefined && !rec.settled) {
        rec.agentError = { turn, step, error: describeError(error) }
        settle(rec)
      }
    } catch (error) {
      logger.warn?.('ai-chat-mcp: agent error hook failed: %s', describeError(error))
    }
  }

  const disposers = [
    ctx.on('session/event', onSessionEvent),
    ctx.on('agent/inbox/claimed', onInboxClaimed),
    ctx.on('agent/error', onAgentError),
  ]

  /** Resolve one wait with its collected answer. */
  function settle(rec) {
    if (rec.settled) return
    rec.settled = true
    pending.delete(rec)
    clearTimeout(rec.timer)
    rec.cleanup?.()
    const attributed = rec.answers.filter((entry) => {
      if (rec.turn !== undefined) return entry.turn === rec.turn
      if (rec.claimSeq !== undefined) return entry.seq > rec.claimSeq
      return rec.acceptSeq === undefined || entry.seq > rec.acceptSeq
    })
    const status = statusOf(rec)
    const tools = [...rec.tools.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((entry) => ({ name: entry.name, status: entry.status }))
    rec.resolve({
      sessionId: rec.sessionId,
      requestId: rec.requestId,
      turn: rec.turn ?? null,
      status,
      answer: attributed.map((entry) => entry.text).filter((text) => text.length > 0).join('\n\n'),
      timedOut: rec.timedOut,
      error:
        rec.agentError !== undefined
          ? rec.agentError.error
          : rec.endReason?.kind === 'error'
            ? describeError(rec.endReason.error)
            : null,
      usage: combineUsage(attributed),
      tools,
      elapsedMs: Date.now() - rec.startedAt,
    })
  }

  function statusOf(rec) {
    if (rec.endReason !== undefined && TURN_END_KINDS.has(rec.endReason.kind)) return rec.endReason.kind
    if (rec.timedOut) return 'timeout'
    if (rec.cancelled) return 'aborted'
    if (rec.agentError !== undefined) return 'error'
    return 'unknown'
  }

  /**
   * Fallback settlement: when no `turn/end` correlated to this prompt arrives,
   * settle once the owning agent is idle with a drained inbox. The inbox check
   * matters because several queued inputs can share one running interval and
   * `whenIdle()` alone can resolve before a queued follow-up runs.
   */
  function watchQuiescence(rec) {
    const attempt = async () => {
      for (let tries = 0; tries < 20 && !rec.settled; tries++) {
        const agent = ctx.agents.get(rec.sessionId)
        if (agent === undefined) {
          await delay(500)
          continue
        }
        while (!rec.settled) {
          await agent.whenIdle()
          if (rec.settled) return
          if (agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0) break
        }
        if (!rec.settled && agent.status === 'idle') settle(rec)
        return
      }
    }
    attempt().catch((error) => logger.warn?.('ai-chat-mcp: quiescence watch failed: %s', describeError(error)))
  }

  /** Abortable wall-clock wait. */
  function delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }

  /**
   * Create one conversation session through the same Remote surface the web
   * client uses, so the session appears in the Harness UI and workspace lists.
   *
   * @param request - optional cwd, title, agent preset and model selection.
   */
  async function createSession(request = {}) {
    const createRequest = {}
    if (typeof request.workspaceId === 'string' && request.workspaceId.length > 0) createRequest.workspaceId = request.workspaceId
    if (typeof request.cwd === 'string' && request.cwd.length > 0) createRequest.cwd = request.cwd
    if (typeof request.agentPreset === 'string' && request.agentPreset.length > 0) createRequest.agentPreset = request.agentPreset
    const created = await ctx.sessionController.create(createRequest)
    const sessionId = created.sessionId
    if (typeof request.title === 'string' && request.title.length > 0) {
      await ctx.sessionController.rename({ sessionId, title: request.title })
    }
    if (typeof request.provider === 'string' && typeof request.model === 'string') {
      const selection = { sessionId, provider: request.provider, model: request.model }
      if (typeof request.reasoningEffort === 'string') selection.reasoningEffort = request.reasoningEffort
      await ctx.sessionController.selectModel(selection)
    }
    return {
      sessionId,
      agentPreset: created.agentPreset ?? null,
      cwd: request.cwd ?? null,
      title: request.title ?? null,
    }
  }

  /**
   * Send one conversation turn and wait for its settlement.
   *
   * @param request - target session, message text, delivery mode and budget.
   * @param onProgress - optional milestone callback for MCP progress reports.
   * @returns the settled turn: answer text, status, usage and tool activity.
   */
  async function promptAndWait(request, onProgress) {
    const { sessionId, text, mode = 'queue', timeoutMs, signal } = request
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : config.defaultTimeoutMs
    const requestId = randomUUID()
    const startedAt = Date.now()
    let resolveResult
    const result = new Promise((resolve) => {
      resolveResult = resolve
    })
    /** @type {any} */
    const rec = {
      requestId,
      sessionId,
      startedAt,
      messageId: undefined,
      turn: undefined,
      acceptSeq: undefined,
      claimSeq: undefined,
      answers: [],
      tools: new Map(),
      endReason: undefined,
      agentError: undefined,
      timedOut: false,
      cancelled: false,
      settled: false,
      resolve: resolveResult,
      cleanup: undefined,
      timer: undefined,
      onProgress,
    }
    rec.timer = setTimeout(() => {
      rec.timedOut = true
      settle(rec)
    }, budget)
    rec.timer.unref?.()
    pending.add(rec)
    const onAbort = () => {
      rec.cancelled = true
      settle(rec)
      // The caller walked away from this turn: stop the active turn as well.
      try {
        ctx.sessionController.cancel({ sessionId })
      } catch (error) {
        logger.warn?.('ai-chat-mcp: cancel after abort failed: %s', describeError(error))
      }
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return result
      }
      signal.addEventListener('abort', onAbort, { once: true })
      rec.cleanup = () => signal.removeEventListener('abort', onAbort)
    }
    try {
      await ctx.sessionController.prompt(
        {
          requestId,
          sessionId,
          mode: mode === 'steer' ? 'steer' : 'queue',
          content: [{ type: 'text', text }],
        },
        signal ?? new AbortController().signal,
      )
    } catch (error) {
      rec.settled = true
      pending.delete(rec)
      clearTimeout(rec.timer)
      rec.cleanup?.()
      throw error
    }
    rec.acceptSeq = ctx.sessions.get(sessionId)?.seq ?? rec.acceptSeq
    onProgress?.('prompt accepted, waiting for the turn to settle')
    watchQuiescence(rec)
    return result
  }

  /**
   * List conversation sessions newest-first through the Remote list surface.
   * Archived sessions are excluded unless `includeArchived` is set; they leave
   * the DSH UI lists but stay readable and unarchivable.
   */
  async function listSessions(request = {}) {
    const limit = Number.isFinite(request.limit) && request.limit > 0 ? Math.min(request.limit, 200) : 50
    const archived = new Set((ctx.workspaceRegistry?.archivedSessionIds ?? []).map(String))
    const value = await ctx.sessionController.list({}, new AbortController().signal)
    const rows = (value.items ?? []).map((summary) => ({
      sessionId: summary.sessionId,
      title: summary.projections?.values?.title ?? null,
      updatedAt: summary.updatedAt,
      running: summary.running,
      blank: summary.blank,
      agentAvailable: summary.agentAvailable,
      archived: archived.has(String(summary.sessionId)),
      cwd: summary.cwd ?? null,
      parentSessionId: summary.parentSessionId ?? null,
      origin: summary.origin ?? null,
    }))
    const items = request.includeArchived === true ? rows : rows.filter((row) => !row.archived)
    return {
      items: items.slice(0, limit),
      total: items.length,
      archivedTotal: rows.filter((row) => row.archived).length,
    }
  }

  /** Read one transcript (live or cold) as a compact message list. */
  async function readTranscript(request = {}) {
    const { sessionId } = request
    const limit = Number.isFinite(request.limit) && request.limit > 0 ? Math.min(request.limit, 200) : 40
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    const messages = []
    const tools = []
    for (const event of snapshot.events ?? []) {
      const data = event.data
      if (event.type === 'user/message') {
        // Only authored prompts; runtime context and system reminders are
        // delivered as user-role messages but are not conversation turns.
        if (data?.source?.kind === 'user') {
          messages.push({ role: 'user', seq: event.seq, time: event.time, text: textOf(data.content) })
        }
      } else if (event.type === 'assistant/message') {
        messages.push({
          role: 'assistant',
          seq: event.seq,
          time: event.time,
          turn: data.turn,
          step: data.step,
          text: textOf(data.message?.content),
          interrupted: data.interrupted === true,
          usage: data.usage ?? null,
        })
      } else if (event.type === 'turn/end') {
        messages.push({ role: 'turn-end', seq: event.seq, time: event.time, turn: data.turn, reason: data.reason?.kind ?? 'unknown' })
      } else if (event.type === 'tool/call') {
        tools.push({ seq: event.seq, turn: data.turn, name: data.name, status: 'running' })
      } else if (event.type === 'tool/result') {
        const last = [...tools].reverse().find((entry) => entry.status === 'running')
        if (last !== undefined) last.status = data.error !== undefined || data.message?.isError === true ? 'error' : 'ok'
      }
    }
    return {
      sessionId,
      cwd: snapshot.session?.cwd ?? null,
      createdAt: snapshot.session?.createdAt ?? null,
      agentPreset: snapshot.session?.agentPreset ?? null,
      messageCount: messages.length,
      truncated: messages.length > limit,
      messages: messages.slice(-limit),
      toolCalls: tools.slice(-limit),
    }
  }

  /** Search session history through the Remote search surface. */
  async function searchSessions(request) {
    const query = String(request.query ?? '').trim()
    if (query.length === 0) throw new Error('query must be a non-empty string')
    const value = await ctx.sessionController.search({ query }, new AbortController().signal)
    return { items: value.items ?? [], hasMore: value.hasMore === true }
  }

  /** Cancel the active turn of one session without dropping its queue. */
  async function cancelSession(request) {
    const value = await ctx.sessionController.cancel({ sessionId: request.sessionId })
    return { sessionId: request.sessionId, accepted: value.accepted === true }
  }

  /** Rename one session (visible in the Harness session list). */
  async function renameSession(request) {
    const title = String(request.title ?? '').trim()
    if (title.length === 0) throw new Error('title must be a non-empty string')
    const value = await ctx.sessionController.rename({ sessionId: request.sessionId, title })
    return { sessionId: request.sessionId, title: value.title }
  }

  /** Fork one session at an optional event boundary. */
  async function forkSession(request) {
    const forkRequest = { sessionId: request.sessionId }
    if (Number.isFinite(request.atSeq)) forkRequest.atSeq = request.atSeq
    const value = await ctx.sessionController.fork(forkRequest)
    return { sessionId: value.sessionId, sourceSessionId: request.sessionId }
  }

  /**
   * Archive one session (the supported "remove from the list" operation; the
   * Host exposes no session deletion). The response's `archivedSessionIds` is
   * the whole registry-global archive set, matching the Host contract.
   */
  async function archiveSession(request) {
    const archiveRequest = { sessionId: request.sessionId }
    if (request.stopActivity === true) archiveRequest.stopActivity = true
    const value = await ctx.workspaceController.archiveSession(archiveRequest)
    return {
      requestedSessionId: request.sessionId,
      archived: true,
      archivedSessionIds: value.archivedSessionIds ?? [],
    }
  }

  /** Restore one archived session to the workspace lists. */
  async function unarchiveSession(request) {
    const value = await ctx.workspaceController.unarchiveSession({ sessionId: request.sessionId })
    return {
      requestedSessionId: request.sessionId,
      archived: false,
      archivedSessionIds: value.archivedSessionIds ?? [],
    }
  }

  /** The model catalog sessions may select from. */
  async function modelCatalog() {
    const catalog = await ctx.sessionController.modelCatalog()
    return {
      default: catalog.default ?? null,
      providers: (catalog.groups ?? []).map((group) => ({
        id: group.id,
        name: group.name,
        models: (group.models ?? []).map((model) => ({ id: model.id, name: model.name, reasoning: model.reasoning ?? null })),
      })),
      failures: (catalog.failures ?? []).map((failure) => ({ provider: failure.provider ?? null, message: describeError(failure) })),
    }
  }

  function dispose() {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        /* already unwound */
      }
    }
    for (const rec of [...pending]) settle(rec)
    pending.clear()
  }

  return {
    createSession,
    promptAndWait,
    listSessions,
    readTranscript,
    searchSessions,
    cancelSession,
    renameSession,
    forkSession,
    archiveSession,
    unarchiveSession,
    modelCatalog,
    dispose,
  }
}

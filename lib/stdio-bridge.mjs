#!/usr/bin/env node
/**
 * stdio ↔ HTTP bridge for the AI Chat MCP server.
 *
 * For MCP clients that only support the stdio transport (e.g. Claude Desktop
 * custom connectors, Claude Code, older Cursor versions): configure them to
 * spawn this script; it forwards every JSON-RPC message from stdin to the
 * Harness MCP endpoint and writes the replies back to stdout.
 *
 * Usage:
 *   node stdio-bridge.mjs --endpoint http://127.0.0.1:8391/mcp [--token <token>]
 *
 * Environment fallbacks: DSH_MCP_ENDPOINT, DSH_MCP_TOKEN.
 */

import { createInterface } from 'node:readline'

function parseArgs(argv) {
  const options = {
    endpoint: process.env.DSH_MCP_ENDPOINT ?? 'http://127.0.0.1:8391/mcp',
    token: process.env.DSH_MCP_TOKEN ?? '',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--endpoint' && argv[i + 1] !== undefined) options.endpoint = argv[++i]
    else if (arg === '--token' && argv[i + 1] !== undefined) options.token = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node stdio-bridge.mjs [--endpoint <url>] [--token <token>]\n')
      process.exit(0)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const endpoint = new URL(options.endpoint)

/** Send one JSON-RPC message and return every reply it produced. */
async function forward(message) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (options.token.length > 0) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(24 * 60 * 60 * 1000),
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (response.status === 202) return []
  if (contentType.includes('text/event-stream')) {
    const replies = []
    for await (const chunk of response.body) {
      const text = Buffer.from(chunk).toString('utf8')
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            replies.push(JSON.parse(line.slice(6)))
          } catch {
            /* partial frame: ignored */
          }
        }
      }
    }
    return replies
  }
  const body = await response.text()
  if (body.length === 0) return []
  const parsed = JSON.parse(body)
  return Array.isArray(parsed) ? parsed : [parsed]
}

let inflight = 0
let stdinClosed = false
const exitWhenDrained = () => {
  if (stdinClosed && inflight === 0) process.exit(0)
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`)
    return
  }
  inflight++
  forward(message)
    .then((replies) => {
      if (Array.isArray(message)) {
        if (replies.length > 0) process.stdout.write(`${JSON.stringify(replies)}\n`)
        return
      }
      for (const reply of replies) process.stdout.write(`${JSON.stringify(reply)}\n`)
    })
    .catch((error) => {
      const id = message?.id ?? null
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: `endpoint unreachable: ${error?.message ?? String(error)}` } })}\n`,
      )
    })
    .finally(() => {
      inflight--
      exitWhenDrained()
    })
})

process.stdin.on('end', () => {
  stdinClosed = true
  exitWhenDrained()
})

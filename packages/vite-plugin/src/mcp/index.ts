#!/usr/bin/env node
import path from 'node:path'
import readline from 'node:readline'
import { handleMessage, type ForgeBackend, type JsonRpcMessage, type WaitOutcome } from './protocol'
import { baseUrl, type ForgeEndpoint } from './url'
import { discoverEndpoint } from './discover'

const NOT_RUNNING_MESSAGE = 'The Forge dev server is not running — start your Vite dev server first.'

/** Client-side ceiling on one /wait long-poll. Must exceed the server's hold window
 * (WAIT_HOLD_MS = 20s in server/watchers.ts — kept as an independent constant here so the
 * mcp bundle stays decoupled from server code) with generous margin, while still bounded:
 * a dead socket must not park the agent's tool call forever. */
const WAIT_REQUEST_TIMEOUT_MS = 35_000

/** Distinguishes "reached a server, but it rejected the request" (stale/mismatched dev server —
 * e.g. it restarted, or the plugin and this bin are different versions) from NOT_RUNNING_MESSAGE,
 * which means the connection itself never succeeded (nothing listening at all). */
function rejectedMessage(status: number): string {
  return `The Forge server rejected the request (HTTP ${status}) — the dev server may have restarted or the plugin/bin versions may differ; restart your Vite dev server and agent session.`
}

function readEndpoint(): ForgeEndpoint | null {
  return discoverEndpoint(path.join(process.cwd(), '.the-forge'))
}

function secretHeaders(endpoint: ForgeEndpoint): Record<string, string> {
  return endpoint.secret ? { 'X-Forge-Secret': endpoint.secret } : {}
}

function makeBackend(): ForgeBackend {
  return {
    async pull() {
      const endpoint = readEndpoint()
      if (!endpoint) throw new Error(NOT_RUNNING_MESSAGE)
      let res: Response
      try {
        res = await fetch(`${baseUrl(endpoint)}/__the-forge/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...secretHeaders(endpoint) },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new Error(NOT_RUNNING_MESSAGE)
      }
      if (!res.ok) throw new Error(rejectedMessage(res.status))
      const data = (await res.json()) as { items: Array<{ id: string; markdown: string; createdAt: string }> }
      return data.items
    },
    async mark(ids, status, note) {
      const endpoint = readEndpoint()
      if (!endpoint) throw new Error(NOT_RUNNING_MESSAGE)
      let res: Response
      try {
        res = await fetch(`${baseUrl(endpoint)}/__the-forge/mark`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...secretHeaders(endpoint) },
          body: JSON.stringify({ ids, status, note }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new Error(NOT_RUNNING_MESSAGE)
      }
      if (!res.ok) throw new Error(rejectedMessage(res.status))
      const data = (await res.json()) as { marked: string[] }
      return data.marked
    },
    /** The watch loop's long-poll. Never throws — every failure mode maps to a WaitOutcome
     * whose canned text (protocol.ts) tells the agent exactly whether to retry, re-arm, or
     * stop; a thrown error would surface as a bare isError result with no loop guidance. */
    async wait(): Promise<WaitOutcome> {
      const endpoint = readEndpoint()
      if (!endpoint) return { kind: 'stop', reason: 'no-server' }
      let res: Response
      try {
        res = await fetch(`${baseUrl(endpoint)}/__the-forge/wait`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...secretHeaders(endpoint) },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(WAIT_REQUEST_TIMEOUT_MS),
        })
      } catch {
        return { kind: 'unreachable' }
      }
      if (!res.ok) return { kind: 'unreachable' }
      let data: { stop?: boolean; reason?: string; items?: Array<{ id: string; markdown: string; createdAt: string }> }
      try {
        data = (await res.json()) as typeof data
      } catch {
        return { kind: 'unreachable' }
      }
      if (data.stop === true) {
        // Unknown reason values (a newer server?) degrade to 'idle' — its text is the safe
        // one: watching paused, /forge-watch to resume.
        return { kind: 'stop', reason: data.reason === 'replaced' ? 'replaced' : 'idle' }
      }
      const items = Array.isArray(data.items) ? data.items : []
      if (items.length > 0) return { kind: 'items', items }
      return { kind: 'empty' }
    },
  }
}

const backend = makeBackend()

const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line: string) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg: JsonRpcMessage
  try {
    msg = JSON.parse(trimmed) as JsonRpcMessage
  } catch {
    // Parse failure: no recoverable id, so skip the line per spec.
    return
  }

  handleMessage(msg, backend)
    .then((response) => {
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    })
    .catch(() => {
      // handleMessage should never throw (tool errors become isError results),
      // but guard the stdio loop regardless.
    })
})

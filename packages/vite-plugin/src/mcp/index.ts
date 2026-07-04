#!/usr/bin/env node
import path from 'node:path'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { handleMessage, type ForgeBackend, type JsonRpcMessage, type WaitOutcome } from './protocol'
import { baseUrl, type ForgeEndpoint } from './url'
import { discoverEndpoint } from './discover'

const NOT_RUNNING_MESSAGE = 'The Forge dev server is not running — start your Vite dev server first.'

/** Client-side ceiling on one /wait long-poll. Must exceed the server's hold window
 * (WAIT_HOLD_MS = 20s in server/watchers.ts — kept as an independent constant here so the
 * mcp bundle stays decoupled from server code) with generous margin, while still bounded:
 * a dead socket must not park the agent's tool call forever. */
const WAIT_REQUEST_TIMEOUT_MS = 35_000

/** This bin process's watcher identity, sent on every /wait as X-Forge-Watcher. Lets the
 * WatcherHub absorb retries from a session it already told to stop ('replaced') instead
 * of letting two watch sessions ping-pong the single slot — the no-ping-pong guarantee is
 * server-enforced via this token, not just the canned stop text. Per-process is exactly
 * the right scope: one agent session = one bin process. */
const WATCHER_TOKEN = randomUUID()

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

/** The one place a request to the dev server is actually made: endpoint discovery →
 * secret header → POST → response body. Callers keep only their genuinely distinct part —
 * pull/mark throw user-facing messages on failure, wait maps failures to WaitOutcome
 * kinds — instead of each hand-rolling this scaffold. */
async function post(
  pathname: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<{ ok: true; data: unknown } | { ok: false; reason: 'no-server' | 'unreachable' | number }> {
  const endpoint = readEndpoint()
  if (!endpoint) return { ok: false, reason: 'no-server' }
  let res: Response
  try {
    res = await fetch(`${baseUrl(endpoint)}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...secretHeaders(endpoint), ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (!res.ok) return { ok: false, reason: res.status }
  try {
    return { ok: true, data: await res.json() }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

/** Failure mapping shared by pull and mark: connection-level failures read as "not
 * running", an HTTP rejection carries the status so the agent can report it. */
function throwPostFailure(reason: 'no-server' | 'unreachable' | number): never {
  throw new Error(typeof reason === 'number' ? rejectedMessage(reason) : NOT_RUNNING_MESSAGE)
}

function makeBackend(): ForgeBackend {
  return {
    async pull() {
      const result = await post('/__the-forge/pull', {}, 10_000)
      if (!result.ok) throwPostFailure(result.reason)
      const data = result.data as { items: Array<{ id: string; markdown: string; createdAt: string }> }
      return data.items
    },
    async mark(ids, status, note) {
      const result = await post('/__the-forge/mark', { ids, status, note }, 10_000)
      if (!result.ok) throwPostFailure(result.reason)
      const data = result.data as { marked: string[] }
      return data.marked
    },
    /** The watch loop's long-poll. Never throws — every failure mode maps to a WaitOutcome
     * whose canned text (protocol.ts) tells the agent exactly whether to retry, re-arm, or
     * stop; a thrown error would surface as a bare isError result with no loop guidance. */
    async wait(): Promise<WaitOutcome> {
      const result = await post('/__the-forge/wait', {}, WAIT_REQUEST_TIMEOUT_MS, {
        'X-Forge-Watcher': WATCHER_TOKEN,
      })
      if (!result.ok) {
        return result.reason === 'no-server' ? { kind: 'stop', reason: 'no-server' } : { kind: 'unreachable' }
      }
      const data = result.data as {
        stop?: boolean
        reason?: string
        items?: Array<{ id: string; markdown: string; createdAt: string }>
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

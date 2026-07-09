#!/usr/bin/env node
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { handleMessage, type ForgeBackend, type JsonRpcMessage, type WaitOutcome, type ApprovalDecision } from './protocol'
import { baseUrl, type ForgeEndpoint } from './url'
import { discoverEndpointFrom } from './discover'

const NOT_RUNNING_MESSAGE = 'The Forge dev server is not running — start your Vite dev server first.'

/** Client-side ceiling on one /wait long-poll. Must exceed the server's hold window
 * (WAIT_HOLD_MS = 20s in server/watchers.ts — kept as an independent constant here so the
 * mcp bundle stays decoupled from server code) with generous margin, while still bounded:
 * a dead socket must not park the agent's tool call forever. */
const WAIT_REQUEST_TIMEOUT_MS = 35_000

/** Client-side ceiling on one approval round-trip. A human is deciding, so this must be
 * much longer than the wait loop's hold. Exceeds the server's APPROVAL_HOLD_MS (110s in
 * server/session/approvals.ts — kept as an independent constant here so the mcp bundle
 * stays decoupled from server code) with margin. */
const APPROVAL_REQUEST_TIMEOUT_MS = 120_000

/** Fail-closed default for the approve backend: every transport failure and every
 * unrecognized response shape resolves to this — the CLI-facing message text lives in
 * protocol.ts's constant table, keyed by this reason code. */
const APPROVAL_UNREACHABLE_DENY: ApprovalDecision = { behavior: 'deny', reason: 'unreachable' }

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
  // Walk-up discovery: the session no longer has to run exactly at the git root — any
  // subdirectory of the project finds the endpoint (see discoverEndpointFrom).
  return discoverEndpointFrom(process.cwd())
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
    /** Permission gate for the embedded Claude session. Never throws — any transport failure
     * or malformed response resolves to deny so the CLI is never left hanging. The CLI
     * parses the returned ApprovalDecision JSON; a thrown error here would surface as an
     * isError MCP result, bypassing the CLI's decision parser. */
    async approve(toolName: string, input: unknown): Promise<ApprovalDecision> {
      // Extract a human-readable detail string from the tool input, truncated to 200 chars.
      const rawDetail =
        (typeof (input as Record<string, unknown>)?.command === 'string'
          ? (input as Record<string, unknown>).command
          : typeof (input as Record<string, unknown>)?.file_path === 'string'
            ? (input as Record<string, unknown>).file_path
            : '') as string
      const detail = rawDetail.slice(0, 200)
      const result = await post('/__the-forge/approval', { toolName, detail }, APPROVAL_REQUEST_TIMEOUT_MS)
      if (!result.ok) return APPROVAL_UNREACHABLE_DENY
      // Expected body: {behavior:'allow'} | {behavior:'deny', reason:'user'|'timeout'}.
      // The reason is a code, never text — protocol.ts maps it to its constant messages.
      // Anything unrecognized degrades to the fail-closed 'unreachable' deny.
      const data = result.data as { behavior?: unknown; reason?: unknown }
      if (data.behavior === 'allow') return { behavior: 'allow' }
      if (data.behavior === 'deny' && (data.reason === 'user' || data.reason === 'timeout')) {
        return { behavior: 'deny', reason: data.reason }
      }
      return APPROVAL_UNREACHABLE_DENY
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
        const reason = data.reason === 'replaced' || data.reason === 'unlinked' ? data.reason : 'idle'
        return { kind: 'stop', reason }
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

import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Queue } from './queue'
import { dispatch as realDispatch, augmentDispatchMarkdown, type DispatchOpts, type DispatchResult } from './dispatch'
import { WatcherHub } from './watchers'
import { ensureDevtoolsUuid } from './setup'
import type { ForgeSessionHandles } from './runtime'

/** Chrome DevTools' Automatic Workspace Folders well-known path (task A5) — served by
 * createForgeMiddleware below and proxied to it by src/next/index.ts's rewrites merge.
 * Exported so next/index.ts imports this constant rather than duplicating the string. */
export const DEVTOOLS_JSON_PATH = '/.well-known/appspecific/com.chrome.devtools.json'

const MAX_BODY = 1024 * 1024

const KNOWN_AGENTS = new Set<DispatchOpts['agent']>(['claude-code', 'cursor', 'codex'])

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    req.on('data', (c: Buffer) => {
      if (settled) return
      size += c.length
      if (size > MAX_BODY) {
        settled = true
        reject(new Error('body too large'))
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('malformed JSON'))
      }
    })
    req.on('error', (e) => {
      if (settled) return
      settled = true
      reject(e)
    })
  })
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

/** Extracts the hostname from a Host header value, stripping any port and IPv6 brackets. */
function hostnameOf(host: string): string {
  let h = host.trim()
  if (h.startsWith('[')) {
    // IPv6 literal, e.g. "[::1]:5173" or "[::1]"
    const close = h.indexOf(']')
    return close === -1 ? h : h.slice(1, close)
  }
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

/** DNS-rebinding defense: is this request's Host header one we trust? Exported because the
 * Next sidecar's client.js route (src/next/sidecar.ts) is the one route that isn't wrapped by
 * createForgeMiddleware below and must apply the same gate itself before serving the bundle —
 * it embeds the per-start secret in its bootstrap line. */
export function isAllowedHost(host: string | undefined, allowedHosts: string[]): boolean {
  if (!host) return false
  const hostname = hostnameOf(host)
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '127.0.0.1' || hostname === '::1') return true
  return allowedHosts.includes(hostname)
}

/** The single DNS-rebinding host gate, shared by the devtools well-known route and the main
 * /__the-forge/ path below. Always checks the real Host header via isAllowedHost. Next's
 * rewrites() proxy rewrites Host to the sidecar's own loopback address (127.0.0.1:<port>)
 * before this middleware ever sees the request — the browser's real page origin survives only
 * in X-Forwarded-Host. On the main path that rewrite is handled by the separate Origin-vs-
 * effective-host check further down (it already prefers X-Forwarded-Host when present), so this
 * helper leaves opts.checkForwarded false there. The devtools route has no secret to fall back
 * on — its response body is an absolute filesystem path, and Chrome DevTools can't send a
 * custom header for the Origin check to key off — so it opts into checkForwarded: true here,
 * additionally requiring X-Forwarded-Host (when present) to pass the same allowlist as Host.
 * That's the deliberate asymmetry between the two call sites, not an inconsistency. Returns
 * true (having already sent the 403) when the request should be rejected; the caller returns
 * immediately in that case. */
function rejectDisallowedHost(
  req: IncomingMessage,
  res: ServerResponse,
  allowedHosts: string[],
  opts: { checkForwarded: boolean }
): boolean {
  if (!isAllowedHost(req.headers.host, allowedHosts)) {
    send(res, 403, { error: 'host not allowed' })
    return true
  }
  if (opts.checkForwarded) {
    const forwardedHost = req.headers['x-forwarded-host']
    if (typeof forwardedHost === 'string' && !isAllowedHost(forwardedHost, allowedHosts)) {
      send(res, 403, { error: 'host not allowed' })
      return true
    }
  }
  return false
}

// Mutating endpoints that require the shared secret when one is configured. GET /status is
// deliberately excluded: it's read-only and only exposes ids/statuses, which are non-sensitive.
// GET /session/events is also excluded here (it's not a POST) but is secret-gated explicitly
// in its own handler — see why-comment there.
const MUTATING_PATHS = new Set([
  '/__the-forge/queue',
  '/__the-forge/pull',
  '/__the-forge/mark',
  '/__the-forge/dispatch',
  '/__the-forge/wait',
  '/__the-forge/unwatch',
  '/__the-forge/session/interrupt',
  '/__the-forge/approval',
  '/__the-forge/approval/decide',
])

export interface DispatchConfig {
  agent: DispatchOpts['agent']
  channelsFlag: boolean
  /** The resolved project root (see resolveProjectRoot in server/setup.ts) — passed through as
   * DispatchOpts.cwd so the experimental Channels rung's marker-file check
   * (`<cwd>/.the-forge/channel-<pid>`) looks in the SAME `.the-forge` directory the Queue and
   * endpoint file actually live in, rather than defaulting to process.cwd(). Optional: omitted
   * in most existing tests, which fall back to dispatch.ts's own process.cwd() default. */
  cwd?: string
  /** Injectable for tests — defaults to the real dispatch ladder (dispatch.ts). Never invokes
   * a real tmux/osascript/open in tests; production callers omit this and get the real thing. */
  dispatchFn?: (opts: DispatchOpts) => Promise<DispatchResult>
}

export function createForgeMiddleware(
  queue: Queue,
  allowedHosts: string[] = [],
  secret?: string,
  dispatchConfig: DispatchConfig = { agent: 'claude-code', channelsFlag: false },
  hub?: WatcherHub,
  // Optional so existing callers/tests stand unchanged — same pattern as the optional hub
  // param above. The plugin (src/vite.ts / src/next/sidecar.ts) passes one explicitly once
  // Task 5 wires it; until then all callers that omit it get 404s on the new session paths.
  session?: ForgeSessionHandles
) {
  // Optional param so existing callers/tests stand unchanged; the plugin (src/index.ts)
  // constructs and passes one explicitly so the wiring is visible at the composition root.
  const watcherHub =
    hub ??
    new WatcherHub({
      claim: () => queue.pull(),
      applying: () => queue.hasFreshClaims(),
    })
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const [pathname, query = ''] = (req.url ?? '').split('?')

    // Chrome DevTools' Automatic Workspace Folders probe — served BEFORE the /__the-forge/
    // prefix gate below because its path lives outside that prefix. Only handled when
    // dispatchConfig.cwd is set (the resolved project root): legacy tests/callers that never
    // pass a cwd get this route falling through to next() unchanged, same as before this route
    // existed.
    if (pathname === DEVTOOLS_JSON_PATH && dispatchConfig.cwd !== undefined) {
      // checkForwarded: true — see rejectDisallowedHost's doc comment for why this route
      // additionally allowlists X-Forwarded-Host.
      if (rejectDisallowedHost(req, res, allowedHosts, { checkForwarded: true })) return
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' })
      const forgeDir = path.join(dispatchConfig.cwd, '.the-forge')
      return send(res, 200, {
        workspace: { root: dispatchConfig.cwd, uuid: ensureDevtoolsUuid(forgeDir) },
      })
    }

    if (!pathname.startsWith('/__the-forge/')) return next()

    // checkForwarded: false — X-Forwarded-Host is instead consulted by the Origin-vs-
    // effective-host check just below, which is a separate, non-consolidated check.
    if (rejectDisallowedHost(req, res, allowedHosts, { checkForwarded: false })) return

    const origin = req.headers.origin
    if (typeof origin === 'string') {
      let originHost: string | null = null
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = null
      }
      // Next's rewrites() proxy rewrites Host to the sidecar's own loopback address
      // (127.0.0.1:<port>) before this middleware ever sees the request, while the browser's
      // real page origin only survives in X-Forwarded-Host (confirmed live in
      // docs/research/2026-07-04-next-spike-findings.md and by the next-demo E2E, N8a — every
      // real browser POST was 403ing here). Comparing Origin against the rewritten Host would
      // reject every legitimate request on the Next adapter path, so prefer X-Forwarded-Host
      // when present and fall back to Host for the direct-connection Vite path (which never
      // sets X-Forwarded-Host). This does not weaken the DNS-rebinding defense above: that
      // defense lives entirely in isAllowedHost's read of the real Host header, which an
      // attacker cannot spoof via X-Forwarded-Host on a direct (non-proxied) connection.
      const forwardedHost = req.headers['x-forwarded-host']
      const effectiveHost = typeof forwardedHost === 'string' ? forwardedHost : req.headers.host
      if (!effectiveHost || originHost !== effectiveHost) {
        return send(res, 403, { error: 'cross-origin request rejected' })
      }
    }

    // Belt-and-braces against cross-origin/DNS-rebinding bypasses of the Origin/Host checks
    // above — same-origin page scripts are the user's own app and not the adversary, so this
    // only matters when a request slips past the Host/Origin gate. Enforced only when a secret
    // was actually configured (older/degraded setups without one keep working unauthenticated).
    //
    // Threat model scope: this guards against a browser-borne cross-origin attacker. It does
    // NOT defend against another local user on a shared/multi-user machine — this endpoint file
    // (and the queue dir it manages) is written with mode 644, readable by any local account, so
    // a co-resident local user can already read the secret and the queue contents directly from
    // disk. Local-multi-user hardening (e.g. tighter file perms, per-user dirs) is out of scope
    // for this single-user dev tool.
    if (secret && req.method === 'POST' && MUTATING_PATHS.has(pathname)) {
      const provided = req.headers['x-forge-secret']
      if (provided !== secret) {
        return send(res, 403, { error: 'missing or invalid X-Forge-Secret' })
      }
    }

    // GET /session/events — secret-gated despite being a GET. Events carry file paths and
    // command text, making them more sensitive than /status (which only exposes ids/statuses).
    // Deliberate asymmetry with /status's open GET: the browser client uses fetch() rather than
    // EventSource precisely so it can attach the X-Forge-Secret header on this request.
    // MUTATING_PATHS covers POST-only; this GET needs its own explicit gate.
    if (req.method === 'GET' && pathname === '/__the-forge/session/events') {
      if (secret) {
        const provided = req.headers['x-forge-secret']
        if (provided !== secret) {
          return send(res, 403, { error: 'missing or invalid X-Forge-Secret' })
        }
      }
      if (!session) return send(res, 404, { error: 'embedded session unavailable' })

      const sinceParam = new URLSearchParams(query).get('since')
      const since = typeof sinceParam === 'string' && /^\d+$/.test(sinceParam) ? parseInt(sinceParam, 10) : 0

      res.statusCode = 200
      res.setHeader('Content-Type', 'application/x-ndjson')
      // Flush headers immediately so the client sees 200 + Content-Type before the first line.
      ;(res as ServerResponse & { flushHeaders?: () => void }).flushHeaders?.()

      // Replay buffered feed events
      for (const fe of session.manager.eventsSince(since)) {
        res.write(JSON.stringify({ type: 'feed', seq: fe.seq, at: fe.at, event: fe.event }) + '\n')
      }
      // Replay pending approvals — a late-connecting browser doesn't miss outstanding requests
      for (const pa of session.approvals.pending()) {
        res.write(JSON.stringify({ type: 'approval', id: pa.id, toolName: pa.toolName, detail: pa.detail }) + '\n')
      }

      // Subscribe for live events; unsubscribe on connection close so nothing leaks
      const unsubManager = session.manager.subscribe((fe) => {
        res.write(JSON.stringify({ type: 'feed', seq: fe.seq, at: fe.at, event: fe.event }) + '\n')
      })
      const unsubApprovals = session.onApproval((e) => {
        if (e.kind === 'approval-request') {
          res.write(JSON.stringify({ type: 'approval', id: e.id, toolName: e.toolName, detail: e.detail }) + '\n')
        } else {
          res.write(JSON.stringify({ type: 'approval-resolved', id: e.id, allow: e.allow }) + '\n')
        }
      })

      res.on('close', () => {
        unsubManager()
        unsubApprovals()
      })
      return
    }

    if (pathname === '/__the-forge/queue') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      readBody(req)
        .then((body) => {
          const { request, markdown } = body as { request?: unknown; markdown?: string }
          if (typeof markdown !== 'string') return send(res, 400, { error: 'markdown required' })
          const item = queue.add(request ?? null, markdown)
          send(res, 200, { id: item.id })
          // After the 200 — delivery to a parked watcher must never delay or fail the Send.
          watcherHub.notify()
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (pathname === '/__the-forge/pull') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      send(res, 200, { items: queue.pull() })
      return
    }

    if (pathname === '/__the-forge/mark') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      readBody(req)
        .then((body) => {
          const { ids, status, note } = body as { ids?: string[]; status?: string; note?: string }
          if (!Array.isArray(ids) || (status !== 'applied' && status !== 'failed')) {
            return send(res, 400, { error: 'ids + status(applied|failed) required' })
          }
          send(res, 200, { marked: queue.mark(ids, status, note).map((i) => i.id) })
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (pathname === '/__the-forge/wait') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      // Long-poll: the response is held open until a change request lands, the hold window
      // expires (agent re-arms), or the hub tells this watcher to stop (idle / replaced).
      // The request body is irrelevant (no parameters) and deliberately not read — parking
      // must not depend on body parsing. The optional X-Forge-Watcher header carries the
      // bin's per-process identity for the hub's mechanical no-ping-pong guarantee.
      const watcherToken = req.headers['x-forge-watcher']
      const { promise, cancel } = watcherHub.wait(typeof watcherToken === 'string' ? watcherToken : undefined)
      // The bin vanished mid-hold (agent killed, session closed): free the slot so a
      // re-armed watcher isn't blocked by a ghost. No-op after normal completion.
      res.on('close', cancel)
      promise.then((waitResponse) => send(res, 200, waitResponse))
      return
    }

    if (pathname === '/__the-forge/unwatch') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      // The strip's ✕ (2026-07-05 watcher-unlink spec). No body — the hub knows its own
      // watcher. Returns the post-unlink state so the client can render without re-polling.
      watcherHub.unlink()
      return send(res, 200, { watcher: watcherHub.state() })
    }

    if (pathname === '/__the-forge/dispatch') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      readBody(req)
        .then((body) => {
          const { agent, markdown } = (body ?? {}) as { agent?: DispatchOpts['agent']; markdown?: string }
          if (agent !== undefined && !KNOWN_AGENTS.has(agent)) {
            return send(res, 400, { error: 'unknown agent' })
          }
          // Linked-session short-circuit, BEFORE the pending-item check and the ladder: a
          // live watcher already received this Send through its parked /wait (queue →
          // notify), or will claim it within one hold window — so by the time /dispatch
          // runs there is often nothing pending, and "nothing pending" + live watcher
          // means DELIVERED, not manual. The keystroke ladder must not also fire (it
          // would type /forge-design into a terminal for a request the watcher owns).
          if (watcherHub.isLive()) {
            return send(res, 200, { rung: 'watcher', detail: 'delivered to your linked session' })
          }
          // Newest pending item by createdAt — the one the Send button that triggered this
          // POST almost certainly just queued. Sorted explicitly rather than relying on
          // queue.list()'s on-disk ordering, which is an implementation detail of Queue.
          const pending = queue
            .list()
            .filter((i) => i.status === 'pending')
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
          // Nothing to dispatch: no pending queue item, and the caller didn't post a markdown
          // override either — invoking the ladder here would type /forge-design into the user's
          // agent session for NO actual change request. Short-circuit straight to manual without
          // ever touching tmux/AppleScript/deeplink.
          if (!pending && markdown === undefined) {
            return send(res, 200, { rung: 'manual', detail: 'nothing pending' })
          }
          const resolvedAgent = agent ?? dispatchConfig.agent
          // A caller-posted markdown override is passed through verbatim (there is no queue
          // item to mark); a queue-sourced markdown gets the agent-specific augmentation —
          // see augmentDispatchMarkdown in dispatch.ts for why (Cursor loop closure).
          const dispatchMarkdown =
            markdown !== undefined
              ? markdown
              : augmentDispatchMarkdown(resolvedAgent, pending?.markdown ?? '', pending?.id ?? null)
          const opts: DispatchOpts = {
            agent: resolvedAgent,
            channelsFlag: dispatchConfig.channelsFlag,
            markdown: dispatchMarkdown,
            ...(dispatchConfig.cwd !== undefined ? { cwd: dispatchConfig.cwd } : {}),
          }
          const run = dispatchConfig.dispatchFn ?? realDispatch
          return run(opts).then((result) => send(res, 200, result))
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (pathname === '/__the-forge/session/interrupt') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      if (!session) return send(res, 404, { error: 'embedded session unavailable' })
      session.manager.interrupt()
      return send(res, 200, { state: session.manager.state() })
    }

    if (pathname === '/__the-forge/approval') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      if (!session) return send(res, 404, { error: 'embedded session unavailable' })
      readBody(req)
        .then((body) => {
          const { toolName, detail } = (body ?? {}) as { toolName?: unknown; detail?: unknown }
          const tn = typeof toolName === 'string' ? toolName : ''
          const dt = typeof detail === 'string' ? detail : ''
          const { promise } = session.approvals.request(tn, dt)
          // Long-poll: hold response open until decided or the registry's hold timer expires.
          // No res.on('close') → decide wiring: the registry's own APPROVAL_HOLD_MS timer is
          // the authoritative cleanup — same trust model as /wait's cancel (the MCP bin is not
          // trusted to report its own disappearance; expiry handles abandonment).
          promise.then((decision) => send(res, 200, decision))
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (pathname === '/__the-forge/approval/decide') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      if (!session) return send(res, 404, { error: 'embedded session unavailable' })
      readBody(req)
        .then((body) => {
          const { id, allow } = (body ?? {}) as { id?: unknown; allow?: unknown }
          if (typeof id !== 'string' || typeof allow !== 'boolean') {
            return send(res, 400, { error: 'id (string) and allow (boolean) required' })
          }
          send(res, 200, { ok: session.approvals.decide(id, allow) })
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (req.method === 'GET' && pathname === '/__the-forge/status') {
      // A PRESENT-but-empty ids param (`?ids=`) means "no items, thanks" — it's the watch
      // poller's cheap watcher-state probe. Only an ABSENT param returns everything.
      const idsParam = new URLSearchParams(query).get('ids')
      const wanted = idsParam === null ? null : new Set(idsParam.split(',').filter(Boolean))
      const items = queue
        .list()
        .filter((i) => !wanted || wanted.has(i.id))
        .map(({ id, status, note }) => ({ id, status, note }))
      send(res, 200, { items, watcher: watcherHub.state(), session: session ? session.manager.state() : 'unavailable' })
      return
    }

    send(res, 404, { error: 'unknown forge endpoint' })
  }
}

export function writeEndpointFile(dir: string, port: number, host?: string, secret?: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `endpoint-${process.pid}.json`)
  fs.writeFileSync(filePath, JSON.stringify({ port, host, pid: process.pid, secret }))
  return filePath
}

export function removeEndpointFile(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, `endpoint-${process.pid}.json`))
  } catch {
    // ignore — file may not exist, or dir may not exist
  }
}

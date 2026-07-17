import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Queue } from './queue'
import { dispatch as realDispatch, augmentDispatchMarkdown, type DispatchOpts, type DispatchResult } from './dispatch'
import { WatcherHub } from './watchers'
import { ensureDevtoolsUuid } from './setup'
import type { ForgeSessionHandles } from './runtime'
import { EMBEDDED_HARNESSES, HARNESS_VOCAB, type HarnessId, CHAT_TEXT_MAX } from '../shared/chat-constants'

/** Chrome DevTools' Automatic Workspace Folders well-known path (task A5) — served by
 * createForgeMiddleware below and proxied to it by src/next/index.ts's rewrites merge.
 * Exported so next/index.ts imports this constant rather than duplicating the string. */
export const DEVTOOLS_JSON_PATH = '/.well-known/appspecific/com.chrome.devtools.json'

/** The one URL the client bundle is served from, on BOTH frameworks (2026-07-10 security
 * review, finding 4). The served script embeds the per-start secret in its bootstrap line,
 * so it must live under the /__the-forge/ prefix where createForgeMiddleware's Host gate and
 * Origin-vs-Host check apply — previously Vite served it as an ungated virtual module
 * (/@the-forge/client) whose CORS posture belonged to Vite, not us, and the Next sidecar's
 * hand-rolled route checked Host but never Origin. Exported for src/vite.ts's
 * transformIndexHtml, src/next/sidecar.ts's hint-timer peek, and tests. */
export const CLIENT_JS_PATH = '/__the-forge/client.js'

const MAX_BODY = 1024 * 1024

const KNOWN_AGENTS = new Set<DispatchOpts['agent']>(['claude-code', 'cursor', 'codex'])

// /session/say + /session/config validation constants (Task 4). Regexes are spike-pinned
// (spec §2.4) — verbatim, not derived. CHAT_TEXT_MAX and the per-harness effort/permission-mode
// vocab now live in src/shared/chat-constants.ts (the single source of truth shared with the
// browser client's session-feed.ts pickers) — HARNESS_VOCAB is looked up per-request below,
// keyed off the target harness (the body's `harness` field when switching, else the session's
// current harness), since claude-code and cursor support different value sets.
// Length caps checked BEFORE the regexes below (cheaper) — CHAT_SOURCE_RE/CHAT_TAG_RE are
// anchored but have unbounded quantifiers, so a well-shaped-but-huge string (e.g. ~1MB of
// "a/") would otherwise pass the regex and ride the composed turn straight past the
// CHAT_TEXT_MAX text cap (final-review fix 4).
const CHAT_SOURCE_MAX = 512
const CHAT_TAG_MAX = 64
const CHAT_SOURCE_RE = /^[\w./-]+:\d+:\d+$/
const CHAT_TAG_RE = /^[a-z][a-z0-9-]*$/
const CONFIG_MODEL_MAX = 100
const EMBEDDED_HARNESSES_SET = new Set<string>(EMBEDDED_HARNESSES)

function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
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
        // Stop a hostile/broken client from streaming megabytes into now-discarded 'data'
        // handlers (`settled` just short-circuits them, it doesn't stop the bytes arriving) —
        // but deliver the 400 FIRST. The rejection above flows through readBody(req,res)'s
        // consumer as `.catch(e => send(res, 400, ...))`, which is two microtask hops away;
        // destroying the socket synchronously (or even one queueMicrotask hop later) races
        // ahead of that send and RSTs the connection, so against a real http.Server the client
        // gets ECONNRESET and never sees the error JSON. Hooking the response's own 'finish'
        // event — which fires only once send()'s res.end() has flushed the 400 to the OS —
        // guarantees the [send-400, destroy] ordering: the client receives the error body, THEN
        // the socket is torn down so no further upload is read. res.once (not on) so a normal
        // later response on a reused socket can't re-trigger the destroy.
        res.once('finish', () => req.destroy())
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
  // Idempotency guard (belt-and-braces, task 15c): a second send() attempt after headers are
  // already on the wire would throw ERR_HTTP_HEADERS_SENT — the /queue handler's isolated
  // notify() catch below is the primary defense against a post-200 throw reaching here, this
  // is the backstop for any other path that might one day call send() twice for one request.
  // Warn rather than swallow silently: the test fake THROWS on a double end(), so a future
  // double-respond bug is loud in tests — runtime must not be quieter than the suite.
  if (res.headersSent) {
    console.warn('[the-forge] send() after headers already sent — dropped (double-respond backstop)')
    return
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

/** Constant-time secret compare (task 15a). Node HTTP/1.x never arrays a duplicated
 * X-Forge-Secret — repeats arrive joined as one "a, b" string (only set-cookie arrays),
 * which simply fails the byte compare below. The typeof guard is defense against the
 * declared header TYPE (string | string[]) and any non-Node fronting layer that does
 * array it — reject every non-string shape outright before ever touching
 * timingSafeEqual, which throws on non-Buffer input. Length
 * mismatches are also rejected up front: timingSafeEqual requires equal-length buffers, and
 * comparing lengths first is safe (it leaks only the secret's length, not its content) while
 * avoiding a thrown RangeError. Only the actual byte comparison — the operation whose timing
 * could otherwise leak how many leading bytes matched — runs at constant time. */
function secretMatches(provided: unknown, secret: string): boolean {
  if (typeof provided !== 'string') return false
  const providedBuf = Buffer.from(provided, 'utf8')
  const secretBuf = Buffer.from(secret, 'utf8')
  if (providedBuf.length !== secretBuf.length) return false
  return crypto.timingSafeEqual(providedBuf, secretBuf)
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

/** DNS-rebinding defense: is this request's Host header one we trust? Module-private since
 * PR #29: the Next sidecar's hand-rolled client.js route was the one external consumer, and
 * that route is gone — the bundle now rides this middleware's own CLIENT_JS_PATH route, so
 * every forge route (both frameworks) reaches this check through rejectDisallowedHost. */
function isAllowedHost(host: string | undefined, allowedHosts: string[]): boolean {
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
// deliberately excluded: it's read-only and was scoped to expose only ids/statuses. In
// practice its response also includes each item's agent-authored `note` field (see the
// /status handler below) — free text the applying agent writes on mark_applied/mark_failed,
// e.g. "needs confirmation: <why>". That's a known asymmetry with the ids/statuses-only
// framing, accepted rather than gated behind the secret: `note` never carries anything more
// sensitive than the change-request markdown already visible in the queue file itself, and
// gating it would mean the watch poller (an unauthenticated GET) can no longer show it either.
// GET /session/events is also excluded here (it's not a POST) but is secret-gated explicitly
// in its own handler — see why-comment there; unlike /status, /session/events carries file
// paths and command text, which is why it gets the stricter treatment.
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
  '/__the-forge/session/say',
  '/__the-forge/session/config',
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
  /** Policy escape hatch (research doc §Billing): `false` disables the embedded-session rung
   * entirely — Sends use only the watcher/keystroke ladder, and nothing ever spawns a headless
   * CLI. Default true (embedded is the primary path, ratified 2026-07-09); exists so a consumer
   * can opt back to terminal-only dispatch without a plugin release if Anthropic's headless
   * posture flips. */
  embedded?: boolean
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
  session?: ForgeSessionHandles,
  // Reads the built client bundle for GET CLIENT_JS_PATH. A function, not a string, so the
  // bundle is re-read per request — a rebuild lands on the next browser reload instead of
  // being pinned for the dev server's lifetime. Optional so legacy callers/tests stand
  // unchanged (the route 404s without it); both framework entries pass their own resolver
  // because the dist/client.js lookup is relative to THEIR built module location.
  clientBundle?: () => string
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
    // NOT defend against another local user on a shared/multi-user machine — the endpoint file
    // is written 0700 dir / 0600 file (writeEndpointFile below) and the queue it manages is
    // likewise written 0700 dir / 0600 file (Queue.persist), which keeps other local accounts
    // out under a normal single-user Unix permission model, but that's OS-level file-permission
    // hardening, not something this HTTP layer enforces or can vouch for (a root/admin account,
    // a misconfigured umask, or a non-Unix filesystem ACL model all sit outside its reach).
    // Local-multi-user hardening beyond those file modes is out of scope for this single-user
    // dev tool.
    if (secret && req.method === 'POST' && MUTATING_PATHS.has(pathname)) {
      const provided = req.headers['x-forge-secret']
      if (!secretMatches(provided, secret)) {
        return send(res, 403, { error: 'missing or invalid X-Forge-Secret' })
      }
    }

    // GET CLIENT_JS_PATH — the client bundle with the per-start secret prepended. Reached
    // only AFTER the Host gate and Origin-vs-Host check above (finding 4's hardening): a
    // DNS-rebound Host 403s, and a cross-origin fetch/module load presenting an Origin
    // header 403s before the secret is ever written out, regardless of the server's CORS
    // posture. It cannot require X-Forge-Secret itself — this response is where the browser
    // client gets the secret FROM — so those two gates (plus no ACAO ever being set here,
    // and the bundle's trailing export breaking classic-script loads) are the whole defense.
    if (pathname === CLIENT_JS_PATH && clientBundle) {
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' })
      const bootstrap = `globalThis.__THE_FORGE__ = ${JSON.stringify({ secret: secret ?? '', agent: dispatchConfig.agent })};\n`
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/javascript')
      res.end(bootstrap + clientBundle())
      return
    }

    // GET /session/events — secret-gated despite being a GET. Events carry file paths and
    // command text, making them more sensitive than /status (which only exposes ids/statuses).
    // Deliberate asymmetry with /status's open GET: the browser client uses fetch() rather than
    // EventSource precisely so it can attach the X-Forge-Secret header on this request.
    // MUTATING_PATHS covers POST-only; this GET needs its own explicit gate.
    if (req.method === 'GET' && pathname === '/__the-forge/session/events') {
      if (secret) {
        const provided = req.headers['x-forge-secret']
        if (!secretMatches(provided, secret)) {
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
      readBody(req, res)
        .then((body) => {
          const { request, markdown } = body as { request?: unknown; markdown?: string }
          if (typeof markdown !== 'string') return send(res, 400, { error: 'markdown required' })
          const item = queue.add(request ?? null, markdown)
          send(res, 200, { id: item.id })
          // After the 200 — delivery to a parked watcher must never delay or fail the Send.
          // Isolated in its own try/catch (task 15c): notify() runs after the response is
          // already sent, so a throw here has no send() call left to propagate to — left
          // unguarded, it would escape this .then() as a rejected promise with no attached
          // .catch, i.e. an unhandled rejection, which crashes the dev server process on
          // Node >=15 (unhandled rejections no longer just warn). Logging keeps the failure
          // visible without resurrecting that crash risk.
          try {
            watcherHub.notify()
          } catch (e) {
            console.warn('[the-forge] watcherHub.notify() threw after /queue responded:', e)
          }
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
      readBody(req, res)
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
      readBody(req, res)
        .then((body) => {
          // Body overrides are a test/escape-hatch surface only: the overlay client always
          // POSTs {} (see postDispatch in client/index.ts), so in production `agent` comes
          // from dispatchConfig and `markdown` from the newest pending queue item below.
          // The endpoint tests exercise both overrides directly; keep them working.
          const { agent, markdown } = (body ?? {}) as { agent?: DispatchOpts['agent']; markdown?: string }
          if (agent !== undefined && !KNOWN_AGENTS.has(agent)) {
            return send(res, 400, { error: 'unknown agent' })
          }
          // The LADDER's target agent only (keystroke/deeplink augmentation below) — the
          // embedded rung deliberately does NOT key off this (dual-SoT fix, PR #32 review):
          // which harness the embedded rung drives is session.manager.harness(), the manager's
          // own picker-persisted selection. The ladder is unreachable while an embedded
          // runtime is in play, so this only ever names the external app when there is no
          // session wired or the consumer opted out (embedded: false).
          const resolvedAgent = agent ?? dispatchConfig.agent

          // Embedded short-circuit — BEFORE the watcher check and BEFORE the pending-item
          // check: the queue POST already happened; notifyDesignEdits makes the in-process
          // session pull everything pending, same "delivered, not manual" logic as watcher.
          //
          // Precedence rationale (spec §3.4):
          //   ready|busy|starting → session is alive; deliver immediately, skip ladder.
          //   idle|failed + no live watcher → auto-start the session (primary-path semantics);
          //     an external watcher wins over AUTO-STARTING but never over an already-RUNNING
          //     embedded session — the user deliberately linked that terminal session, so we
          //     only prefer the embedded path when there is nobody else to notify.
          //   idle|failed + live watcher → fall through; the watcher check below takes over.
          //
          // Known benign overlap: with BOTH a running embedded session and a live watcher,
          // the queue POST already notified the watcher's parked /wait while this rung
          // delivers to the embedded session — both race pull_design_edits, one claims
          // everything, the loser burns a "No pending design edits" tick. Harmless
          // (pull is idempotent) but token-wasteful; acceptable for the rare dual setup.
          //
          // Gate is "an embedded runtime exists and isn't opted out" — NOT the agent string
          // (dual-SoT fix, PR #32 review): WHICH harness the rung drives is the manager's own
          // picker-persisted selection (session.manager.harness()), the single runtime source
          // of truth. The plugin `agent` option only seeds defaultHarness (runtime.ts) and
          // names the ladder's external target — and the ladder is unreachable from here
          // (every branch below returns, or falls through to the watcher return). A
          // codex-configured project therefore still gets embedded delivery: its manager
          // drives claude-code until C2 (the defaultHarness narrowing in runtime.ts).
          // dispatchConfig.embedded === false stays the consumer opt-out (see DispatchConfig);
          // with it the ladder targets the plugin-configured agent exactly as before.
          if (session && dispatchConfig.embedded !== false) {
            const sessionState = session.manager.state()
            if (sessionState === 'ready' || sessionState === 'busy' || sessionState === 'starting') {
              session.manager.notifyDesignEdits()
              return send(res, 200, { rung: 'embedded', detail: 'delivered to the embedded session' })
            }
            if (!watcherHub.isLive()) {
              // idle|failed + no live watcher → auto-start (notifyDesignEdits kicks the start)
              session.manager.notifyDesignEdits()
              return send(res, 200, { rung: 'embedded', detail: 'starting embedded session' })
            }
            // idle|failed + live watcher → fall through to the watcher short-circuit below
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

    if (pathname === '/__the-forge/session/say') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      // DispatchConfig.embedded promises "nothing ever spawns a headless CLI" — say() on an
      // idle/failed session auto-spawns one, so the opt-out must gate this endpoint too, not
      // just /dispatch's embedded rung. Checked BEFORE the session check: a disabled rung and
      // an absent session must be indistinguishable to callers (same 404 body either way).
      if (dispatchConfig.embedded === false) return send(res, 404, { error: 'embedded session unavailable' })
      if (!session) return send(res, 404, { error: 'embedded session unavailable' })
      readBody(req, res)
        .then((body) => {
          const { text, element } = (body ?? {}) as { text?: unknown; element?: unknown }
          // Validation order (brief, binding): text first — an invalid element must never
          // partially forward alongside a rejected text, and a rejected text must never
          // even look at element.
          if (typeof text !== 'string' || text.length === 0 || text.length > CHAT_TEXT_MAX) {
            return send(res, 400, { error: `text must be a non-empty string of at most ${CHAT_TEXT_MAX} characters` })
          }
          let parsedElement: { source: string; tag: string } | undefined
          if (element !== undefined) {
            const { source, tag } = (element ?? {}) as { source?: unknown; tag?: unknown }
            if (
              typeof source !== 'string' ||
              typeof tag !== 'string' ||
              source.length > CHAT_SOURCE_MAX ||
              tag.length > CHAT_TAG_MAX ||
              !CHAT_SOURCE_RE.test(source) ||
              !CHAT_TAG_RE.test(tag)
            ) {
              return send(res, 400, { error: 'element.source/tag invalid' })
            }
            parsedElement = { source, tag }
          }
          const result = session.manager.say(text, parsedElement)
          if (!result.ok) {
            return send(res, 429, { error: 'chat queue full' })
          }
          return send(res, 200, { ok: true })
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (pathname === '/__the-forge/session/config') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      // Same opt-out gate as /session/say above — config changes are meaningless (and
      // model/permissionMode would silently no-op against a session that can never spawn)
      // when the consumer has disabled the embedded rung entirely.
      if (dispatchConfig.embedded === false) return send(res, 404, { error: 'embedded session unavailable' })
      if (!session) return send(res, 404, { error: 'embedded session unavailable' })
      readBody(req, res)
        .then((body) => {
          const { model, permissionMode, effort, harness } = (body ?? {}) as {
            model?: unknown
            permissionMode?: unknown
            effort?: unknown
            harness?: unknown
          }
          if (model === undefined && permissionMode === undefined && effort === undefined && harness === undefined) {
            return send(res, 400, { error: 'at least one of model, permissionMode, effort, harness required' })
          }
          if (model !== undefined && (typeof model !== 'string' || model.length === 0 || model.length > CONFIG_MODEL_MAX)) {
            return send(res, 400, { error: `model must be a non-empty string of at most ${CONFIG_MODEL_MAX} characters` })
          }
          if (harness !== undefined && (typeof harness !== 'string' || !EMBEDDED_HARNESSES_SET.has(harness))) {
            return send(res, 400, { error: `harness must be one of ${EMBEDDED_HARNESSES.join(', ')}` })
          }
          // effort/permissionMode validate against the TARGET harness's vocab: the harness
          // being switched TO in this same call (the body's `harness`), else the session's
          // current harness — a switch-and-configure-in-one-call must validate against the
          // NEW harness's tables, not the one being left behind. Empty tables (cursor today)
          // reject every value; the error text distinguishes "wrong value" from "no such knob".
          const vocabHarness: HarnessId = (harness as HarnessId | undefined) ?? session.manager.harness()
          const vocab = HARNESS_VOCAB[vocabHarness]
          if (permissionMode !== undefined) {
            if (typeof permissionMode !== 'string' || !vocab.permissionModes.includes(permissionMode)) {
              return send(res, 400, {
                error:
                  vocab.permissionModes.length === 0
                    ? 'permissionMode is not supported for this harness'
                    : `permissionMode must be one of ${vocab.permissionModes.join(', ')}`,
              })
            }
          }
          if (effort !== undefined) {
            if (typeof effort !== 'string' || !vocab.efforts.includes(effort)) {
              return send(res, 400, {
                error:
                  vocab.efforts.length === 0
                    ? 'effort is not supported for this harness'
                    : `effort must be one of ${vocab.efforts.join(', ')}`,
              })
            }
          }
          const cfg: { model?: string; permissionMode?: string; effort?: string; harness?: HarnessId } = {}
          if (typeof model === 'string') cfg.model = model
          if (typeof permissionMode === 'string') cfg.permissionMode = permissionMode
          if (typeof effort === 'string') cfg.effort = effort
          if (typeof harness === 'string') cfg.harness = harness as HarnessId
          const result = session.manager.setConfig(cfg)
          if (!result.ok) {
            return send(res, 409, { error: 'session is busy' })
          }
          return send(res, 200, { ok: true })
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (pathname === '/__the-forge/approval') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      if (!session) return send(res, 404, { error: 'embedded session unavailable' })
      readBody(req, res)
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
      readBody(req, res)
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
      send(res, 200, {
        items,
        watcher: watcherHub.state(),
        session: session ? session.manager.state() : 'unavailable',
        // The client-side chat surface (Task 6) uses this to decide whether to render at
        // all — distinct from `session` (which reports the live adapter state) because it
        // reflects the DispatchConfig.embedded opt-out, not runtime session health.
        sessionEnabled: dispatchConfig.embedded !== false,
        // The picker's reload seed (Task 5/6 client): which embedded harness this session is
        // (or will be, on the next auto-start) driving. Omitted, not null/'unavailable', when
        // no session is wired — mirrors `harness`'s absence from every other no-session field.
        ...(session ? { harness: session.manager.harness() } : {}),
      })
      return
    }

    send(res, 404, { error: 'unknown forge endpoint' })
  }
}

export function writeEndpointFile(dir: string, port: number, host?: string, secret?: string): string {
  // Owner-only (0700 dir / 0600 file): this file carries the auth secret, and edit-tier tools
  // are auto-approved in the embedded session — any local reader of the secret can drive code
  // writes into the project via POST /session/say. The explicit chmod matters: writeFileSync's
  // mode applies only at creation, so overwriting a looser file from a pre-hardening plugin
  // version (or after pid reuse) would otherwise keep it world-readable.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const filePath = path.join(dir, `endpoint-${process.pid}.json`)
  fs.writeFileSync(filePath, JSON.stringify({ port, host, pid: process.pid, secret }), { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
  return filePath
}

export function removeEndpointFile(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, `endpoint-${process.pid}.json`))
  } catch {
    // ignore — file may not exist, or dir may not exist
  }
}

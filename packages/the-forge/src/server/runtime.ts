import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Queue } from './queue'
import { WatcherHub } from './watchers'
import { migrateLegacyForgeDir } from './setup'
import { SessionManager } from './session/manager'
import { ApprovalRegistry, type ApprovalFeedItem } from './session/approvals'
import { ClaudeAdapter } from './session/claude'
import { CursorAdapter } from './session/cursor'
import { EMBEDDED_HARNESSES, type HarnessId } from '../shared/chat-constants'

/** Per-connection session handles exposed to the middleware. The fan-out broadcaster
 * (`onApproval`) bridges the registry's single constructor-injected onChange callback
 * to per-connection subscribers — each stream connection gets its own unsubscribe. */
export interface ForgeSessionHandles {
  manager: SessionManager
  approvals: ApprovalRegistry
  onApproval: (fn: (e: ApprovalFeedItem) => void) => () => void
}

export interface ForgeRuntime {
  queue: Queue
  hub: WatcherHub
  secret: string
  forgeDir: string
  session: ForgeSessionHandles
}

/**
 * Hoists the queue/hub/secret construction that both the Vite plugin's configureServer
 * (src/vite.ts) and the Next.js sidecar (src/next/sidecar.ts) need identically: a Queue at
 * <resolvedRoot>/.the-forge, the one-time legacy-dir migration (only when a distinct
 * viteRoot is given — the sidecar has no Vite-root dir to migrate from), a WatcherHub wired
 * to that same queue's pull()/hasFreshClaims(), and a per-start random secret.
 *
 * Endpoint-file lifecycle deliberately stays with each caller — listen/close hooks differ
 * per server (Vite's httpServer events vs. the sidecar's own http.Server).
 */
export function createForgeRuntime(
  resolvedRoot: string,
  viteRoot?: string,
  opts?: { defaultAgent?: 'claude-code' | 'cursor' | 'codex' }
): ForgeRuntime {
  const forgeDir = path.join(resolvedRoot, '.the-forge')
  const queue = new Queue(forgeDir)
  if (viteRoot !== undefined) migrateLegacyForgeDir(resolvedRoot, viteRoot, queue)
  // Generated once per server start — belt-and-braces against cross-origin/DNS-rebinding
  // bypasses of the Origin/Host checks in the middleware; same-origin page scripts are the
  // user's own app and not the adversary. Threaded to the client via the load() bootstrap,
  // and to the MCP bin via the endpoint file (writeEndpointFile).
  const secret = randomUUID()
  // The watch-mode long-poll registry (/forge-watch linked sessions). Per dev-server
  // process by design — the MCP bin discovers the newest live server, so the watcher
  // follows it; a hub is pure in-memory state and costs nothing until a session watches.
  // `applying` keeps the watcher live through its apply window (claimed items in
  // flight), when it is neither parked nor heartbeating — see WatcherHubOpts.applying.
  const hub = new WatcherHub({
    claim: () => queue.pull(),
    applying: () => queue.hasFreshClaims(),
  })

  // Fan-out broadcaster for approval events. ApprovalRegistry's onChange is a single
  // constructor-injected callback (one instance, one listener) — we bridge it here to a
  // Set<listener> so each connected events-stream gets its own per-connection unsubscribe.
  const approvalListeners = new Set<(e: ApprovalFeedItem) => void>()
  const approvals = new ApprovalRegistry({
    onChange: (e) => {
      // Approval lifecycle → watchdog wiring lives HERE because this is the composition
      // root where both objects exist (approvals.ts must not import manager.ts): a parked
      // approval suspends the watchdog (a human deciding is not a hung CLI), and an ALLOW
      // re-arms with the long post-approval leash so an approved build/test isn't killed
      // mid-command (it emits nothing on stdout until its tool_result). `manager` is
      // declared below — safe: onChange only ever fires after construction completes.
      if (e.kind === 'approval-request') {
        manager.onApprovalPending()
      } else {
        manager.onApprovalResolved(e.allow)
      }
      for (const fn of approvalListeners) fn(e)
    },
  })
  // defaultAgent is the plugin's `agent` option (or the sidecar's equivalent), which spans a
  // third value ('codex') this manager can't yet drive embedded (C2). Narrow it to a HarnessId
  // here — a codex-configured project chats via Claude until C2, same posture as the dispatch
  // ladder's embedded-rung gate below.
  const defaultHarness: HarnessId =
    opts?.defaultAgent !== undefined && (EMBEDDED_HARNESSES as readonly string[]).includes(opts.defaultAgent)
      ? (opts.defaultAgent as HarnessId)
      : 'claude-code'
  const manager = new SessionManager({
    // Keyed off opts.harness (ClaudeAdapter vs CursorAdapter) — every spawn is FOR a specific
    // harness, never ambiguous (see SessionManagerOpts.makeAdapter's own why-comment).
    // `opts.effort` (threaded by SessionManager on every spawn) becomes ClaudeAdapter's
    // constructor-time spawn flag — see ClaudeAdapter's constructor why-comment (spike:
    // spawn-flag-only, no set_effort control request); CursorAdapter accepts-and-ignores it
    // (no effort control surface — see cursor.ts's own why-comment).
    makeAdapter: (adapterOpts) => {
      if (adapterOpts.harness === 'cursor') {
        const a = new CursorAdapter(undefined, { effort: adapterOpts.effort })
        // Non-edit ACP permission requests: same registry, same overlay UI, same timeout-to-deny —
        // the approve MCP tool + --permission-prompt-tool remain Claude-only; edit-kind requests
        // never reach here (adapter-side auto-allow, the ratified posture).
        a.onApproval = (toolName, detail) => approvals.request(toolName, detail).promise
        return a
      }
      return new ClaudeAdapter(undefined, adapterOpts)
    },
    forgeDir,
    cwd: resolvedRoot,
    defaultHarness,
  })
  const session: ForgeSessionHandles = {
    manager,
    approvals,
    onApproval: (fn) => {
      approvalListeners.add(fn)
      return () => approvalListeners.delete(fn)
    },
  }

  return { queue, hub, secret, forgeDir, session }
}

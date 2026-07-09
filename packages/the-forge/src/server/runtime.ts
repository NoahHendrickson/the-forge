import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Queue } from './queue'
import { WatcherHub } from './watchers'
import { migrateLegacyForgeDir } from './setup'
import { SessionManager } from './session/manager'
import { ApprovalRegistry, type ApprovalFeedItem } from './session/approvals'
import { ClaudeAdapter } from './session/claude'

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
export function createForgeRuntime(resolvedRoot: string, viteRoot?: string): ForgeRuntime {
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
      for (const fn of approvalListeners) fn(e)
    },
  })
  const manager = new SessionManager({
    // Production default: ClaudeAdapter. Task 5 (vite.ts / sidecar.ts) wires this in;
    // this default is what callers get if they don't override the factory.
    makeAdapter: () => new ClaudeAdapter(),
    forgeDir,
    cwd: resolvedRoot,
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

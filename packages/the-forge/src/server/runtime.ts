import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Queue } from './queue'
import { WatcherHub } from './watchers'
import { migrateLegacyForgeDir } from './setup'

export interface ForgeRuntime {
  queue: Queue
  hub: WatcherHub
  secret: string
  forgeDir: string
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
  return { queue, hub, secret, forgeDir }
}

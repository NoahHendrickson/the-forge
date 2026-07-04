import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Plugin } from 'vite'
import { tagJsxSource } from './transform'
import { Queue } from './server/queue'
import { createForgeMiddleware, writeEndpointFile, removeEndpointFile } from './server/endpoints'
import { WatcherHub } from './server/watchers'
import { setupProjectConfig, resolveProjectRoot, migrateLegacyForgeDir } from './server/setup'
import type { DispatchOpts } from './server/dispatch'

export const CLIENT_ID = '/@the-forge/client'

export interface TheForgeOptions {
  /** Which agent CLI's RUNNING session the dispatch ladder should reach for on Send.
   * Defaults to 'claude-code'. */
  agent?: DispatchOpts['agent']
  /** Opt-in to the experimental Channels rung (claude-code only). Tonight this rung is a stub
   * that always falls through — see server/dispatch.ts. Defaults to false. */
  experimentalChannels?: boolean
}

export function theForge(options: TheForgeOptions = {}): Plugin {
  const agent = options.agent ?? 'claude-code'
  const experimentalChannels = options.experimentalChannels ?? false
  let root = process.cwd()
  // Generated once per server start — belt-and-braces against cross-origin/DNS-rebinding
  // bypasses of the Origin/Host checks in the middleware; same-origin page scripts are the
  // user's own app and not the adversary. Threaded to the client via the load() bootstrap
  // below, and to the MCP bin via the endpoint file (writeEndpointFile).
  const secret = randomUUID()

  return {
    name: 'the-forge',
    apply: 'serve',
    enforce: 'pre',

    configResolved(config) {
      root = config.root
    },

    configureServer(server) {
      // The user's Claude Code session (and the MCP bin's endpoint-file discovery, which reads
      // from process.cwd()/.the-forge) runs at the actual project root, which in a monorepo is
      // very often NOT Vite's config root (e.g. a nested fixtures/demo-app/ package) — walk up
      // looking for .git so the queue dir / endpoint file / .mcp.json / command file all land
      // where the MCP bin and the session will actually see them. Using the vite root here was
      // the root cause of "dev server not running": the plugin wrote the endpoint file (and its
      // shared secret) at the vite root while the MCP bin only ever looked at the resolved root.
      const resolvedRoot = resolveProjectRoot(root)
      const forgeDir = path.join(resolvedRoot, '.the-forge')
      const queue = new Queue(forgeDir)
      migrateLegacyForgeDir(resolvedRoot, root, queue)
      const allowedHosts = Array.isArray(server.config.server.allowedHosts) ? server.config.server.allowedHosts : []
      // The watch-mode long-poll registry (/forge-watch linked sessions). Per dev-server
      // process by design — the MCP bin discovers the newest live server, so the watcher
      // follows it; a hub is pure in-memory state and costs nothing until a session watches.
      // `applying` keeps the watcher live through its apply window (claimed items in
      // flight), when it is neither parked nor heartbeating — see WatcherHubOpts.applying.
      const hub = new WatcherHub({
        claim: () => queue.pull(),
        applying: () => queue.hasFreshClaims(),
      })
      server.middlewares.use(
        createForgeMiddleware(queue, allowedHosts, secret, { agent, channelsFlag: experimentalChannels, cwd: resolvedRoot }, hub)
      )
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        if (address && typeof address === 'object') writeEndpointFile(forgeDir, address.port, address.address, secret)
      })
      server.httpServer?.once('close', () => removeEndpointFile(forgeDir))
      process.once('exit', () => removeEndpointFile(forgeDir))
      const dir = path.dirname(fileURLToPath(import.meta.url))
      setupProjectConfig(resolvedRoot, path.join(dir, 'mcp.js'), root)
    },

    transform(code, id) {
      const [file] = id.split('?')
      if (!/\.[jt]sx$/.test(file)) return null
      if (file.includes('/node_modules/')) return null
      const rel = path.relative(root, file).split(path.sep).join('/')
      // path.relative yields an absolute path for cross-drive files on Windows — exclude those too
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null
      return tagJsxSource(code, rel)
    },

    resolveId(id) {
      if (id === CLIENT_ID) return CLIENT_ID
      return undefined
    },

    load(id) {
      if (id !== CLIENT_ID) return null
      const dir = path.dirname(fileURLToPath(import.meta.url))
      // In the built package, client.js sits next to this module (dist/).
      // Under vitest, this module resolves from src/, where client.js is never
      // emitted — fall back to the built dist/client.js in that case.
      const nextToModule = path.join(dir, 'client.js')
      const builtFallback = path.join(dir, '..', 'dist', 'client.js')
      const clientPath = fs.existsSync(nextToModule)
        ? nextToModule
        : fs.existsSync(builtFallback)
          ? builtFallback
          : null
      if (!clientPath) {
        throw new Error(
          'the-forge: client bundle not found — run "npm run build -w the-forge"'
        )
      }
      const bootstrap = `globalThis.__THE_FORGE__ = ${JSON.stringify({ secret, agent })};\n`
      return bootstrap + fs.readFileSync(clientPath, 'utf8')
    },

    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: CLIENT_ID },
          injectTo: 'body',
        },
      ]
    },
  }
}

export default theForge

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { tagJsxSource } from './transform'
import { createForgeMiddleware, writeEndpointFile, removeEndpointFile } from './server/endpoints'
import { setupProjectConfig, resolveProjectRoot } from './server/setup'
import { createForgeRuntime } from './server/runtime'
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
  // below, and to the MCP bin via the endpoint file (writeEndpointFile). Assigned inside
  // configureServer (createForgeRuntime mints it) but read from load(), which runs outside
  // configureServer — so it lives in this outer closure rather than that function's scope.
  let secret = ''

  return {
    name: 'the-forge',
    apply: 'serve',
    enforce: 'pre',

    config() {
      // Belt-and-braces with the install-time .gitignore entry (server/setup.ts): even in a
      // project with no .gitignore (or a scanner that ignores it), `.the-forge/` runtime
      // writes (queue.json on every Send) must never enter the dev watcher — an unignored
      // queue write full-reloads the page in Tailwind-v4 projects and wipes the overlay.
      // Returned as a partial config: Vite merges plugin config additively (mergeConfig
      // concatenates arrays), so user-supplied `server.watch.ignored` entries survive.
      return { server: { watch: { ignored: ['**/.the-forge/**'] } } }
    },

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
      const { queue, hub, secret: runtimeSecret, forgeDir, session } = createForgeRuntime(resolvedRoot, root)
      secret = runtimeSecret
      const allowedHosts = Array.isArray(server.config.server.allowedHosts) ? server.config.server.allowedHosts : []
      server.middlewares.use(
        createForgeMiddleware(queue, allowedHosts, secret, { agent, channelsFlag: experimentalChannels, cwd: resolvedRoot }, hub, session)
      )
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        if (address && typeof address === 'object') writeEndpointFile(forgeDir, address.port, address.address, secret)
      })
      server.httpServer?.once('close', () => {
        removeEndpointFile(forgeDir)
        session.manager.stop()
      })
      process.once('exit', () => {
        removeEndpointFile(forgeDir)
        session.manager.stop()
      })
      const dir = path.dirname(fileURLToPath(import.meta.url))
      setupProjectConfig(resolvedRoot, path.join(dir, 'mcp.js'), root, agent)
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

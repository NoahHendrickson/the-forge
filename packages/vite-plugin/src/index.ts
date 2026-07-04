import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Plugin } from 'vite'
import { tagJsxSource } from './transform'
import { Queue } from './server/queue'
import { createForgeMiddleware, writeEndpointFile, removeEndpointFile } from './server/endpoints'
import { setupProjectConfig, resolveProjectRoot } from './server/setup'
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
      const forgeDir = path.join(root, '.the-forge')
      const queue = new Queue(forgeDir)
      const allowedHosts = Array.isArray(server.config.server.allowedHosts) ? server.config.server.allowedHosts : []
      server.middlewares.use(createForgeMiddleware(queue, allowedHosts, secret, { agent, channelsFlag: experimentalChannels }))
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        if (address && typeof address === 'object') writeEndpointFile(forgeDir, address.port, address.address, secret)
      })
      server.httpServer?.once('close', () => removeEndpointFile(forgeDir))
      process.once('exit', () => removeEndpointFile(forgeDir))
      const dir = path.dirname(fileURLToPath(import.meta.url))
      // The user's Claude Code session runs at the actual project root, which in a monorepo
      // is very often NOT Vite's config root (e.g. a nested fixtures/demo-app/ package) — walk
      // up looking for .git so .mcp.json / the command file land where the session will see them.
      setupProjectConfig(resolveProjectRoot(root), path.join(dir, 'mcp.js'))
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
          'the-forge: client bundle not found — run "npm run build -w @the-forge/vite"'
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

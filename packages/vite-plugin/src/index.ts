import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { tagJsxSource } from './transform'
import { Queue } from './server/queue'
import { createForgeMiddleware, writeEndpointFile } from './server/endpoints'
import { setupProjectConfig } from './server/setup'

export const CLIENT_ID = '/@the-forge/client'

export function theForge(): Plugin {
  let root = process.cwd()

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
      server.middlewares.use(createForgeMiddleware(queue))
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        if (address && typeof address === 'object') writeEndpointFile(forgeDir, address.port)
      })
      const dir = path.dirname(fileURLToPath(import.meta.url))
      setupProjectConfig(root, path.join(dir, 'mcp.js'))
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
      return fs.readFileSync(clientPath, 'utf8')
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

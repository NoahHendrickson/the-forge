import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { tagJsxSource } from './transform'

export const CLIENT_ID = '/@design-companion/client'

export function designCompanion(): Plugin {
  let root = process.cwd()

  return {
    name: 'design-companion',
    apply: 'serve',
    enforce: 'pre',

    configResolved(config) {
      root = config.root
    },

    transform(code, id) {
      const [file] = id.split('?')
      if (!/\.[jt]sx$/.test(file)) return null
      if (file.includes('/node_modules/')) return null
      const rel = path.relative(root, file)
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
      return fs.readFileSync(path.join(dir, 'client.js'), 'utf8')
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

export default designCompanion

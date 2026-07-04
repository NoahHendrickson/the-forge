import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    platform: 'node',
    external: ['vite'],
    clean: true,
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: ['esm'],
    platform: 'browser',
    define: { 'import.meta.vitest': 'undefined' },
  },
])

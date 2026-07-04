import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', vite: 'src/vite.ts' },
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
  {
    entry: { mcp: 'src/mcp/index.ts' },
    format: ['esm'],
    platform: 'node',
  },
  {
    // CJS per the N0 spike findings (docs/research/2026-07-04-next-spike-findings.md):
    // both Turbopack and webpack accept CJS or ESM loader modules equally, so this
    // matches the rest of the package's CJS-first tooling instead of adding a new
    // format branch. withForge (N4) passes an absolute require.resolve()-style path
    // to this file in `turbopack.rules`/`webpack(config)`, so the package's own
    // "type": "module" has no bearing on how Next loads it.
    //
    // The source uses `export default` (so `tsc --noEmit`, which runs under this
    // package's ESNext-module tsconfig, accepts it — TS `export =` is rejected there
    // with TS1203). But tsup/esbuild's default CJS interop for `export default` emits
    // `module.exports = { default: fn, __esModule: true }`, NOT a bare function — the
    // spike's proven-working loader shape (both Turbopack's `loaders: [...]` and
    // webpack's `use: [...]` do `require(path)` and invoke the result directly, with
    // no `.default` unwrapping). The footer rewrites the emitted artifact to the bare
    // `module.exports = forgeLoader` shape the spike verified, without changing the
    // TS source's export style.
    entry: { 'next-loader': 'src/next/loader.ts' },
    format: ['cjs'],
    platform: 'node',
    dts: false,
    footer: { js: 'module.exports = module.exports.default;' },
  },
])

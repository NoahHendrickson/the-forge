import { defineConfig } from 'tsup'

// Whitespace/comment-only minification — NOT identifier mangling: stack traces (in-browser
// bug reports and node-side crashes alike) must keep naming real functions, but shipped
// bundles have no business carrying source comments and indentation (the why-comments
// live in src/, which is what people actually read). Sole purpose is the package-size
// budget in check-prod-clean.sh (280KB as of the embedded-session milestone); flipping to
// full `minify: true` would save more but costs debuggability — don't, without revisiting
// that trade-off. Originally client-only; applied to every bundle when the budget hit
// ~249.25/250KB (PR #22) — the node bundles alone were carrying ~21KB of whitespace.
const stripWhitespace = (options: { minifyWhitespace?: boolean }): void => {
  options.minifyWhitespace = true
}

export default defineConfig([
  {
    // `clean` is deliberately NOT set here (see the `build` script in package.json,
    // which does `rm -rf dist` before invoking tsup): tsup runs every config-array
    // entry concurrently in one process, and each `dts: true` entry's type rollup
    // spins up a worker that unconditionally globs-and-deletes `**/*.d.ts` across the
    // *shared* outDir on its own buildStart (tsup's `tsup:clean` rollup plugin, scoped
    // to `options.clean` on THIS entry but not to files owned by this entry). With two
    // `dts: true` entries (this one and design-mode below) sharing `dist/`, relying on
    // `clean: true` here raced design-mode's DTS worker and silently deleted
    // `dist/design-mode.d.ts` after it had already been written — reproduced locally,
    // not a one-off flake. Pre-cleaning in the npm script sidesteps the race entirely.
    entry: { index: 'src/index.ts', vite: 'src/vite.ts', next: 'src/next/index.ts' },
    format: ['esm'],
    dts: true,
    platform: 'node',
    external: ['vite'],
    esbuildOptions: stripWhitespace,
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: ['esm'],
    platform: 'browser',
    define: { 'import.meta.vitest': 'undefined' },
    esbuildOptions: stripWhitespace,
  },
  {
    entry: { mcp: 'src/mcp/index.ts' },
    format: ['esm'],
    platform: 'node',
    esbuildOptions: stripWhitespace,
  },
  {
    // `platform: 'neutral'` + `external: ['react']`: this is the node-free boundary
    // module (Pages Router compiles `_app.tsx` into the browser bundle). Neutral
    // platform means esbuild adds no node/browser globals or shims, and leaves
    // `process.env.NODE_ENV` as a literal untouched (verified by the boundary test in
    // tests/next/design-mode.test.ts) instead of inlining it at OUR build time.
    entry: { 'design-mode': 'src/design-mode/index.ts' },
    format: ['esm'],
    platform: 'neutral',
    external: ['react'],
    dts: true,
    // Deliberately NOT stripWhitespace: the node-free boundary test
    // (tests/next/design-mode.test.ts) audits this bundle's import lines with line-based
    // parsing, and the file is <1KB — exempting it keeps the load-bearing guard intact
    // for a negligible byte cost.
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
    esbuildOptions: stripWhitespace,
  },
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    esbuildOptions: stripWhitespace,
  },
])

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSidecar } from './sidecar'
import { resolveProjectRoot } from '../server/setup'
import type { DispatchOpts } from '../server/dispatch'

// Never `import { PHASE_DEVELOPMENT_SERVER } from 'next'` — this module (and therefore the
// whole `the-forge/next` subpath) must load without `next` installed, since only the types
// are structural here (repo-wide constraint: next/react/vite are optional peers). The value
// itself is stable, public Next API surface (unchanged across 15/16 per the N0 spike).
const PHASE_DEVELOPMENT_SERVER = 'phase-development-server'

/** Minimal local structural type for the handful of NextConfig fields withForge touches.
 * `unknown` + manual checks at I/O boundaries is the repo convention — no `next` types, no
 * schema libraries. Anything the user's config carries that we don't touch passes through
 * via the `[key: string]: unknown` index signature untouched. */
export interface NextConfig {
  rewrites?: () => Promise<NextRewrites>
  webpack?: (config: WebpackConfig, ctx: WebpackContext) => WebpackConfig
  turbopack?: { rules?: Record<string, unknown> }
  experimental?: Record<string, unknown>
  [key: string]: unknown
}

export type NextRewriteRule = { source: string; destination: string; [key: string]: unknown }

export type NextRewrites =
  | NextRewriteRule[]
  | { beforeFiles?: NextRewriteRule[]; afterFiles?: NextRewriteRule[]; fallback?: NextRewriteRule[] }

export interface WebpackConfig {
  module?: { rules?: unknown[] }
  [key: string]: unknown
}

export type WebpackContext = Record<string, unknown>

export type NextPhase = string

export type NextConfigFn = (
  phase: NextPhase,
  ctx: { defaultConfig: NextConfig; [key: string]: unknown }
) => NextConfig | Promise<NextConfig>

export interface WithForgeOptions {
  /** Which agent CLI's RUNNING session the dispatch ladder should reach for on Send.
   * Defaults to 'claude-code'. */
  agent?: DispatchOpts['agent']
  /** Opt-in to the experimental Channels rung (claude-code only). Defaults to false. */
  experimentalChannels?: boolean
}

// Module-level flag: at most one "could not start" warning per process, matching the
// sidecar's own one-shot hint pattern — Next's rewrites() is called repeatedly (at least
// twice per the N0 spike, more across HMR/rebuilds), and ensureSidecar's singleton means a
// prior rejection would otherwise be re-logged on every single rewrite-resolution call.
let warnedSidecarFailure = false

function loaderPath(): string {
  // Mirrors sidecar.ts's defaultClientBundle / vite.ts's load() pattern: in the built
  // package, next-loader.cjs sits next to dist/next.js. Under vitest this module resolves
  // from src/, where next-loader.cjs is never emitted — the loader is only ever invoked by a
  // real bundler (Turbopack/webpack) outside of unit tests, so unit tests just assert the
  // path shape (endsWith('next-loader.cjs')) rather than requiring the file to exist.
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return path.join(dir, 'next-loader.cjs')
}

function buildLoaderRule(root: string): { loader: string; options: { root: string } } {
  return { loader: loaderPath(), options: { root } }
}

function chainWebpack(
  userWebpack: ((config: WebpackConfig, ctx: WebpackContext) => WebpackConfig) | undefined,
  loaderRule: { loader: string; options: { root: string } }
): (config: WebpackConfig, ctx: WebpackContext) => WebpackConfig {
  return (config, ctx) => {
    const out = userWebpack ? userWebpack(config, ctx) : config
    out.module = out.module ?? {}
    out.module.rules = out.module.rules ?? []
    out.module.rules.unshift({
      test: /\.[jt]sx$/,
      exclude: /node_modules/,
      // `enforce: 'pre'` — found via the next-demo webpack E2E (N8a): Next registers its own
      // next-swc-loader as a separate, later-in-array `oneOf` rule matching the same `.tsx`
      // test. Without `enforce: 'pre'` our loader and SWC's loader both match the same
      // request but webpack applies the later-array-position rule's loader BEFORE the
      // earlier one, so SWC transpiled JSX to `_jsxDEV(...)` calls before this loader ever
      // ran — tagJsxSource found zero JSXOpeningElement nodes (the JSX syntax was already
      // gone) and silently passed the untagged, already-compiled source through. `pre`
      // guarantees our loader runs in webpack's pre-loader stage, ahead of every
      // normal-stage rule including Next's, so it always sees raw JSX — matching Turbopack,
      // where forgeLoader is the only registered transform for these files.
      enforce: 'pre',
      use: [loaderRule],
    })
    return out
  }
}

/**
 * Next.js config wrapper: activates The Forge (loader registration + rewrites proxy to the
 * in-process sidecar) only under `phase-development-server`. Structural, not guarded — the
 * production build never sees any of this, matching `apply: 'serve'` on the Vite plugin.
 */
export function withForge(nextConfig?: NextConfig | NextConfigFn, options: WithForgeOptions = {}): NextConfigFn {
  const agent = options.agent ?? 'claude-code'
  const channelsFlag = options.experimentalChannels ?? false

  return async (phase, ctx) => {
    const resolved: NextConfig = typeof nextConfig === 'function' ? await nextConfig(phase, ctx) : (nextConfig ?? {})

    if (phase !== PHASE_DEVELOPMENT_SERVER) return resolved

    const root = resolveProjectRoot(process.cwd())
    const loaderRule = buildLoaderRule(root)

    const config: NextConfig = {
      ...resolved,
      // Adjudication 1 (supersedes the brief): ONLY the top-level `turbopack.rules` key —
      // NOT `experimental.turbo.rules`. The N0 spike proved `turbopack.rules` works
      // identically on Next 15.5 and 16; `experimental.turbo.rules` is a deprecated compat
      // shim that prints a runtime deprecation warning and has no installed-version case
      // where it is required. No version sniffing (YAGNI) — Next <15.3's turbopack path is
      // accepted-untested here; the webpack path below covers older/non-Turbopack setups.
      turbopack: {
        ...resolved.turbopack,
        rules: {
          ...resolved.turbopack?.rules,
          // No `as` key — matches the N0 spike's verified-working config
          // (docs/research/2026-07-04-next-spike-findings.md "Working `rules` syntax").
          // N4 shipped `as: '*.$1'` believing it was copied from the findings doc, but no
          // such syntax appears there and Turbopack has no `$1` glob-capture: on a real
          // `next dev` (Next 16.2.10) it makes every matched module unprocessable
          // ("Expected process result to be a module") — a FATAL Turbopack panic that
          // 500s every page. Caught by the N6 fixture smoke gate; unit tests only assert
          // config shape and cannot catch it.
          '*.{jsx,tsx}': { loaders: [loaderRule] },
        },
      },
      webpack: chainWebpack(resolved.webpack, loaderRule),
      rewrites: mergeRewritesWithSidecar(resolved.rewrites, agent, channelsFlag, root),
    }

    return config
  }
}

function mergeRewritesWithSidecar(
  userRewrites: (() => Promise<NextRewrites>) | undefined,
  agent: DispatchOpts['agent'],
  channelsFlag: boolean,
  root: string
): () => Promise<NextRewrites> {
  const withSidecar = async (): Promise<NextRewriteRule> => {
    const { port } = await ensureSidecar({ agent, channelsFlag, root })
    return { source: '/__the-forge/:path*', destination: `http://127.0.0.1:${port}/__the-forge/:path*` }
  }

  return async () => {
    let forgeRule: NextRewriteRule | null = null
    try {
      forgeRule = await withSidecar()
    } catch (err) {
      // Sidecar failure is never load-bearing (spec: Next dev continues unaffected) — warn
      // once per process and fall through to the user's rewrites untouched. Design mode is
      // simply absent that session; the app must still boot.
      if (!warnedSidecarFailure) {
        warnedSidecarFailure = true
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[the-forge] could not start — ${message}`)
      }
    }

    if (!userRewrites) return forgeRule ? [forgeRule] : []

    const existing = await userRewrites()
    if (!forgeRule) return existing

    if (Array.isArray(existing)) return [forgeRule, ...existing]
    return {
      ...existing,
      beforeFiles: [forgeRule, ...(existing.beforeFiles ?? [])],
    }
  }
}

export default withForge

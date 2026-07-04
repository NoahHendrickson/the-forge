// Node-free boundary: this module (and everything it imports) must never pull in a
// `node:*` module or anything that resolves to one. The Pages Router compiles
// `_app.tsx` — and therefore this component — straight into the browser bundle, so a
// Node import reachable from here breaks user builds, not just ours. `react` is the
// only allowed import.
import { createElement } from 'react'

/**
 * Renders the design-mode client under `next dev`; renders null in production builds.
 * Mount it once in the root layout (App Router) or `_app.tsx` (Pages Router).
 *
 * Server-component-safe AND client-bundle-safe: zero node imports in this module's
 * entire graph (enforced by the boundary test in tests/next/design-mode.test.ts).
 */
export function ForgeDesignMode(): ReturnType<typeof createElement> | null {
  // Checked per render (not hoisted to module scope): Next inlines `process.env.NODE_ENV`
  // as a literal in client bundles at the consuming app's build time, and on the server
  // it's set by `next dev`/`next start` — the same check is correct in both places, but
  // only if it's evaluated live rather than memoized at our own module's load time.
  if (process.env.NODE_ENV !== 'development') return null
  return createElement('script', { type: 'module', src: '/__the-forge/client.js' })
}

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Reads the built client bundle for createForgeMiddleware's CLIENT_JS_PATH route — the one
 * shared reader both framework entries pass in (PR #29 review: the per-entry copies were
 * byte-identical, and the sidecar's copy had a broken vitest fallback, src/next/../dist →
 * src/dist, which doesn't exist).
 *
 * Resolution is anchored to THIS module's own import.meta.url, which lands right in every
 * context: tsup inlines this helper into each built entry (dist/vite.js, dist/next.js), so in
 * the built package it resolves from dist/ where client.js sits next to it; under vitest it
 * resolves from src/server/, where client.js is never emitted, so fall back two levels up to
 * the built packages/the-forge/dist/client.js. Loud error naming the build command if neither
 * is found. Read per call, not cached — a rebuilt bundle lands on the next browser reload. */
export function readClientBundle(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const nextToModule = path.join(dir, 'client.js')
  const builtFallback = path.join(dir, '..', '..', 'dist', 'client.js')
  const clientPath = fs.existsSync(nextToModule)
    ? nextToModule
    : fs.existsSync(builtFallback)
      ? builtFallback
      : null
  if (!clientPath) {
    throw new Error(
      'the-forge: client bundle not found — run "npm run build -w forge-mode"'
    )
  }
  return fs.readFileSync(clientPath, 'utf8')
}

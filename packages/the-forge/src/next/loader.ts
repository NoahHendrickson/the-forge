import path from 'node:path'
import { tagJsxSource } from '../transform'

export interface ForgeLoaderOptions {
  /** resolveProjectRoot()'d git root, threaded in by withForge (N4) via the
   * bundler's per-rule loader options — NOT process.cwd(), since Turbopack/webpack
   * workers may not share the main process's cwd assumptions. */
  root: string
}

/** The webpack-loader-API subset that both webpack and Turbopack support for a
 * plain synchronous transform loader (verified in the N0 spike: both bundlers only
 * ever call `this.resourcePath`, `this.getOptions()`, and `this.callback(err, code, map)`
 * for this loader shape — no other context members are required). A ~5-line local
 * type instead of @types/webpack: zero new dependencies is a repo-wide constraint. */
export interface LoaderContext {
  resourcePath: string
  getOptions(): unknown
  callback(err: Error | null, content?: string, sourceMap?: unknown): void
}

/**
 * webpack-loader-API-compatible (the subset Turbopack supports): sync, uses
 * this.resourcePath + this.getOptions(); returns via this.callback(null, code, map).
 *
 * Mirrors the Vite `transform` hook's filtering intent byte-for-byte
 * (packages/the-forge/src/vite.ts transform(), ~lines 78-86): query-strip (loaders
 * don't receive query strings on resourcePath, but the test path is stripped for
 * parity), `/\.[jt]sx$/` test, node_modules skip, path.relative(root, file)
 * POSIX-normalized, and exclude any relative path that escapes root (`..`-prefixed)
 * or that is still absolute (Windows cross-drive) — those pass through untagged.
 */
export default function forgeLoader(this: LoaderContext, source: string): void {
  const options = this.getOptions() as ForgeLoaderOptions
  const [file] = this.resourcePath.split('?')

  if (!/\.[jt]sx$/.test(file)) return void this.callback(null, source, undefined)
  if (file.includes('/node_modules/')) return void this.callback(null, source, undefined)

  const rel = path.relative(options.root, file).split(path.sep).join('/')
  // path.relative yields an absolute path for cross-drive files on Windows — exclude those too
  if (rel.startsWith('..') || path.isAbsolute(rel)) return void this.callback(null, source, undefined)

  const result = tagJsxSource(source, rel)
  if (result === null) return void this.callback(null, source, undefined)

  // Turbopack (Next 16.2.10) FATALLY panics on a loader map whose `sources` holds a
  // project-root-relative path with no `sourcesContent` — it tries to read the source off
  // disk, mis-resolves the relative path, and dies with "reading file <...>/app — Is a
  // directory", 500ing every page (found by the N6 fixture smoke gate; bisected with
  // wrapper loaders: identical map with absolute `sources` + inline `sourcesContent`
  // renders fine). webpack accepts either shape. The Vite plugin keeps the relative
  // `sources` untouched (Vite resolves it against root; byte-for-byte unchanged is a
  // milestone constraint) — this normalization is Next-loader-only.
  const map = result.map as { sources: string[]; sourcesContent?: string[] }
  map.sources = [file]
  map.sourcesContent = [source]
  this.callback(null, result.code, map)
}

// Filesystem sniffing for `npx forge-mode init` (task A3). Pure given a directory
// listing — no process/child_process here, so it's trivially unit-testable against
// mkdtemp scaffolds. `init.ts` is the only caller.

import fs from 'node:fs'
import path from 'node:path'

export type Detected =
  | { kind: 'vite'; configPath: string }
  | { kind: 'next'; configPath: string; layout: { router: 'app' | 'pages'; path: string } | null }
  | { kind: 'none' }
  | { kind: 'both' }

// Fixed precedence order per framework — first match wins. Not a preference
// ranking of file formats in general, just a deterministic tie-break so detection
// never depends on directory-listing order.
const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']
const NEXT_CONFIG_NAMES = ['next.config.ts', 'next.config.mjs', 'next.config.js']

// App Router layout, then Pages Router _app, each checked at the project root
// before the src/-prefixed variant. App Router wins when a project somehow has
// both (rare, but "first match" keeps this deterministic rather than guessing).
const APP_LAYOUTS: Array<{ dir: string; file: string }> = [
  { dir: 'app', file: 'layout.tsx' },
  { dir: 'app', file: 'layout.jsx' },
  { dir: path.join('src', 'app'), file: 'layout.tsx' },
  { dir: path.join('src', 'app'), file: 'layout.jsx' },
]
const PAGES_APPS: Array<{ dir: string; file: string }> = [
  { dir: 'pages', file: '_app.tsx' },
  { dir: 'pages', file: '_app.jsx' },
  { dir: path.join('src', 'pages'), file: '_app.tsx' },
  { dir: path.join('src', 'pages'), file: '_app.jsx' },
]

function findFirst(cwd: string, names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(cwd, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function findLayout(cwd: string): { router: 'app' | 'pages'; path: string } | null {
  for (const { dir, file } of APP_LAYOUTS) {
    const candidate = path.join(cwd, dir, file)
    if (fs.existsSync(candidate)) return { router: 'app', path: candidate }
  }
  for (const { dir, file } of PAGES_APPS) {
    const candidate = path.join(cwd, dir, file)
    if (fs.existsSync(candidate)) return { router: 'pages', path: candidate }
  }
  return null
}

export function detectFramework(cwd: string): Detected {
  const viteConfig = findFirst(cwd, VITE_CONFIG_NAMES)
  const nextConfig = findFirst(cwd, NEXT_CONFIG_NAMES)

  if (viteConfig && nextConfig) return { kind: 'both' }
  if (viteConfig) return { kind: 'vite', configPath: viteConfig }
  if (nextConfig) return { kind: 'next', configPath: nextConfig, layout: findLayout(cwd) }
  return { kind: 'none' }
}

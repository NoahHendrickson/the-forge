import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ForgeDesignMode } from '../../src/design-mode/index'

const PACKAGE_DIR = path.resolve(__dirname, '../..')
const DIST_FILE = path.join(PACKAGE_DIR, 'dist', 'design-mode.js')

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ForgeDesignMode (component)', () => {
  it('dev: renders a <script type="module" src="/__the-forge/client.js"> element', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const el = ForgeDesignMode() as unknown as { type: string; props: Record<string, unknown> }
    expect(el).not.toBeNull()
    expect(el!.type).toBe('script')
    expect(el!.props).toEqual({ type: 'module', src: '/__the-forge/client.js' })
  })

  it('production: renders null', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(ForgeDesignMode()).toBeNull()
  })
})

describe('ForgeDesignMode boundary: dist/design-mode.js is node-free (spec load-bearing guarantee)', () => {
  // dist/ is guaranteed fresh by tests/global-setup.ts (built once before any worker
  // spawns) — standalone runs of this file included. The old build-if-missing check here
  // was a check-then-read race: it saw an existing dist, skipped building, then read while
  // plugin-load's worker was mid-`rm -rf dist` (the ~40%-of-runs root-gate flake).

  it('contains no node: specifier and no require() of a Node builtin', () => {
    const code = fs.readFileSync(DIST_FILE, 'utf8')
    expect(code).not.toMatch(/\bnode:/)
    // The artifact is pure ESM output with only `import { createElement } from "react"` as legitimate
    // external reference. ANY require() call is a regression that would break isomorphic safety.
    expect(code).not.toMatch(/require\(/)
  })

  it('preserves the literal process.env.NODE_ENV (esbuild must not inline it at OUR build time)', () => {
    const code = fs.readFileSync(DIST_FILE, 'utf8')
    expect(code).toContain('process.env.NODE_ENV')
  })

  it('the only import specifier in the built file is react', () => {
    const code = fs.readFileSync(DIST_FILE, 'utf8')
    const importLines = code
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) {
      const match = line.match(/from\s+['"]([^'"]+)['"]/)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('react')
    }
  })

  it('evaluates cleanly in a bare node ESM child process with no side-effectful node access', () => {
    const fileUrl = pathToFileURL(DIST_FILE).href
    const script = `import('${fileUrl}').then(m => { if (typeof m.ForgeDesignMode !== 'function') throw new Error('bad export') })`
    // cwd = package dir so `react` resolves via this package's own node_modules.
    execFileSync('node', ['--input-type=module', '--eval', script], { cwd: PACKAGE_DIR, stdio: 'pipe' })
  })
})

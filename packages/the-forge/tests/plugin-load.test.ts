import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import { theForge, CLIENT_ID } from '../src/vite'

describe('client bundle serving (integration)', () => {
  beforeAll(() => {
    // Build only when the artifact is missing (same guard as tests/mcp/e2e.test.ts and
    // tests/next/design-mode.test.ts). An unconditional build here was the root cause of the
    // suite's "dist-boundary flake": tsup's clean step deletes dist/ while a PARALLEL test
    // file's child process imports from it.
    const pkgDir = new URL('..', import.meta.url).pathname
    if (!fs.existsSync(path.join(pkgDir, 'dist', 'client.js'))) {
      execSync('npm run build', { cwd: pkgDir, stdio: 'pipe' })
    }
  }, 120_000)

  it('load(CLIENT_ID) returns the built client bundle', () => {
    const plugin = theForge()
    const code = (plugin.load as (id: string) => string | null)(CLIENT_ID)
    expect(code).toBeTruthy()
    // The client only *reads* the data-dc-source attribute (via el.dataset.dcSource);
    // the literal `data-dc-source` string is written by the server-side JSX transform
    // in dist/vite.js, not by the client bundle. Assert on `dcSource`, which is what
    // actually appears in dist/client.js and proves the right bundle was loaded.
    expect(code!).toContain('dcSource')
    expect((plugin.load as (id: string) => string | null)('/other')).toBeNull()
  })
})

import { execSync } from 'node:child_process'
import { describe, it, expect, beforeAll } from 'vitest'
import { theForge, CLIENT_ID } from '../src/index'

describe('client bundle serving (integration)', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' })
  }, 120_000)

  it('load(CLIENT_ID) returns the built client bundle', () => {
    const plugin = theForge()
    const code = (plugin.load as (id: string) => string | null)(CLIENT_ID)
    expect(code).toBeTruthy()
    // The client only *reads* the data-dc-source attribute (via el.dataset.dcSource);
    // the literal `data-dc-source` string is written by the server-side JSX transform
    // in dist/index.js, not by the client bundle. Assert on `dcSource`, which is what
    // actually appears in dist/client.js and proves the right bundle was loaded.
    expect(code!).toContain('dcSource')
    expect((plugin.load as (id: string) => string | null)('/other')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { readClientBundle } from '../../src/server/client-bundle'

describe('readClientBundle (shared dist/client.js reader — PR #29 review)', () => {
  // dist/ is guaranteed fresh by tests/global-setup.ts (built once before any worker
  // spawns). Never build from a test file — the build's `rm -rf dist` races every
  // parallel worker that reads dist/ artifacts.
  it('resolves the built client bundle from src (the vitest fallback path)', () => {
    // Under vitest this module resolves from src/server/, where client.js is never emitted —
    // the helper must fall back to packages/the-forge/dist/client.js. This is the exact path
    // shape the old per-entry copies got wrong for the sidecar (src/next/../dist → src/dist).
    const bundle = readClientBundle()
    expect(bundle).toBeTruthy()
    // `dcSource` is what actually appears in dist/client.js (see plugin-load.test.ts's
    // why-comment) and proves the right file was found.
    expect(bundle).toContain('dcSource')
  })
})

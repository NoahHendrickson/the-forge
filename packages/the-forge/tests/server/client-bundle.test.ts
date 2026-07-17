import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
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

  // GET /__the-forge/client.js is deliberately secret-ungated (CLAUDE.md: it's where the
  // browser bootstraps the per-start secret from) — its only defense against classic
  // `<script src="...">` exfiltration (which sends no Origin header, so the Origin-vs-Host
  // gate never sees it) is that the built bundle fails classic-script parsing: tsup's ESM
  // output ends in a trailing `export{...}`, which is a syntax error outside module context.
  // This property was incidental until the 2026-07-10 finding-4 review (security-finding4
  // client-bundle gate) killed the ungated Vite virtual module and routed serving through this
  // same middleware; this month's follow-up review (F1) flagged that nothing actually pins the
  // unparseability, so a future "drop the unused export" cleanup or a tsup format switch to
  // IIFE could silently re-arm the leak. Assert the real parse behavior via node:vm — NOT a
  // regex on the tail — because the vm parse failure IS the property being defended, not a
  // proxy for it.
  it('fails classic-script parsing (vm.Script) — the XSSI defense for the ungated secret route', () => {
    const bundle = readClientBundle()
    expect(() => new vm.Script(bundle)).toThrow()
  })
})

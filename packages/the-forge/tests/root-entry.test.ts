import { describe, it, expect } from 'vitest'

// The bare package root ("the-forge") has no meaningful export — Vite users import
// 'the-forge/vite', Next users import 'the-forge/next'. Importing the root by mistake
// must fail loudly at module evaluation with a message that names both subpaths, rather
// than silently resolving to whichever entry historically lived at src/index.ts.
describe('root entry', () => {
  it('throws on import, pointing at the vite and next subpaths', async () => {
    await expect(import('../src/index')).rejects.toThrow(
      "the-forge has no root export — import 'the-forge/vite' or 'the-forge/next'"
    )
  })
})

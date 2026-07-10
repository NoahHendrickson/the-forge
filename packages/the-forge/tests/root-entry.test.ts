import { describe, it, expect } from 'vitest'

// The bare package root ("forge-mode") has no meaningful export — Vite users import
// 'forge-mode/vite', Next users import 'forge-mode/next'. Importing the root by mistake
// must fail loudly at module evaluation with a message that names both subpaths, rather
// than silently resolving to whichever entry historically lived at src/index.ts.
describe('root entry', () => {
  it('throws on import, pointing at the vite and next subpaths', async () => {
    await expect(import('../src/index')).rejects.toThrow(
      "forge-mode has no root export — import 'forge-mode/vite' or 'forge-mode/next'"
    )
  })
})

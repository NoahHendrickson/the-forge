import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..', '..', '..')

// CLAUDE.md is the agent guide; AGENTS.md is the same guide under the filename other
// harnesses look for — today it's a symlink to CLAUDE.md, which is what keeps them in
// sync. This test pins the invariant so a future checkout/tool that materializes AGENTS.md
// as a real file can't silently diverge; if it fails, restore the symlink
// (`ln -sf CLAUDE.md AGENTS.md`) or re-copy CLAUDE.md over it.
describe('agent-guide sync', () => {
  it('AGENTS.md is byte-identical to CLAUDE.md', () => {
    const claude = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8')
    const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')
    expect(agents).toBe(claude)
  })
})

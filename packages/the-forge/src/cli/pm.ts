// Package-manager lockfile sniff + install-command construction for `npx the-forge
// init` (task A3). Pure — no child_process here; `init.ts` is the only caller and
// runs the resulting command through the injectable IO seam.

import fs from 'node:fs'
import path from 'node:path'

export type PM = 'npm' | 'pnpm' | 'yarn' | 'bun'

// Order matters only in that each lockfile uniquely identifies its own PM — ties
// are impossible in practice (a project has one lockfile), so precedence here is
// arbitrary and just needs to be deterministic.
const LOCKFILES: Array<{ name: string; pm: PM }> = [
  { name: 'package-lock.json', pm: 'npm' },
  { name: 'pnpm-lock.yaml', pm: 'pnpm' },
  { name: 'yarn.lock', pm: 'yarn' },
  { name: 'bun.lock', pm: 'bun' },
  { name: 'bun.lockb', pm: 'bun' },
]

// Walk cap mirrors resolveProjectRoot's GIT_WALK_MAX_LEVELS (server/setup.ts) and
// discoverEndpointFrom's DISCOVER_WALK_MAX_LEVELS (mcp/discover.ts) — same walk-up convention.
const LOCKFILE_WALK_MAX_LEVELS = 10

// In a pnpm/yarn/bun monorepo the lockfile lives at the repo root while `the-forge init` runs
// from the app dir — checking only cwd finds nothing and silently defaults to npm, which then
// installs the wrong package manager's artifacts alongside a lockfile it doesn't own. Walk up
// from cwd, checking each directory for a lockfile (same precedence order at every level); the
// nearest lockfile anywhere wins. Bounded by the `.git` directory (checked at that level too,
// then the walk stops there) or LOCKFILE_WALK_MAX_LEVELS, matching resolveProjectRoot/
// discoverEndpointFrom's walk-up so this doesn't wander past the project boundary.
export function detectPM(cwd: string): PM {
  let dir = path.resolve(cwd)
  for (let i = 0; i <= LOCKFILE_WALK_MAX_LEVELS; i++) {
    for (const { name, pm } of LOCKFILES) {
      if (fs.existsSync(path.join(dir, name))) return pm
    }
    if (fs.existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break // reached filesystem root
    dir = parent
  }
  return 'npm'
}

export function installCommand(pm: PM): { cmd: PM; args: string[] } {
  switch (pm) {
    case 'npm':
      return { cmd: 'npm', args: ['install', '-D', 'the-forge'] }
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-D', 'the-forge'] }
    case 'yarn':
      return { cmd: 'yarn', args: ['add', '-D', 'the-forge'] }
    case 'bun':
      return { cmd: 'bun', args: ['add', '-d', 'the-forge'] }
  }
}

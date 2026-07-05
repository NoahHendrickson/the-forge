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

export function detectPM(cwd: string): PM {
  for (const { name, pm } of LOCKFILES) {
    if (fs.existsSync(path.join(cwd, name))) return pm
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

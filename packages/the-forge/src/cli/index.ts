// The `the-forge` bin (task A3). Thin by design: this is the only file allowed
// to touch process.argv/exit or spawn a child process — everything else
// (detection, package-manager sniffing, orchestration) lives behind the pure
// functions and the injectable InitIO seam in detect.ts / pm.ts / init.ts, so
// those stay unit-testable without spawning anything.
//
// Dependency-free by design (zero new runtime dependencies is a headline package
// feature) — plain process.argv/console + node:child_process, no
// commander/prompts/chalk.

import { spawn } from 'node:child_process'
import { init, type InitIO } from './init'

const HELP = `the-forge
usage: npx the-forge init

Figma-style design mode for your running Vite or Next.js app.
Docs: https://github.com/NoahHendrickson/the-forge#readme`

// Real IO: runs the install command as a real child process, inheriting stdio
// so the user sees npm/pnpm/yarn/bun's own output live rather than us
// buffering and re-printing it.
const realIO: InitIO = {
  cwd: process.cwd(),
  log: (line: string) => console.log(line),
  run: (cmd: string, args: string[]) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'inherit' })
      child.on('error', () => resolve(1))
      child.on('close', (code) => resolve(code ?? 1))
    }),
}

async function main(argv: string[]): Promise<number> {
  const command = argv[2]

  if (command === 'init') {
    return init(realIO)
  }

  if (command === undefined) {
    console.log(HELP)
    return 0
  }

  console.log(HELP)
  return 2
}

main(process.argv).then((code) => process.exit(code))

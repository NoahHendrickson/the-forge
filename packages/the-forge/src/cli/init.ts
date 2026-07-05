// The `npx the-forge init` orchestrator (task A3). All effects — fs reads/writes
// aside, which are plain `fs` per the task brief — go through the injectable
// InitIO seam so tests never spawn a real process. index.ts supplies the real
// IO (child_process.spawn with stdio: 'inherit').
//
// Conservative-fallback rule (global constraint, load-bearing): every automated
// edit is delegated to src/cli/edits.ts, which itself only recognizes a small,
// fixture-pinned set of AST shapes. Anything else prints the exact manual
// snippet below (lifted verbatim from SETUP.md) and this orchestrator moves on
// to the next step — a wrong automated edit to a build config is strictly worse
// than a fallback message.

import fs from 'node:fs'
import path from 'node:path'
import { detectFramework } from './detect'
import { detectPM, installCommand } from './pm'
import { addViteForgePlugin, wrapNextConfigExport, mountDesignMode } from './edits'

export interface InitIO {
  cwd: string
  log: (line: string) => void
  /** spawn wrapper; resolves with the exit code. Tests stub it; index.ts passes a real
   * child_process.spawn(stdio: 'inherit') wrapper. */
  run: (cmd: string, args: string[]) => Promise<number>
}

// Manual fallback snippets — byte-exact copies of the code blocks in SETUP.md's
// "Wire it into the framework config" section. A later task adds a test that
// asserts these stay in sync with SETUP.md; keep them verbatim, don't
// reformat/retype them even for consistency with this file's own style.

const VITE_MANUAL_SNIPPET = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { theForge } from 'the-forge/vite'

export default defineConfig({
  plugins: [theForge(), react()],
})`

const NEXT_MANUAL_SNIPPET = `import { withForge } from 'the-forge/next'

export default withForge({
  // ...the project's existing next.config fields
})`

const NEXT_APP_ROUTER_MANUAL_SNIPPET = `// app/layout.tsx
import type { ReactNode } from 'react'
import { ForgeDesignMode } from 'the-forge/design-mode'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ForgeDesignMode />
      </body>
    </html>
  )
}`

const NEXT_PAGES_ROUTER_MANUAL_SNIPPET = `// pages/_app.tsx
import type { AppProps } from 'next/app'
import { ForgeDesignMode } from 'the-forge/design-mode'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <ForgeDesignMode />
    </>
  )
}`

const FOOTER = `Next steps:
  - Run your dev server (npm run dev, npx vite, or npx next dev).
  - Click the Design toggle in the bottom-right corner of the running app.
  - In an agent session at this project's root, type /forge-watch to stay linked.`

function isDependencyDeclared(cwd: string): boolean {
  const pkgPath = path.join(cwd, 'package.json')
  const raw = fs.readFileSync(pkgPath, 'utf8')
  const pkg: unknown = JSON.parse(raw)
  if (typeof pkg !== 'object' || pkg === null) return false
  const depTables = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  for (const table of depTables) {
    const deps = (pkg as Record<string, unknown>)[table]
    if (typeof deps === 'object' && deps !== null && 'the-forge' in deps) return true
  }
  return false
}

function printManual(io: InitIO, label: string, snippet: string): void {
  io.log(`[manual] ${label}`)
  io.log(snippet)
}

async function runInstallStep(io: InitIO): Promise<void> {
  if (isDependencyDeclared(io.cwd)) {
    io.log('[skip] dependency — the-forge already in package.json')
    return
  }

  const { cmd, args } = installCommand(detectPM(io.cwd))
  const exitCode = await io.run(cmd, args)
  if (exitCode === 0) {
    io.log('[done] dependency — installed the-forge')
    return
  }

  io.log(`[manual] dependency install failed (exit ${exitCode}) — run this yourself:`)
  io.log(`  ${cmd} ${args.join(' ')}`)
  io.log('  # or: npm install -D the-forge')
}

function runViteConfigStep(io: InitIO, configPath: string): void {
  const source = fs.readFileSync(configPath, 'utf8')
  const result = addViteForgePlugin(source)
  if (result.kind === 'already') {
    io.log('[skip] vite.config — the-forge already wired in')
    return
  }
  if (result.kind === 'fallback') {
    io.log(`[manual] vite.config could not be edited automatically (${result.reason}) — add this yourself:`)
    io.log(VITE_MANUAL_SNIPPET)
    return
  }
  fs.writeFileSync(configPath, result.code)
  io.log('[done] vite.config — added theForge() plugin')
}

function runNextConfigStep(io: InitIO, configPath: string): void {
  const source = fs.readFileSync(configPath, 'utf8')
  const result = wrapNextConfigExport(source)
  if (result.kind === 'already') {
    io.log('[skip] next.config — the-forge already wired in')
    return
  }
  if (result.kind === 'fallback') {
    io.log(`[manual] next.config could not be edited automatically (${result.reason}) — add this yourself:`)
    io.log(NEXT_MANUAL_SNIPPET)
    return
  }
  fs.writeFileSync(configPath, result.code)
  io.log('[done] next.config — wrapped export with withForge()')
}

function runMountStep(io: InitIO, layout: { router: 'app' | 'pages'; path: string } | null): void {
  if (!layout) {
    io.log('[manual] no root layout / _app found — mount ForgeDesignMode yourself:')
    io.log(NEXT_APP_ROUTER_MANUAL_SNIPPET)
    io.log(NEXT_PAGES_ROUTER_MANUAL_SNIPPET)
    return
  }

  const source = fs.readFileSync(layout.path, 'utf8')
  const result = mountDesignMode(source, layout.router)
  if (result.kind === 'already') {
    io.log('[skip] ForgeDesignMode — already mounted')
    return
  }
  if (result.kind === 'fallback') {
    const snippet = layout.router === 'app' ? NEXT_APP_ROUTER_MANUAL_SNIPPET : NEXT_PAGES_ROUTER_MANUAL_SNIPPET
    io.log(`[manual] ${path.basename(layout.path)} could not be edited automatically (${result.reason}) — add this yourself:`)
    io.log(snippet)
    return
  }
  fs.writeFileSync(layout.path, result.code)
  io.log('[done] ForgeDesignMode — mounted in ' + path.basename(layout.path))
}

export async function init(io: InitIO): Promise<number> {
  if (!fs.existsSync(path.join(io.cwd, 'package.json'))) {
    io.log('No package.json found here. See SETUP.md: https://github.com/NoahHendrickson/the-forge/blob/main/SETUP.md')
    return 1
  }

  const detected = detectFramework(io.cwd)

  if (detected.kind === 'none') {
    io.log('No Vite or Next.js config found here. See SETUP.md: https://github.com/NoahHendrickson/the-forge/blob/main/SETUP.md')
    return 1
  }

  if (detected.kind === 'both') {
    io.log('Found both a Vite and a Next.js config here — run init in the app directory instead of a monorepo root.')
    return 1
  }

  await runInstallStep(io)

  if (detected.kind === 'vite') {
    runViteConfigStep(io, detected.configPath)
  } else {
    runNextConfigStep(io, detected.configPath)
    runMountStep(io, detected.layout)
  }

  io.log(FOOTER)
  return 0
}

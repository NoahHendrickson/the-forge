import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { init, type InitIO } from '../../src/cli/init'
import {
  VITE_MANUAL_SNIPPET,
  NEXT_MANUAL_SNIPPET,
  NEXT_APP_ROUTER_MANUAL_SNIPPET,
  NEXT_PAGES_ROUTER_MANUAL_SNIPPET,
} from '../../src/cli/init'

let dir: string
let lines: string[]
let runCalls: Array<{ cmd: string; args: string[] }>
let runResult: number

function makeIO(): InitIO {
  return {
    cwd: dir,
    log: (line: string) => lines.push(line),
    run: async (cmd: string, args: string[]) => {
      runCalls.push({ cmd, args })
      return runResult
    },
  }
}

function writeJSON(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-init-'))
  lines = []
  runCalls = []
  runResult = 0
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('init — preconditions', () => {
  it('errors when there is no package.json', async () => {
    const code = await init(makeIO())
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('SETUP.md')
  })

  it('errors when neither vite nor next config is detected', async () => {
    writeJSON(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} })
    const code = await init(makeIO())
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('SETUP.md')
  })

  it('errors when both a vite and a next config are detected', async () => {
    writeJSON(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} })
    fs.writeFileSync(path.join(dir, 'vite.config.ts'), 'export default {}\n')
    fs.writeFileSync(path.join(dir, 'next.config.ts'), 'export default {}\n')
    const code = await init(makeIO())
    expect(code).toBe(1)
    expect(lines.join('\n').toLowerCase()).toContain('app directory')
  })
})

describe('init — Vite happy path', () => {
  beforeEach(() => {
    writeJSON(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} })
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
    fs.writeFileSync(
      path.join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`
    )
  })

  it('edits the config, installs with the lockfile-matched pm, and prints the footer', async () => {
    const code = await init(makeIO())
    expect(code).toBe(0)

    const config = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')
    expect(config).toContain(`import { theForge } from 'forge-mode/vite'`)
    expect(config).toContain('plugins: [theForge(), react()],')

    expect(runCalls).toEqual([{ cmd: 'npm', args: ['install', '-D', 'forge-mode'] }])

    const out = lines.join('\n')
    expect(out).toContain('[done]')
    expect(out).toContain('forge-watch')
  })
})

describe('init — Next happy path (App Router)', () => {
  beforeEach(() => {
    writeJSON(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} })
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '')
    fs.writeFileSync(
      path.join(dir, 'next.config.ts'),
      `const nextConfig = {}\n\nexport default nextConfig\n`
    )
    fs.mkdirSync(path.join(dir, 'app'))
    fs.writeFileSync(
      path.join(dir, 'app', 'layout.tsx'),
      `import type { ReactNode } from 'react'\n\nexport default function RootLayout({ children }: { children: ReactNode }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n      </body>\n    </html>\n  )\n}\n`
    )
  })

  it('wraps the config, mounts ForgeDesignMode, installs with yarn, prints footer', async () => {
    const code = await init(makeIO())
    expect(code).toBe(0)

    const config = fs.readFileSync(path.join(dir, 'next.config.ts'), 'utf8')
    expect(config).toContain(`import { withForge } from 'forge-mode/next'`)
    expect(config).toContain('withForge(nextConfig)')

    const layout = fs.readFileSync(path.join(dir, 'app', 'layout.tsx'), 'utf8')
    expect(layout).toContain(`import { ForgeDesignMode } from 'forge-mode/design-mode'`)
    expect(layout).toContain('<ForgeDesignMode />')

    expect(runCalls).toEqual([{ cmd: 'yarn', args: ['add', '-D', 'forge-mode'] }])

    const out = lines.join('\n')
    expect(out).toContain('[done]')
    expect(out).toContain('forge-watch')
  })
})

describe('init — exotic config falls back', () => {
  beforeEach(() => {
    writeJSON(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} })
    fs.writeFileSync(
      path.join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\n\nexport default defineConfig(() => ({\n  plugins: [],\n}))\n`
    )
  })

  it('leaves the config file untouched on disk and prints [manual]', async () => {
    const before = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')
    const code = await init(makeIO())
    expect(code).toBe(0)

    const after = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')
    expect(after).toBe(before)

    const out = lines.join('\n')
    expect(out).toContain('[manual]')
    // The manual snippet must be the real Vite setup snippet from SETUP.md.
    expect(out).toContain(`import { theForge } from 'forge-mode/vite'`)
  })
})

describe('init — Next with no detected layout falls back to manual mount', () => {
  beforeEach(() => {
    writeJSON(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} })
    fs.writeFileSync(path.join(dir, 'next.config.ts'), `export default {}\n`)
  })

  it('wraps the config but prints [manual] for the mount step', async () => {
    const code = await init(makeIO())
    expect(code).toBe(0)

    const config = fs.readFileSync(path.join(dir, 'next.config.ts'), 'utf8')
    expect(config).toContain(`import { withForge } from 'forge-mode/next'`)

    const out = lines.join('\n')
    expect(out).toContain('[manual]')
    expect(out).toContain(`import { ForgeDesignMode } from 'forge-mode/design-mode'`)
  })
})

describe('init — failed install', () => {
  beforeEach(() => {
    writeJSON(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} })
    fs.writeFileSync(
      path.join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [],\n})\n`
    )
    runResult = 1
  })

  it('continues to the config edit and exits 0 with a manual install line', async () => {
    const code = await init(makeIO())
    expect(code).toBe(0)

    const config = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')
    expect(config).toContain(`import { theForge } from 'forge-mode/vite'`)

    const out = lines.join('\n')
    expect(out).toContain('[manual]')
    expect(out).toContain('npm install -D forge-mode')
    expect(out).toContain('[done]') // config edit still ran
  })
})

describe('init — malformed package.json', () => {
  it('does not throw, prints the manual install line plus a parse note, and still edits the config', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `{\n  "name": "x",\n  "devDependencies": {},\n}\n` // trailing comma — invalid JSON
    )
    fs.writeFileSync(
      path.join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [],\n})\n`
    )

    let code: number | undefined
    let thrown: unknown
    try {
      code = await init(makeIO())
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeUndefined()
    expect(code).toBe(0)

    const config = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')
    expect(config).toContain(`import { theForge } from 'forge-mode/vite'`)

    expect(runCalls).toEqual([])

    const out = lines.join('\n')
    expect(out).toContain('[manual]')
    expect(out.toLowerCase()).toContain('could not be parsed')
    expect(out).toContain('npm install -D forge-mode')
    expect(out).toContain('[done]') // config edit still ran
  })
})

// Sync check between the CLI's manual-fallback snippets and SETUP.md's own code blocks
// (task A6): SETUP.md is the single source, and init.ts's constants are byte-identical
// copies used for the [manual] fallback output. This only proves anything inside the git
// checkout — a published tarball never ships SETUP.md, so skip cleanly there rather than
// failing on a file that's expected to be absent.
const repoRoot = path.resolve(__dirname, '../../../..')
const setupMdPath = path.join(repoRoot, 'SETUP.md')
const hasSetupMd = fs.existsSync(setupMdPath)

describe.skipIf(!hasSetupMd)('init — manual snippets stay in sync with SETUP.md', () => {
  const setupMd = hasSetupMd ? fs.readFileSync(setupMdPath, 'utf8') : ''

  it('SETUP.md contains the Vite manual snippet verbatim', () => {
    expect(setupMd).toContain(VITE_MANUAL_SNIPPET)
  })

  it('SETUP.md contains the Next config manual snippet verbatim', () => {
    expect(setupMd).toContain(NEXT_MANUAL_SNIPPET)
  })

  it('SETUP.md contains the Next App Router mount snippet verbatim', () => {
    expect(setupMd).toContain(NEXT_APP_ROUTER_MANUAL_SNIPPET)
  })

  it('SETUP.md contains the Next Pages Router mount snippet verbatim', () => {
    expect(setupMd).toContain(NEXT_PAGES_ROUTER_MANUAL_SNIPPET)
  })
})

describe('init — dependency skip', () => {
  it('skips the install step when forge-mode is already a dependency', async () => {
    writeJSON(path.join(dir, 'package.json'), {
      name: 'x',
      devDependencies: { 'forge-mode': '^0.1.0' },
    })
    fs.writeFileSync(
      path.join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [],\n})\n`
    )
    const code = await init(makeIO())
    expect(code).toBe(0)
    expect(runCalls).toEqual([])
    expect(lines.join('\n')).toContain('[skip]')
  })

  it('also recognizes forge-mode in dependencies (not just devDependencies)', async () => {
    writeJSON(path.join(dir, 'package.json'), {
      name: 'x',
      dependencies: { 'forge-mode': '^0.1.0' },
    })
    fs.writeFileSync(
      path.join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [],\n})\n`
    )
    const code = await init(makeIO())
    expect(code).toBe(0)
    expect(runCalls).toEqual([])
  })
})

describe('init — idempotency', () => {
  it('running init twice: second run is all [skip], files byte-identical', async () => {
    writeJSON(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} })
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
    fs.writeFileSync(
      path.join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`
    )

    const first = await init(makeIO())
    expect(first).toBe(0)
    const configAfterFirst = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')
    const pkgAfterFirst = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')

    // Simulate the install step having actually landed the dependency, since
    // the stubbed `run` doesn't touch package.json.
    const pkg = JSON.parse(pkgAfterFirst)
    pkg.devDependencies['forge-mode'] = '^0.1.0'
    writeJSON(path.join(dir, 'package.json'), pkg)
    const pkgForSecondRun = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')

    lines = []
    runCalls = []
    const second = await init(makeIO())
    expect(second).toBe(0)

    const configAfterSecond = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')
    const pkgAfterSecond = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')

    expect(configAfterSecond).toBe(configAfterFirst)
    expect(pkgAfterSecond).toBe(pkgForSecondRun)
    expect(runCalls).toEqual([])

    const out = lines.join('\n')
    expect(out).not.toContain('[done]')
    expect(out).toContain('[skip]')
  })
})

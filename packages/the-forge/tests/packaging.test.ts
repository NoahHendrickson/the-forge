import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Manifest invariants only — tarball-content assertions live in
// scripts/check-prod-clean.sh because they need a built dist/. This file must
// pass on a clean checkout (no dist/ present).
const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

describe('package.json publish readiness', () => {
  it('exposes a the-forge bin pointing at dist/cli.js', () => {
    expect(pkg.bin).toEqual({ 'the-forge': './dist/cli.js' })
  })

  it('main and types point at the root stub dist files', () => {
    expect(pkg.main).toBe('./dist/index.js')
    expect(pkg.types).toBe('./dist/index.d.ts')
  })

  it('files is exactly ["dist"]', () => {
    expect(pkg.files).toEqual(['dist'])
  })

  it('every exports subpath maps into dist/', () => {
    expect(Object.keys(pkg.exports).length).toBeGreaterThan(0)
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      const conditions = entry as Record<string, string>
      for (const [condition, target] of Object.entries(conditions)) {
        expect(
          target.startsWith('./dist/'),
          `exports["${subpath}"].${condition} = "${target}" must map into dist/`
        ).toBe(true)
      }
    }
  })

  it('version is a valid semver >= 0.1.0', () => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(pkg.version)
    expect(match, `version "${pkg.version}" must be valid semver`).not.toBeNull()
    const [major, minor, patch] = match!.slice(1).map(Number)
    const actual = major * 1_000_000 + minor * 1_000 + patch
    const minimum = 0 * 1_000_000 + 1 * 1_000 + 0
    expect(actual, `version "${pkg.version}" must be >= 0.1.0`).toBeGreaterThanOrEqual(minimum)
  })

  it('declares MIT license', () => {
    expect(pkg.license).toBe('MIT')
  })

  it('declares a repository (with monorepo directory) and homepage', () => {
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/NoahHendrickson/the-forge.git',
      directory: 'packages/the-forge',
    })
    expect(pkg.homepage).toBe('https://github.com/NoahHendrickson/the-forge#readme')
  })

  // npm renders the README found inside the tarball, and npm pack only picks it
  // up from the package directory itself — the repo-root README never ships.
  // Without this file the npm page says "This package does not have a README",
  // which kills the paste-the-npm-link-to-your-agent install flow.
  it('has a package-local README.md for the npm page', () => {
    const readmePath = path.join(path.dirname(pkgPath), 'README.md')
    expect(fs.existsSync(readmePath), 'packages/the-forge/README.md must exist').toBe(true)
    const readme = fs.readFileSync(readmePath, 'utf8')
    expect(readme).toContain('npx the-forge init')
    // Agents reading the npm page need an absolute link — relative README links
    // are only rewritten by npm's renderer, not by registry API consumers.
    expect(readme).toContain('https://github.com/NoahHendrickson/the-forge/blob/main/SETUP.md')
  })

  it('guards publish with a prepublishOnly build', () => {
    // "files": ["dist"] means a stale or missing dist/ publishes silently
    // without this; the build script rm -rf's dist first, so this always
    // ships a fresh compile.
    expect(pkg.scripts.prepublishOnly).toBe('npm run build')
  })
})

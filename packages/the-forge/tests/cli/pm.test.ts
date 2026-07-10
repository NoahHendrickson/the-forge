import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { detectPM, installCommand } from '../../src/cli/pm'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pm-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('detectPM', () => {
  it('defaults to npm when no lockfile is present', () => {
    expect(detectPM(dir)).toBe('npm')
  })

  it('detects npm from package-lock.json', () => {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '')
    expect(detectPM(dir)).toBe('npm')
  })

  it('detects pnpm from pnpm-lock.yaml', () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
    expect(detectPM(dir)).toBe('pnpm')
  })

  it('detects yarn from yarn.lock', () => {
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '')
    expect(detectPM(dir)).toBe('yarn')
  })

  it('detects bun from bun.lock', () => {
    fs.writeFileSync(path.join(dir, 'bun.lock'), '')
    expect(detectPM(dir)).toBe('bun')
  })

  it('detects bun from bun.lockb', () => {
    fs.writeFileSync(path.join(dir, 'bun.lockb'), '')
    expect(detectPM(dir)).toBe('bun')
  })

  it('walks up to a lockfile at the monorepo root when the nested app dir has none', () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
    const appDir = path.join(dir, 'apps', 'web')
    fs.mkdirSync(appDir, { recursive: true })
    expect(detectPM(appDir)).toBe('pnpm')
  })

  it('stops walking at a .git directory — a lockfile above it is not found', () => {
    const repoDir = path.join(dir, 'repo')
    const appDir = path.join(repoDir, 'apps', 'web')
    fs.mkdirSync(appDir, { recursive: true })
    fs.mkdirSync(path.join(repoDir, '.git'))
    // Lockfile lives ABOVE the .git boundary — must not be found once the walk hits .git.
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '')
    expect(detectPM(appDir)).toBe('npm')
  })

  it('still checks lockfiles in the .git directory itself before stopping', () => {
    const repoDir = path.join(dir, 'repo')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(path.join(repoDir, '.git'))
    fs.writeFileSync(path.join(repoDir, 'pnpm-lock.yaml'), '')
    expect(detectPM(repoDir)).toBe('pnpm')
  })

  it('prefers a lockfile in cwd over one further up the tree', () => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
    const appDir = path.join(dir, 'apps', 'web')
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'yarn.lock'), '')
    expect(detectPM(appDir)).toBe('yarn')
  })
})

describe('installCommand', () => {
  it('builds npm install -D', () => {
    expect(installCommand('npm')).toEqual({ cmd: 'npm', args: ['install', '-D', 'forge-mode'] })
  })

  it('builds pnpm add -D', () => {
    expect(installCommand('pnpm')).toEqual({ cmd: 'pnpm', args: ['add', '-D', 'forge-mode'] })
  })

  it('builds yarn add -D', () => {
    expect(installCommand('yarn')).toEqual({ cmd: 'yarn', args: ['add', '-D', 'forge-mode'] })
  })

  it('builds bun add -d', () => {
    expect(installCommand('bun')).toEqual({ cmd: 'bun', args: ['add', '-d', 'forge-mode'] })
  })
})

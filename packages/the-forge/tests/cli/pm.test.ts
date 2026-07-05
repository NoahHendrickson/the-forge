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
})

describe('installCommand', () => {
  it('builds npm install -D', () => {
    expect(installCommand('npm')).toEqual({ cmd: 'npm', args: ['install', '-D', 'the-forge'] })
  })

  it('builds pnpm add -D', () => {
    expect(installCommand('pnpm')).toEqual({ cmd: 'pnpm', args: ['add', '-D', 'the-forge'] })
  })

  it('builds yarn add -D', () => {
    expect(installCommand('yarn')).toEqual({ cmd: 'yarn', args: ['add', '-D', 'the-forge'] })
  })

  it('builds bun add -d', () => {
    expect(installCommand('bun')).toEqual({ cmd: 'bun', args: ['add', '-d', 'the-forge'] })
  })
})

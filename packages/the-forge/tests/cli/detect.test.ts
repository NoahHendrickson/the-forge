import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { detectFramework } from '../../src/cli/detect'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-detect-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('detectFramework', () => {
  it('returns none when no config file is present', () => {
    expect(detectFramework(dir)).toEqual({ kind: 'none' })
  })

  it('detects a vite.config.ts', () => {
    fs.writeFileSync(path.join(dir, 'vite.config.ts'), '')
    expect(detectFramework(dir)).toEqual({
      kind: 'vite',
      configPath: path.join(dir, 'vite.config.ts'),
    })
  })

  it('prefers vite.config.ts over other vite extensions, in fixed order', () => {
    fs.writeFileSync(path.join(dir, 'vite.config.mts'), '')
    fs.writeFileSync(path.join(dir, 'vite.config.js'), '')
    fs.writeFileSync(path.join(dir, 'vite.config.mjs'), '')
    // ts not present, so mts should win per the documented order.
    expect(detectFramework(dir)).toEqual({
      kind: 'vite',
      configPath: path.join(dir, 'vite.config.mts'),
    })
  })

  it('detects a next.config.ts with no layout present', () => {
    fs.writeFileSync(path.join(dir, 'next.config.ts'), '')
    expect(detectFramework(dir)).toEqual({
      kind: 'next',
      configPath: path.join(dir, 'next.config.ts'),
      layout: null,
    })
  })

  it('detects a next.config.mjs / .js in fixed order', () => {
    fs.writeFileSync(path.join(dir, 'next.config.mjs'), '')
    fs.writeFileSync(path.join(dir, 'next.config.js'), '')
    const result = detectFramework(dir)
    expect(result.kind).toBe('next')
    if (result.kind !== 'next') throw new Error('unreachable')
    expect(result.configPath).toBe(path.join(dir, 'next.config.mjs'))
  })

  it('detects an app-router layout at app/layout.tsx', () => {
    fs.writeFileSync(path.join(dir, 'next.config.ts'), '')
    fs.mkdirSync(path.join(dir, 'app'))
    fs.writeFileSync(path.join(dir, 'app', 'layout.tsx'), '')
    expect(detectFramework(dir)).toEqual({
      kind: 'next',
      configPath: path.join(dir, 'next.config.ts'),
      layout: { router: 'app', path: path.join(dir, 'app', 'layout.tsx') },
    })
  })

  it('detects a src/-prefixed app-router layout', () => {
    fs.writeFileSync(path.join(dir, 'next.config.ts'), '')
    fs.mkdirSync(path.join(dir, 'src', 'app'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'app', 'layout.jsx'), '')
    expect(detectFramework(dir)).toEqual({
      kind: 'next',
      configPath: path.join(dir, 'next.config.ts'),
      layout: { router: 'app', path: path.join(dir, 'src', 'app', 'layout.jsx') },
    })
  })

  it('detects a pages-router _app at pages/_app.tsx', () => {
    fs.writeFileSync(path.join(dir, 'next.config.ts'), '')
    fs.mkdirSync(path.join(dir, 'pages'))
    fs.writeFileSync(path.join(dir, 'pages', '_app.tsx'), '')
    expect(detectFramework(dir)).toEqual({
      kind: 'next',
      configPath: path.join(dir, 'next.config.ts'),
      layout: { router: 'pages', path: path.join(dir, 'pages', '_app.tsx') },
    })
  })

  it('detects a src/-prefixed pages-router _app', () => {
    fs.writeFileSync(path.join(dir, 'next.config.ts'), '')
    fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'pages', '_app.jsx'), '')
    expect(detectFramework(dir)).toEqual({
      kind: 'next',
      configPath: path.join(dir, 'next.config.ts'),
      layout: { router: 'pages', path: path.join(dir, 'src', 'pages', '_app.jsx') },
    })
  })

  it('prefers app router over pages router when both are present', () => {
    fs.writeFileSync(path.join(dir, 'next.config.ts'), '')
    fs.mkdirSync(path.join(dir, 'app'))
    fs.writeFileSync(path.join(dir, 'app', 'layout.tsx'), '')
    fs.mkdirSync(path.join(dir, 'pages'))
    fs.writeFileSync(path.join(dir, 'pages', '_app.tsx'), '')
    const result = detectFramework(dir)
    expect(result.kind).toBe('next')
    if (result.kind !== 'next') throw new Error('unreachable')
    expect(result.layout).toEqual({ router: 'app', path: path.join(dir, 'app', 'layout.tsx') })
  })

  it('returns both when a vite config and a next config are both present', () => {
    fs.writeFileSync(path.join(dir, 'vite.config.ts'), '')
    fs.writeFileSync(path.join(dir, 'next.config.ts'), '')
    expect(detectFramework(dir)).toEqual({ kind: 'both' })
  })
})

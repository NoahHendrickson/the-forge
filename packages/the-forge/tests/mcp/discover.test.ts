import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { discoverEndpoint, discoverEndpointFrom } from '../../src/mcp/discover'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-discover-'))
})

function writeFixture(name: string, data: unknown, mtimeOffsetMs = 0): void {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, JSON.stringify(data))
  if (mtimeOffsetMs) {
    const t = new Date(Date.now() + mtimeOffsetMs)
    fs.utimesSync(filePath, t, t)
  }
}

describe('discoverEndpoint', () => {
  it('returns null for an empty directory', () => {
    expect(discoverEndpoint(dir)).toBeNull()
  })

  it('returns null when the directory does not exist', () => {
    expect(discoverEndpoint(path.join(dir, 'nonexistent'))).toBeNull()
  })

  it('skips entries whose pid is dead', () => {
    writeFixture('endpoint-999999999.json', { port: 4000, host: '127.0.0.1', pid: 999999999 })
    expect(discoverEndpoint(dir)).toBeNull()
  })

  it('picks a live-pid entry', () => {
    writeFixture(`endpoint-${process.pid}.json`, { port: 5001, host: '127.0.0.1', pid: process.pid })
    expect(discoverEndpoint(dir)).toEqual({ port: 5001, host: '127.0.0.1' })
  })

  it('ignores dead entries and picks the live one among several', () => {
    writeFixture('endpoint-999999999.json', { port: 4000, host: '127.0.0.1', pid: 999999999 })
    writeFixture(`endpoint-${process.pid}.json`, { port: 5001, host: '127.0.0.1', pid: process.pid })
    expect(discoverEndpoint(dir)).toEqual({ port: 5001, host: '127.0.0.1' })
  })

  it('uses legacy endpoint.json only when no per-pid files exist', () => {
    writeFixture('endpoint.json', { port: 6000, host: '127.0.0.1', pid: process.pid })
    expect(discoverEndpoint(dir)).toEqual({ port: 6000, host: '127.0.0.1' })
  })

  it('prefers per-pid files over legacy endpoint.json', () => {
    writeFixture('endpoint.json', { port: 6000, host: '127.0.0.1', pid: process.pid })
    writeFixture(`endpoint-${process.pid}.json`, { port: 5001, host: '127.0.0.1', pid: process.pid })
    expect(discoverEndpoint(dir)).toEqual({ port: 5001, host: '127.0.0.1' })
  })

  it('picks the most recently modified live entry among per-pid files', () => {
    // Both use the same live pid (process.pid) since we can't spawn two real
    // live pids easily in a unit test — the point under test is mtime ordering.
    writeFixture('endpoint-11111.json', { port: 7000, host: '127.0.0.1', pid: process.pid }, 0)
    writeFixture(`endpoint-${process.pid}.json`, { port: 8000, host: '127.0.0.1', pid: process.pid }, 5000)
    expect(discoverEndpoint(dir)).toEqual({ port: 8000, host: '127.0.0.1' })
  })

  it('returns null when a per-pid file is malformed', () => {
    fs.writeFileSync(path.join(dir, 'endpoint-123.json'), '{not json')
    expect(discoverEndpoint(dir)).toBeNull()
  })

  it('includes the secret when present in the endpoint file', () => {
    writeFixture(`endpoint-${process.pid}.json`, { port: 5001, host: '127.0.0.1', pid: process.pid, secret: 'sekret' })
    expect(discoverEndpoint(dir)).toEqual({ port: 5001, host: '127.0.0.1', secret: 'sekret' })
  })

  it('omits secret when absent from the endpoint file', () => {
    writeFixture(`endpoint-${process.pid}.json`, { port: 5001, host: '127.0.0.1', pid: process.pid })
    const result = discoverEndpoint(dir)
    expect(result).not.toBeNull()
    expect(result!.secret).toBeUndefined()
  })
})

describe('discoverEndpointFrom (walk-up discovery)', () => {
  function writeEndpoint(baseDir: string, port: number, pid = process.pid): void {
    const forgeDir = path.join(baseDir, '.the-forge')
    fs.mkdirSync(forgeDir, { recursive: true })
    fs.writeFileSync(path.join(forgeDir, `endpoint-${pid}.json`), JSON.stringify({ port, host: '127.0.0.1', pid }))
  }

  it('finds the project endpoint from a nested subdirectory (the git-root gotcha, removed)', () => {
    writeEndpoint(dir, 5001)
    const nested = path.join(dir, 'packages', 'app', 'src')
    fs.mkdirSync(nested, { recursive: true })
    expect(discoverEndpointFrom(nested)).toEqual({ port: 5001, host: '127.0.0.1' })
  })

  it('finds the endpoint when cwd IS the project root (the old behavior, unchanged)', () => {
    writeEndpoint(dir, 5001)
    expect(discoverEndpointFrom(dir)).toEqual({ port: 5001, host: '127.0.0.1' })
  })

  it('nearest directory wins — a nested project beats an ancestor project', () => {
    writeEndpoint(dir, 5001) // outer project
    const inner = path.join(dir, 'apps', 'inner')
    writeEndpoint(inner, 5002) // inner project
    const cwd = path.join(inner, 'src')
    fs.mkdirSync(cwd, { recursive: true })
    expect(discoverEndpointFrom(cwd)).toEqual({ port: 5002, host: '127.0.0.1' })
  })

  it('a dead endpoint in a nearer directory does not stop the walk — the live ancestor wins', () => {
    writeEndpoint(dir, 5001) // live ancestor
    const inner = path.join(dir, 'apps', 'inner')
    writeEndpoint(inner, 4000, 999999999) // dead pid
    const cwd = path.join(inner, 'src')
    fs.mkdirSync(cwd, { recursive: true })
    expect(discoverEndpointFrom(cwd)).toEqual({ port: 5001, host: '127.0.0.1' })
  })

  it('returns null when no .the-forge with a live endpoint exists within the walk cap', () => {
    // 11 levels of nesting puts the (endpoint-less) tmpdir root beyond the 10-level cap anyway;
    // no endpoint exists anywhere under it.
    const segments = Array.from({ length: 11 }, (_, i) => `d${i}`)
    const nested = path.join(dir, ...segments)
    fs.mkdirSync(nested, { recursive: true })
    expect(discoverEndpointFrom(nested)).toBeNull()
  })

  it('does not find an endpoint more than 10 levels up (bounded walk)', () => {
    writeEndpoint(dir, 5001)
    const segments = Array.from({ length: 11 }, (_, i) => `d${i}`)
    const nested = path.join(dir, ...segments)
    fs.mkdirSync(nested, { recursive: true })
    expect(discoverEndpointFrom(nested)).toBeNull()
  })
})

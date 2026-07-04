import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { discoverEndpoint } from '../../src/mcp/discover'

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
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import http, { type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PACKAGE_DIR = path.resolve(__dirname, '../..')
const MCP_BIN = path.join(PACKAGE_DIR, 'dist', 'mcp.js')

const STUB_ITEM = { id: 'stub-1', markdown: '## Stub change\nDo the thing.', createdAt: '2026-01-01T00:00:00.000Z' }

let stubServer: Server
let stubPort: number
let claimedIds: string[] = []
let markCalls: Array<{ ids: string[]; status: string; note?: string }> = []

let tempDir: string
let child: ChildProcessWithoutNullStreams
let stdoutBuf = ''
const pending = new Map<number, { resolve: (v: unknown) => void }>()

function send(msg: unknown): void {
  child.stdin.write(JSON.stringify(msg) + '\n')
}

function request<T = unknown>(id: number, method: string, params?: unknown): Promise<T> {
  return new Promise((resolve) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

beforeAll(() => {
  execSync('npm run build', { cwd: PACKAGE_DIR, stdio: 'pipe' })
}, 120_000)

beforeAll(async () => {
  stubServer = http.createServer((req, res) => {
    const send200 = (data: unknown) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (req.method === 'GET' && req.url === '/__the-forge/pull') {
      claimedIds.push(STUB_ITEM.id)
      return send200({ items: [STUB_ITEM] })
    }
    if (req.method === 'POST' && req.url === '/__the-forge/mark') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        markCalls.push(body)
        send200({ marked: body.ids })
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => stubServer.listen(0, resolve))
  stubPort = (stubServer.address() as { port: number }).port

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-e2e-'))
  fs.mkdirSync(path.join(tempDir, '.the-forge'), { recursive: true })
  fs.writeFileSync(
    path.join(tempDir, '.the-forge', 'endpoint.json'),
    JSON.stringify({ port: stubPort, pid: process.pid })
  )

  child = spawn('node', [MCP_BIN], { cwd: tempDir, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx)
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line) as { id?: number }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!.resolve(msg)
        pending.delete(msg.id)
      }
    }
  })
})

afterAll(() => {
  child?.kill()
  stubServer?.close()
})

describe('mcp stdio server (built bin)', () => {
  it('completes initialize handshake', async () => {
    const res = (await request(1, 'initialize', {})) as { id: number; result: { serverInfo: { name: string } } }
    expect(res.id).toBe(1)
    expect(res.result.serverInfo.name).toBe('the-forge')
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })

  it('lists tools', async () => {
    const res = (await request(2, 'tools/list', {})) as { result: { tools: Array<{ name: string }> } }
    const names = res.result.tools.map((t) => t.name)
    expect(names).toContain('pull_design_edits')
    expect(names).toContain('mark_applied')
  })

  it('calls pull_design_edits against the stub backend and claims the item', async () => {
    const res = (await request(3, 'tools/call', { name: 'pull_design_edits', arguments: {} })) as {
      result: { content: Array<{ type: string; text: string }> }
    }
    const text = res.result.content[0].text
    expect(text).toContain('Stub change')
    expect(text).toContain(STUB_ITEM.id)
    expect(claimedIds).toContain(STUB_ITEM.id)
  })

  it('calls mark_applied and the stub receives it', async () => {
    const res = (await request(4, 'tools/call', {
      name: 'mark_applied',
      arguments: { ids: [STUB_ITEM.id], status: 'applied' },
    })) as { result: { content: Array<{ type: string; text: string }> } }
    expect(res.result.content[0].text).toBe('Marked 1 request(s) as applied.')
    expect(markCalls).toHaveLength(1)
    expect(markCalls[0]).toMatchObject({ ids: [STUB_ITEM.id], status: 'applied' })
  })
})

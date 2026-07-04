import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let root: string
let closers: Array<() => Promise<void>> = []

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sidecar-'))
  vi.resetModules()
})

afterEach(async () => {
  for (const close of closers) await close()
  closers = []
  vi.useRealTimers()
})

const FAKE_CLIENT_JS = '/* fake client bundle */\nconsole.log("hi")\n'

async function importSidecar() {
  return import('../../src/next/sidecar')
}

function baseOpts(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agent: 'claude-code' as const,
    channelsFlag: false,
    root,
    clientBundle: () => FAKE_CLIENT_JS,
    ...overrides,
  }
}

async function fetchJson(port: number, urlPath: string, init?: RequestInit) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, init)
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // not json — fine, caller checks status/text directly
  }
  return { status: res.status, text, json, headers: res.headers }
}

describe('ensureSidecar', () => {
  it('binds an ephemeral loopback port and writes exactly one endpoint file', async () => {
    const { ensureSidecar } = await importSidecar()
    const handle = await ensureSidecar(baseOpts())
    closers.push(() => handle.close())

    expect(handle.port).toBeGreaterThan(0)
    const forgeDir = path.join(root, '.the-forge')
    const files = fs.readdirSync(forgeDir).filter((f) => f.startsWith('endpoint-'))
    expect(files).toHaveLength(1)
    const data = JSON.parse(fs.readFileSync(path.join(forgeDir, files[0]), 'utf8'))
    expect(data.port).toBe(handle.port)
    expect(data.host).toBe('127.0.0.1')
  })

  it('a second concurrent call resolves the SAME handle — never double-binds or writes two endpoint files', async () => {
    const { ensureSidecar } = await importSidecar()
    const opts = baseOpts()
    const [a, b] = await Promise.all([ensureSidecar(opts), ensureSidecar(opts)])
    closers.push(() => a.close())

    expect(a.port).toBe(b.port)
    const forgeDir = path.join(root, '.the-forge')
    const files = fs.readdirSync(forgeDir).filter((f) => f.startsWith('endpoint-'))
    expect(files).toHaveLength(1)
  })

  it('a subsequent call after close() binds fresh (new handle, singleton cleared)', async () => {
    const { ensureSidecar } = await importSidecar()
    const first = await ensureSidecar(baseOpts())
    await first.close()

    const second = await ensureSidecar(baseOpts())
    closers.push(() => second.close())
    expect(second.port).toBeGreaterThan(0)
  })

  it('GET /__the-forge/client.js serves the bootstrap line + clientBundle() with the right content type', async () => {
    const { ensureSidecar } = await importSidecar()
    const handle = await ensureSidecar(baseOpts())
    closers.push(() => handle.close())

    const res = await fetchJson(handle.port, '/__the-forge/client.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(res.text.startsWith('globalThis.__THE_FORGE__ = ')).toBe(true)
    expect(res.text).toContain(FAKE_CLIENT_JS)

    // Secret embedded in the bootstrap line matches the endpoint file's secret.
    const forgeDir = path.join(root, '.the-forge')
    const files = fs.readdirSync(forgeDir).filter((f) => f.startsWith('endpoint-'))
    const data = JSON.parse(fs.readFileSync(path.join(forgeDir, files[0]), 'utf8'))
    const bootstrapLine = res.text.split('\n')[0]
    const embedded = JSON.parse(bootstrapLine.replace('globalThis.__THE_FORGE__ = ', '').replace(/;$/, ''))
    expect(embedded.secret).toBe(data.secret)
    expect(embedded.agent).toBe('claude-code')
  })

  it('POST /__the-forge/queue without X-Forge-Secret is rejected with 403 (middleware wiring intact)', async () => {
    const { ensureSidecar } = await importSidecar()
    const handle = await ensureSidecar(baseOpts())
    closers.push(() => handle.close())

    const res = await fetchJson(handle.port, '/__the-forge/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# x' }),
    })
    expect(res.status).toBe(403)
  })

  it('POST /__the-forge/queue WITH the correct secret succeeds', async () => {
    const { ensureSidecar } = await importSidecar()
    const handle = await ensureSidecar(baseOpts())
    closers.push(() => handle.close())

    const forgeDir = path.join(root, '.the-forge')
    const files = fs.readdirSync(forgeDir).filter((f) => f.startsWith('endpoint-'))
    const data = JSON.parse(fs.readFileSync(path.join(forgeDir, files[0]), 'utf8'))

    const res = await fetchJson(handle.port, '/__the-forge/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Secret': data.secret },
      body: JSON.stringify({ markdown: '# x' }),
    })
    expect(res.status).toBe(200)
  })

  it('unknown paths 404 via the fallthrough next()', async () => {
    const { ensureSidecar } = await importSidecar()
    const handle = await ensureSidecar(baseOpts())
    closers.push(() => handle.close())

    const res = await fetchJson(handle.port, '/some/unrelated/path')
    expect(res.status).toBe(404)
  })

  it('close() removes the endpoint file', async () => {
    const { ensureSidecar } = await importSidecar()
    const handle = await ensureSidecar(baseOpts())
    const forgeDir = path.join(root, '.the-forge')
    const before = fs.readdirSync(forgeDir).filter((f) => f.startsWith('endpoint-'))
    expect(before).toHaveLength(1)

    await handle.close()
    const after = fs.readdirSync(forgeDir).filter((f) => f.startsWith('endpoint-'))
    expect(after).toHaveLength(0)
  })

  describe('missing-ForgeDesignMode hint', () => {
    it('warns once when client.js is never fetched within the hint delay', async () => {
      const { ensureSidecar } = await importSidecar()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const handle = await ensureSidecar(baseOpts({ hintDelayMs: 20 }))
      closers.push(() => handle.close())

      await new Promise((r) => setTimeout(r, 60))

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toContain('design mode never loaded')
      expect(warnSpy.mock.calls[0][0]).toContain("from 'the-forge/design-mode'")
      warnSpy.mockRestore()
    })

    it('does not warn when client.js was fetched before the hint delay elapses', async () => {
      const { ensureSidecar } = await importSidecar()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const handle = await ensureSidecar(baseOpts({ hintDelayMs: 30 }))
      closers.push(() => handle.close())

      await fetchJson(handle.port, '/__the-forge/client.js')
      await new Promise((r) => setTimeout(r, 60))

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })
})

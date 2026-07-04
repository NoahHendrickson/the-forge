import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { Queue } from '../../src/server/queue'
import { createForgeMiddleware, writeEndpointFile } from '../../src/server/endpoints'

function fakeReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> }
  req.method = method
  req.url = url
  req.headers = headers
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    end(s?: string) {
      this.body = s ?? ''
      this.done?.()
    },
    done: undefined as (() => void) | undefined,
  }
  return res
}

function run(mw: ReturnType<typeof createForgeMiddleware>, req: unknown, res: ReturnType<typeof fakeRes>) {
  return new Promise<void>((resolve) => {
    res.done = resolve
    mw(req as never, res as never, () => resolve())
  })
}

let dir: string
let queue: Queue
let mw: ReturnType<typeof createForgeMiddleware>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mw-'))
  queue = new Queue(dir)
  mw = createForgeMiddleware(queue)
})

describe('forge middleware', () => {
  it('queues a POST and returns the id', async () => {
    const res = fakeRes()
    await run(mw, fakeReq('POST', '/__the-forge/queue', { request: { elements: [] }, markdown: '# md' }), res)
    expect(res.statusCode).toBe(200)
    const { id } = JSON.parse(res.body)
    expect(queue.get(id)!.markdown).toBe('# md')
  })

  it('pull claims and returns pending items', async () => {
    queue.add({}, 'one')
    const res = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/pull'), res)
    const { items } = JSON.parse(res.body)
    expect(items).toHaveLength(1)
    expect(queue.get(items[0].id)!.status).toBe('claimed')
  })

  it('mark finalizes and status reports', async () => {
    const item = queue.add({}, 'one')
    queue.pull()
    const res1 = fakeRes()
    await run(mw, fakeReq('POST', '/__the-forge/mark', { ids: [item.id], status: 'applied', note: 'ok' }), res1)
    expect(JSON.parse(res1.body).marked).toEqual([item.id])
    const res2 = fakeRes()
    await run(mw, fakeReq('GET', `/__the-forge/status?ids=${item.id}`), res2)
    expect(JSON.parse(res2.body).items[0]).toMatchObject({ id: item.id, status: 'applied', note: 'ok' })
  })

  it('400s malformed JSON, 404s unknown forge paths, passes through others', async () => {
    const bad = fakeRes()
    const req = new EventEmitter() as never
    ;(req as { method: string }).method = 'POST'
    ;(req as { url: string }).url = '/__the-forge/queue'
    ;(req as { headers: object }).headers = {}
    process.nextTick(() => {
      ;(req as EventEmitter).emit('data', Buffer.from('{nope'))
      ;(req as EventEmitter).emit('end')
    })
    await run(mw, req, bad)
    expect(bad.statusCode).toBe(400)

    const missing = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/nope'), missing)
    expect(missing.statusCode).toBe(404)

    let nexted = false
    const other = fakeRes()
    await new Promise<void>((resolve) => {
      mw(fakeReq('GET', '/app') as never, other as never, () => {
        nexted = true
        resolve()
      })
    })
    expect(nexted).toBe(true)
  })

  describe('origin check', () => {
    it('rejects cross-origin browser requests with 403', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/queue', { markdown: 'x' }, { origin: 'https://evil.example', host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(403)
    })

    it('allows same-origin requests', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/queue', { request: null, markdown: 'x' }, { origin: 'http://localhost:5173', host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })

    it('allows origin-less local tool requests', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('GET', '/__the-forge/pull', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })
  })

  it('400s oversize bodies without double-settling', async () => {
    const res = fakeRes()
    const req = new EventEmitter() as never
    ;(req as { method: string }).method = 'POST'
    ;(req as { url: string }).url = '/__the-forge/queue'
    ;(req as { headers: object }).headers = {}
    process.nextTick(() => {
      ;(req as EventEmitter).emit('data', Buffer.alloc(1024 * 1024 + 1))
      ;(req as EventEmitter).emit('end')
    })
    await run(mw, req, res)
    expect(res.statusCode).toBe(400)
  })
})

describe('writeEndpointFile', () => {
  it('writes port and pid', () => {
    writeEndpointFile(dir, 5199)
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'))
    expect(data.port).toBe(5199)
    expect(data.pid).toBe(process.pid)
  })

  it('writes host when provided (e.g. IPv6)', () => {
    writeEndpointFile(dir, 5199, '::1')
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'))
    expect(data.port).toBe(5199)
    expect(data.host).toBe('::1')
  })
})

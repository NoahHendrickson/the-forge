import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { Queue } from '../../src/server/queue'
import { WatcherHub } from '../../src/server/watchers'
import type { DispatchResult } from '../../src/server/dispatch'

// The real dispatch ladder (real tmux/osascript) must NEVER run inside this suite — on a Mac
// with automation permission + iTerm2/Terminal open it would type /forge-design into the developer's
// actual front window. Mock the module-level `dispatch` export so the "no dispatchFn injected"
// wiring test below can prove the fallback happens without ever invoking a real adapter.
const dispatchSpy = vi.fn(async (): Promise<DispatchResult> => ({ rung: 'manual', detail: 'mocked — never the real ladder' }))
vi.mock('../../src/server/dispatch', async () => {
  const actual = await vi.importActual<typeof import('../../src/server/dispatch')>('../../src/server/dispatch')
  return { ...actual, dispatch: dispatchSpy }
})

const { createForgeMiddleware, writeEndpointFile, removeEndpointFile } = await import('../../src/server/endpoints')

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
    // The /wait handler registers a 'close' listener (long-poll cleanup); other handlers
    // never call res.on. Stored so tests can simulate the client vanishing mid-hold.
    listeners: {} as Record<string, () => void>,
    on(event: string, cb: () => void) {
      this.listeners[event] = cb
    },
    emitClose() {
      this.listeners['close']?.()
    },
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
    await run(mw, fakeReq('POST', '/__the-forge/queue', { request: { elements: [] }, markdown: '# md' }, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    const { id } = JSON.parse(res.body)
    expect(queue.get(id)!.markdown).toBe('# md')
  })

  it('pull claims and returns pending items via POST', async () => {
    queue.add({}, 'one')
    const res = fakeRes()
    await run(mw, fakeReq('POST', '/__the-forge/pull', {}, { host: 'localhost:5173' }), res)
    const { items } = JSON.parse(res.body)
    expect(items).toHaveLength(1)
    expect(queue.get(items[0].id)!.status).toBe('claimed')
  })

  it('GET /pull is rejected with 405', async () => {
    queue.add({}, 'one')
    const res = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/pull', undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(405)
    expect(JSON.parse(res.body)).toEqual({ error: 'use POST' })
  })

  it('mark finalizes and status reports', async () => {
    const item = queue.add({}, 'one')
    queue.pull()
    const res1 = fakeRes()
    await run(mw, fakeReq('POST', '/__the-forge/mark', { ids: [item.id], status: 'applied', note: 'ok' }, { host: 'localhost:5173' }), res1)
    expect(JSON.parse(res1.body).marked).toEqual([item.id])
    const res2 = fakeRes()
    await run(mw, fakeReq('GET', `/__the-forge/status?ids=${item.id}`, undefined, { host: 'localhost:5173' }), res2)
    expect(JSON.parse(res2.body).items[0]).toMatchObject({ id: item.id, status: 'applied', note: 'ok' })
  })

  it('400s malformed JSON, 404s unknown forge paths, passes through others', async () => {
    const bad = fakeRes()
    const req = new EventEmitter() as never
    ;(req as { method: string }).method = 'POST'
    ;(req as { url: string }).url = '/__the-forge/queue'
    ;(req as { headers: object }).headers = { host: 'localhost:5173' }
    process.nextTick(() => {
      ;(req as EventEmitter).emit('data', Buffer.from('{nope'))
      ;(req as EventEmitter).emit('end')
    })
    await run(mw, req, bad)
    expect(bad.statusCode).toBe(400)

    const missing = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/nope', undefined, { host: 'localhost:5173' }), missing)
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
      await run(mw, fakeReq('POST', '/__the-forge/pull', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })

    // Next.js's rewrites() proxy rewrites Host to the sidecar's own loopback address
    // (127.0.0.1:<port>) before the request reaches this middleware, while Origin still
    // carries the browser's real page origin (e.g. http://localhost:3000) — see
    // docs/research/2026-07-04-next-spike-findings.md's Host-rewrite finding. Comparing
    // Origin against the rewritten Host therefore rejects every real browser request on the
    // Next adapter path (found via next-demo E2E, N8a). The original external host survives
    // as X-Forwarded-Host, which this check must prefer when present; falling back to Host
    // keeps the direct-connection Vite path (no proxy, no X-Forwarded-Host) unchanged.
    it('allows same-origin requests proxied through Next rewrites (Host rewritten, X-Forwarded-Host preserved)', async () => {
      const res = fakeRes()
      await run(
        mw,
        fakeReq(
          'POST',
          '/__the-forge/queue',
          { request: null, markdown: 'x' },
          { origin: 'http://localhost:3000', host: '127.0.0.1:55836', 'x-forwarded-host': 'localhost:3000' }
        ),
        res
      )
      expect(res.statusCode).toBe(200)
    })

    it('still rejects a genuinely cross-origin request behind the same proxy Host', async () => {
      const res = fakeRes()
      await run(
        mw,
        fakeReq(
          'POST',
          '/__the-forge/queue',
          { markdown: 'x' },
          { origin: 'https://evil.example', host: '127.0.0.1:55836', 'x-forwarded-host': 'localhost:3000' }
        ),
        res
      )
      expect(res.statusCode).toBe(403)
    })

    it('rejects a self-consistent X-Forwarded-Host forgery when a secret is configured (403 on the secret gate)', async () => {
      // The X-Forwarded-Host change widens the Origin echo surface: an attacker can now craft
      // a self-consistent forgery (origin + x-forwarded-host both pointing to evil.example)
      // that passes the Origin check. The X-Forge-Secret gate must catch this attack.
      const SECRET = 'test-secret-xyz'
      const secured = createForgeMiddleware(queue, [], SECRET)
      const res = fakeRes()
      await run(
        secured,
        fakeReq(
          'POST',
          '/__the-forge/queue',
          { markdown: 'x' },
          { origin: 'https://evil.example', host: '127.0.0.1:55836', 'x-forwarded-host': 'evil.example' }
        ),
        res
      )
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'missing or invalid X-Forge-Secret' })
    })

    it('allows the same self-consistent forgery request when the correct secret is provided', async () => {
      // Discriminating test: verify that WITH the secret, the request passes. This proves the
      // secret gate is the load-bearing control stopping the forgery, not some other earlier check.
      const SECRET = 'test-secret-xyz'
      const secured = createForgeMiddleware(queue, [], SECRET)
      const res = fakeRes()
      await run(
        secured,
        fakeReq(
          'POST',
          '/__the-forge/queue',
          { markdown: 'x' },
          {
            origin: 'https://evil.example',
            host: '127.0.0.1:55836',
            'x-forwarded-host': 'evil.example',
            'x-forge-secret': SECRET,
          }
        ),
        res
      )
      expect(res.statusCode).toBe(200)
    })
  })

  describe('host check (DNS-rebinding defense)', () => {
    it('403s when Host does not match localhost/127.0.0.1/::1/allowedHosts, even with a matching Origin', async () => {
      const res = fakeRes()
      await run(
        mw,
        fakeReq('POST', '/__the-forge/queue', { markdown: 'x' }, { origin: 'http://evil.com:5173', host: 'evil.com:5173' }),
        res
      )
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'host not allowed' })
    })

    it('403s when no Host header is present', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/pull', {}, {}), res)
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'host not allowed' })
    })

    it('allows Host: localhost:5173', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/pull', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })

    it('allows Host: 127.0.0.1:5173', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/pull', {}, { host: '127.0.0.1:5173' }), res)
      expect(res.statusCode).toBe(200)
    })

    it('allows Host: [::1]:5173', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/pull', {}, { host: '[::1]:5173' }), res)
      expect(res.statusCode).toBe(200)
    })

    it('allows a subdomain of .localhost', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/pull', {}, { host: 'foo.localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })

    it('allows hosts present in the allowedHosts option', async () => {
      const mwWithAllowed = createForgeMiddleware(queue, ['my-tunnel.example.com'])
      const res = fakeRes()
      await run(mwWithAllowed, fakeReq('POST', '/__the-forge/pull', {}, { host: 'my-tunnel.example.com:443' }), res)
      expect(res.statusCode).toBe(200)
    })
  })

  it('400s oversize bodies without double-settling', async () => {
    const res = fakeRes()
    const req = new EventEmitter() as never
    ;(req as { method: string }).method = 'POST'
    ;(req as { url: string }).url = '/__the-forge/queue'
    ;(req as { headers: object }).headers = { host: 'localhost:5173' }
    process.nextTick(() => {
      ;(req as EventEmitter).emit('data', Buffer.alloc(1024 * 1024 + 1))
      ;(req as EventEmitter).emit('end')
    })
    await run(mw, req, res)
    expect(res.statusCode).toBe(400)
  })

  describe('shared secret', () => {
    const SECRET = 'test-secret-abc'
    let secured: ReturnType<typeof createForgeMiddleware>

    beforeEach(() => {
      secured = createForgeMiddleware(queue, [], SECRET)
    })

    it('403s POST /queue missing the X-Forge-Secret header', async () => {
      const res = fakeRes()
      await run(secured, fakeReq('POST', '/__the-forge/queue', { markdown: 'x' }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(403)
    })

    it('403s POST /queue with a wrong X-Forge-Secret header', async () => {
      const res = fakeRes()
      await run(
        secured,
        fakeReq('POST', '/__the-forge/queue', { markdown: 'x' }, { host: 'localhost:5173', 'x-forge-secret': 'wrong' }),
        res
      )
      expect(res.statusCode).toBe(403)
    })

    it('allows POST /queue with a matching X-Forge-Secret header', async () => {
      const res = fakeRes()
      await run(
        secured,
        fakeReq('POST', '/__the-forge/queue', { markdown: 'x' }, { host: 'localhost:5173', 'x-forge-secret': SECRET }),
        res
      )
      expect(res.statusCode).toBe(200)
    })

    it('403s POST /pull and POST /mark missing the header', async () => {
      const res1 = fakeRes()
      await run(secured, fakeReq('POST', '/__the-forge/pull', {}, { host: 'localhost:5173' }), res1)
      expect(res1.statusCode).toBe(403)

      const res2 = fakeRes()
      await run(secured, fakeReq('POST', '/__the-forge/mark', { ids: [], status: 'applied' }, { host: 'localhost:5173' }), res2)
      expect(res2.statusCode).toBe(403)
    })

    it('leaves GET /status open without requiring the header', async () => {
      const res = fakeRes()
      await run(secured, fakeReq('GET', '/__the-forge/status', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })

    it('does not require the header when no secret is configured (backward compatible)', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/queue', { markdown: 'x' }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })
  })
})

describe('POST /__the-forge/dispatch', () => {
  it('runs the injected dispatch function and returns its result as JSON', async () => {
    queue.add({}, 'some pending markdown') // a real dispatch only ever fires after a queue add
    const fakeResult: DispatchResult = { rung: 'tmux', detail: 'typed /forge-design into tmux pane %1' }
    let receivedOpts: unknown = null
    const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
      agent: 'claude-code',
      channelsFlag: false,
      dispatchFn: async (opts) => {
        receivedOpts = opts
        return fakeResult
      },
    })
    const res = fakeRes()
    await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual(fakeResult)
    expect(receivedOpts).toMatchObject({ agent: 'claude-code', channelsFlag: false })
  })

  it('threads dispatchConfig.cwd through to DispatchOpts.cwd (BUG fix: Channels marker check must use the resolved forgeDir, not process.cwd())', async () => {
    queue.add({}, 'some pending markdown')
    let receivedOpts: unknown = null
    const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
      agent: 'claude-code',
      channelsFlag: true,
      cwd: '/resolved/project/root',
      dispatchFn: async (opts) => {
        receivedOpts = opts
        return { rung: 'manual', detail: 'x' }
      },
    })
    const res = fakeRes()
    await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(receivedOpts).toMatchObject({ cwd: '/resolved/project/root' })
  })

  it('short-circuits to the manual rung WITHOUT invoking the ladder when there is no pending item and no markdown override', async () => {
    // queue is empty (nothing added in this test) — no markdown body override either.
    const dispatchFn = vi.fn(async () => ({ rung: 'tmux' as const, detail: 'should never be reached' }))
    const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
      agent: 'claude-code',
      channelsFlag: false,
      dispatchFn,
    })
    const res = fakeRes()
    await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ rung: 'manual', detail: 'nothing pending' })
    expect(dispatchFn).not.toHaveBeenCalled()
  })

  it('still runs the ladder when no item is pending but a markdown override is posted', async () => {
    const dispatchFn = vi.fn(async () => ({ rung: 'manual' as const, detail: 'x' }))
    const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
      agent: 'claude-code',
      channelsFlag: false,
      dispatchFn,
    })
    const res = fakeRes()
    await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', { markdown: '# override' }, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(dispatchFn).toHaveBeenCalledTimes(1)
    expect(dispatchFn).toHaveBeenCalledWith(expect.objectContaining({ markdown: '# override' }))
  })

  it('defaults markdown to the newest pending queue item (not the oldest)', async () => {
    let clock = 1_000
    const orderedQueue = new Queue(dir, () => (clock += 1_000))
    orderedQueue.add({}, 'oldest markdown')
    orderedQueue.add({}, 'newest markdown')
    let receivedOpts: { markdown?: string } = {}
    const mwWithDispatch = createForgeMiddleware(orderedQueue, [], undefined, {
      agent: 'claude-code',
      channelsFlag: false,
      dispatchFn: async (opts) => {
        receivedOpts = opts
        return { rung: 'manual', detail: 'x' }
      },
    })
    const res = fakeRes()
    await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(receivedOpts.markdown).toBe('newest markdown')
  })

  it('defaults the agent from plugin config but allows body.agent to override it', async () => {
    queue.add({}, 'pending markdown')
    let receivedOpts: { agent?: string } = {}
    const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
      agent: 'claude-code',
      channelsFlag: false,
      dispatchFn: async (opts) => {
        receivedOpts = opts
        return { rung: 'manual', detail: 'x' }
      },
    })
    const res = fakeRes()
    await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', { agent: 'cursor' }, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(receivedOpts.agent).toBe('cursor')
  })

  it('rejects non-POST with 405', async () => {
    const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
      agent: 'claude-code',
      channelsFlag: false,
      dispatchFn: async () => ({ rung: 'manual', detail: 'x' }),
    })
    const res = fakeRes()
    await run(mwWithDispatch, fakeReq('GET', '/__the-forge/dispatch', undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(405)
  })

  describe('agent allowlist validation', () => {
    it('400s when body.agent is not one of the known agents', async () => {
      const dispatchFn = vi.fn(async () => ({ rung: 'manual' as const, detail: 'x' }))
      const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code',
        channelsFlag: false,
        dispatchFn,
      })
      const res = fakeRes()
      await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', { agent: 'not-a-real-agent' }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'unknown agent' })
      expect(dispatchFn).not.toHaveBeenCalled()
    })

    it.each(['claude-code', 'cursor', 'codex'])('allows body.agent = %s', async (agent) => {
      const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code',
        channelsFlag: false,
        dispatchFn: async () => ({ rung: 'manual', detail: 'x' }),
      })
      const res = fakeRes()
      await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', { agent }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })

    it('allows an omitted body.agent (falls back to configured agent, no validation error)', async () => {
      const mwWithDispatch = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code',
        channelsFlag: false,
        dispatchFn: async () => ({ rung: 'manual', detail: 'x' }),
      })
      const res = fakeRes()
      await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
    })
  })

  it('is guarded by the shared secret like other mutating endpoints', async () => {
    const SECRET = 'dispatch-secret'
    const mwWithDispatch = createForgeMiddleware(queue, [], SECRET, {
      agent: 'claude-code',
      channelsFlag: false,
      dispatchFn: async () => ({ rung: 'manual', detail: 'x' }),
    })
    const res = fakeRes()
    await run(mwWithDispatch, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(403)

    const ok = fakeRes()
    await run(
      mwWithDispatch,
      fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173', 'x-forge-secret': SECRET }),
      ok
    )
    expect(ok.statusCode).toBe(200)
  })

  it('falls back to the dispatch.ts ladder export when no dispatchFn is injected (module mocked — never the real ladder)', async () => {
    dispatchSpy.mockClear()
    queue.add({}, 'pending markdown') // ensures the new no-pending short-circuit doesn't pre-empt the ladder
    const mwDefault = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false })
    const res = fakeRes()
    await run(mwDefault, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(res.body)).toEqual({ rung: 'manual', detail: 'mocked — never the real ladder' })
  })
})

describe('watch mode (POST /__the-forge/wait + watcher-aware dispatch/status)', () => {
  it('GET /wait is rejected with 405', async () => {
    const res = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/wait', undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('/wait is guarded by the shared secret like other mutating endpoints', async () => {
    const secured = createForgeMiddleware(queue, [], 'wait-secret')
    const res = fakeRes()
    await run(secured, fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('a queue POST resolves a parked /wait with the item, already claimed', async () => {
    const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 5_000 })
    const mwWatch = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false }, hub)

    const waitRes = fakeRes()
    const waiting = run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }), waitRes)
    await new Promise((r) => setTimeout(r, 10)) // let the wait park before the Send lands

    const queueRes = fakeRes()
    await run(mwWatch, fakeReq('POST', '/__the-forge/queue', { markdown: '# via watcher' }, { host: 'localhost:5173' }), queueRes)
    const { id } = JSON.parse(queueRes.body)

    await waiting
    const body = JSON.parse(waitRes.body)
    expect(body.stop).toBe(false)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe(id)
    expect(queue.get(id)!.status).toBe('claimed')
  })

  it('hold expiry resolves {stop:false, items:[]} — the re-arm tick', async () => {
    const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 10 })
    const mwWatch = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false }, hub)
    const res = fakeRes()
    await run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }), res)
    expect(JSON.parse(res.body)).toEqual({ stop: false, items: [] })
  })

  it('dispatch short-circuits to the watcher rung when a watcher is live — the ladder is never invoked', async () => {
    const dispatchFn = vi.fn(async () => ({ rung: 'tmux' as const, detail: 'must never run' }))
    const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 5_000 })
    const mwWatch = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, dispatchFn }, hub)

    const waitRes = fakeRes()
    void run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }), waitRes)
    await new Promise((r) => setTimeout(r, 10)) // parked → hub is live

    // Deliberately NOTHING pending: a live watcher usually consumed the Send already by
    // dispatch time, and that must still report delivered — not 'nothing pending'/manual.
    const res = fakeRes()
    await run(mwWatch, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ rung: 'watcher', detail: 'delivered to your linked session' })
    expect(dispatchFn).not.toHaveBeenCalled()

    waitRes.emitClose() // free the parked waiter so no timer outlives the test
  })

  it('dispatch runs the normal ladder when the watcher is asleep (stopped/disconnected)', async () => {
    const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 10, freshMs: 0 })
    const mwWatch = createForgeMiddleware(
      queue,
      [],
      undefined,
      { agent: 'claude-code', channelsFlag: false, dispatchFn: async () => ({ rung: 'manual', detail: 'ladder ran' }) },
      hub
    )
    // Watch once, let the hold expire; freshMs 0 makes the heartbeat stale immediately.
    const waitRes = fakeRes()
    await run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }), waitRes)
    expect(hub.state()).toBe('asleep')

    queue.add({}, 'pending markdown')
    const res = fakeRes()
    await run(mwWatch, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
    expect(JSON.parse(res.body)).toEqual({ rung: 'manual', detail: 'ladder ran' })
  })

  it('a closed connection frees the slot: the item is delivered to the NEXT wait instead of lost', async () => {
    const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 5_000 })
    const mwWatch = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false }, hub)

    const dead = fakeRes()
    void run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }), dead)
    await new Promise((r) => setTimeout(r, 10))
    dead.emitClose() // bin vanished mid-hold

    queue.add({}, 'queued while nobody watched')
    const next = fakeRes()
    await run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }), next)
    const body = JSON.parse(next.body)
    expect(body.items).toHaveLength(1)
    expect(dead.body).toBe('') // the dead response was never written to
  })

  it('threads X-Forge-Watcher through to the hub: a replaced token retrying is absorbed, the winner keeps the slot', async () => {
    const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 5_000 })
    const mwWatch = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false }, hub)
    const headersFor = (token: string) => ({ host: 'localhost:5173', 'x-forge-watcher': token })

    const resA = fakeRes()
    const waitingA = run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, headersFor('bin-a')), resA)
    await new Promise((r) => setTimeout(r, 10))
    const resB = fakeRes()
    void run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, headersFor('bin-b')), resB)
    await waitingA
    expect(JSON.parse(resA.body)).toEqual({ stop: true, reason: 'replaced' })

    // A's disobedient retry is absorbed without bumping B…
    const resARetry = fakeRes()
    await run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, headersFor('bin-a')), resARetry)
    expect(JSON.parse(resARetry.body)).toEqual({ stop: true, reason: 'replaced' })

    // …and B still receives the next Send.
    await run(mwWatch, fakeReq('POST', '/__the-forge/queue', { markdown: '# for B' }, { host: 'localhost:5173' }), fakeRes())
    await new Promise((r) => setTimeout(r, 10))
    const bBody = JSON.parse(resB.body)
    expect(bBody.stop).toBe(false)
    expect(bBody.items).toHaveLength(1)
  })

  it('GET /status reports watcher state and supports the empty-ids probe', async () => {
    queue.add({}, 'an item')
    // Absent ids param → all items, watcher 'none' on a pristine hub.
    const all = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/status', undefined, { host: 'localhost:5173' }), all)
    const allBody = JSON.parse(all.body)
    expect(allBody.items).toHaveLength(1)
    expect(allBody.watcher).toBe('none')

    // Present-but-empty ids (`?ids=`) → zero items: the watch poller's cheap probe.
    const probe = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/status?ids=', undefined, { host: 'localhost:5173' }), probe)
    const probeBody = JSON.parse(probe.body)
    expect(probeBody.items).toHaveLength(0)
    expect(probeBody.watcher).toBe('none')
  })

  it('GET /status reports live while a wait is parked', async () => {
    const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 5_000 })
    const mwWatch = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false }, hub)
    const waitRes = fakeRes()
    void run(mwWatch, fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }), waitRes)
    await new Promise((r) => setTimeout(r, 10))

    const res = fakeRes()
    await run(mwWatch, fakeReq('GET', '/__the-forge/status?ids=', undefined, { host: 'localhost:5173' }), res)
    expect(JSON.parse(res.body).watcher).toBe('live')

    waitRes.emitClose()
  })
})

describe('writeEndpointFile', () => {
  it('writes port and pid to a per-process file', () => {
    const filePath = writeEndpointFile(dir, 5199)
    expect(filePath).toBe(path.join(dir, `endpoint-${process.pid}.json`))
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(data.port).toBe(5199)
    expect(data.pid).toBe(process.pid)
  })

  it('writes host when provided (e.g. IPv6)', () => {
    const filePath = writeEndpointFile(dir, 5199, '::1')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(data.port).toBe(5199)
    expect(data.host).toBe('::1')
  })

  it('writes the secret when provided', () => {
    const filePath = writeEndpointFile(dir, 5199, '127.0.0.1', 'my-secret')
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(data.secret).toBe('my-secret')
  })

  it('second write from the same pid overwrites rather than duplicating', () => {
    writeEndpointFile(dir, 5199)
    writeEndpointFile(dir, 6000)
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('endpoint-'))
    expect(files).toHaveLength(1)
    const data = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))
    expect(data.port).toBe(6000)
  })
})

describe('removeEndpointFile', () => {
  it('deletes this process endpoint file', () => {
    const filePath = writeEndpointFile(dir, 5199)
    expect(fs.existsSync(filePath)).toBe(true)
    removeEndpointFile(dir)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('ignores errors when the file does not exist', () => {
    expect(() => removeEndpointFile(dir)).not.toThrow()
  })

  it('ignores errors when the directory does not exist', () => {
    expect(() => removeEndpointFile(path.join(dir, 'nonexistent'))).not.toThrow()
  })
})

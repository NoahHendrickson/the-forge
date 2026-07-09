import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { Queue } from '../../src/server/queue'
import { WatcherHub } from '../../src/server/watchers'
import type { DispatchResult } from '../../src/server/dispatch'
import { SessionManager } from '../../src/server/session/manager'
import { ApprovalRegistry } from '../../src/server/session/approvals'
import type { SessionAdapter, SessionEvent } from '../../src/server/session/adapter'
import type { ApprovalFeedItem } from '../../src/server/session/approvals'
import type { ForgeSessionHandles } from '../../src/server/runtime'

// The real dispatch ladder (real tmux/osascript) must NEVER run inside this suite — on a Mac
// with automation permission + iTerm2/Terminal open it would type /forge-design into the developer's
// actual front window. Mock the module-level `dispatch` export so the "no dispatchFn injected"
// wiring test below can prove the fallback happens without ever invoking a real adapter.
const dispatchSpy = vi.fn(async (): Promise<DispatchResult> => ({ rung: 'manual', detail: 'mocked — never the real ladder' }))
vi.mock('../../src/server/dispatch', async () => {
  const actual = await vi.importActual<typeof import('../../src/server/dispatch')>('../../src/server/dispatch')
  return { ...actual, dispatch: dispatchSpy }
})

const { createForgeMiddleware, writeEndpointFile, removeEndpointFile, DEVTOOLS_JSON_PATH } = await import(
  '../../src/server/endpoints'
)

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

  describe('cursor deeplink loop-closure trailer', () => {
    it('appends the mark_applied instruction (with the pending item id) for the cursor agent', async () => {
      const added = queue.add({}, '# md body')
      let receivedOpts: { markdown?: string } = {}
      const mwCursor = createForgeMiddleware(queue, [], undefined, {
        agent: 'cursor',
        channelsFlag: false,
        dispatchFn: async (opts) => {
          receivedOpts = opts
          return { rung: 'deeplink', detail: 'x' }
        },
      })
      const res = fakeRes()
      await run(mwCursor, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(receivedOpts.markdown).toContain('# md body')
      expect(receivedOpts.markdown).toContain('mark_applied')
      expect(receivedOpts.markdown).toContain(added.id)
    })

    it('does not append the trailer for claude-code (the MCP tool result carries the reminder there)', async () => {
      queue.add({}, '# md body')
      let receivedOpts: { markdown?: string } = {}
      const mwClaude = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code',
        channelsFlag: false,
        dispatchFn: async (opts) => {
          receivedOpts = opts
          return { rung: 'manual', detail: 'x' }
        },
      })
      const res = fakeRes()
      await run(mwClaude, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(receivedOpts.markdown).toBe('# md body')
    })

    it('does not append the trailer to a caller-posted markdown override (no queue item to mark)', async () => {
      let receivedOpts: { markdown?: string } = {}
      const mwCursor = createForgeMiddleware(queue, [], undefined, {
        agent: 'cursor',
        channelsFlag: false,
        dispatchFn: async (opts) => {
          receivedOpts = opts
          return { rung: 'deeplink', detail: 'x' }
        },
      })
      const res = fakeRes()
      await run(
        mwCursor,
        fakeReq('POST', '/__the-forge/dispatch', { markdown: '# override' }, { host: 'localhost:5173' }),
        res
      )
      expect(receivedOpts.markdown).toBe('# override')
    })
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

  // ---------------------------------------------------------------------------
  // Embedded rung (Task 5)
  // ---------------------------------------------------------------------------

  /** Minimal fake for the dispatch tests — only state() and notifyDesignEdits() are called
   * by the /dispatch handler; the rest of SessionManager is irrelevant here. */
  function fakeDispatchSession(state: string, calls: { notify: number }): ForgeSessionHandles {
    return {
      manager: {
        state: () => state,
        notifyDesignEdits: () => { calls.notify++ },
      } as unknown as SessionManager,
      approvals: {} as ApprovalRegistry,
      onApproval: () => () => {},
    }
  }

  describe('embedded rung (Task 5)', () => {
    it('ready → rung: embedded + notifyDesignEdits called once', async () => {
      queue.add({}, 'pending markdown')
      const calls = { notify: 0 }
      const session = fakeDispatchSession('ready', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code',
        channelsFlag: false,
        dispatchFn: async () => ({ rung: 'manual' as const, detail: 'should never reach ladder' }),
      }, undefined, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'embedded', detail: 'delivered to the embedded session' })
      expect(calls.notify).toBe(1)
    })

    it('starting → rung: embedded (delivered) + notifyDesignEdits called', async () => {
      queue.add({}, 'pending markdown')
      const calls = { notify: 0 }
      const session = fakeDispatchSession('starting', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code', channelsFlag: false,
      }, undefined, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'embedded', detail: 'delivered to the embedded session' })
      expect(calls.notify).toBe(1)
    })

    it('busy embedded beats live watcher → rung: embedded, notifyDesignEdits called', async () => {
      const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 5_000 })
      const waitRes = fakeRes()
      void run(
        createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false }, hub),
        fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }),
        waitRes
      )
      await new Promise((r) => setTimeout(r, 10)) // park the watcher so hub.isLive() === true

      queue.add({}, 'pending markdown')
      const calls = { notify: 0 }
      const session = fakeDispatchSession('busy', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code', channelsFlag: false,
        dispatchFn: async () => ({ rung: 'manual' as const, detail: 'should never reach' }),
      }, hub, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'embedded', detail: 'delivered to the embedded session' })
      expect(calls.notify).toBe(1)
      waitRes.emitClose()
    })

    it('idle + no live watcher → rung: embedded (starting), notifyDesignEdits called', async () => {
      queue.add({}, 'pending markdown')
      const calls = { notify: 0 }
      const session = fakeDispatchSession('idle', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code', channelsFlag: false,
      }, undefined, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'embedded', detail: 'starting embedded session' })
      expect(calls.notify).toBe(1)
    })

    it('failed + no live watcher → auto-start retry (rung: embedded starting)', async () => {
      queue.add({}, 'pending markdown')
      const calls = { notify: 0 }
      const session = fakeDispatchSession('failed', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code', channelsFlag: false,
      }, undefined, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'embedded', detail: 'starting embedded session' })
      expect(calls.notify).toBe(1)
    })

    it('idle + live watcher → watcher rung, notifyDesignEdits NOT called', async () => {
      // External watcher wins over auto-starting the embedded session — the user deliberately
      // linked that terminal session, so it takes priority over spawning a headless one.
      const hub = new WatcherHub({ claim: () => queue.pull(), holdMs: 5_000 })
      const waitRes = fakeRes()
      void run(
        createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false }, hub),
        fakeReq('POST', '/__the-forge/wait', {}, { host: 'localhost:5173' }),
        waitRes
      )
      await new Promise((r) => setTimeout(r, 10)) // park the watcher

      const calls = { notify: 0 }
      const session = fakeDispatchSession('idle', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code', channelsFlag: false,
      }, hub, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'watcher', detail: 'delivered to your linked session' })
      expect(calls.notify).toBe(0)
      waitRes.emitClose()
    })

    it('body agent override to cursor skips the embedded rung even when config agent is claude-code', async () => {
      // resolvedAgent (body override wins over config) is what gates the embedded rung —
      // a cursor-targeted Send must never be delivered to the claude-code embedded session.
      queue.add({}, 'pending markdown')
      const calls = { notify: 0 }
      const session = fakeDispatchSession('ready', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code',
        channelsFlag: false,
        dispatchFn: async () => ({ rung: 'manual' as const, detail: 'ladder ran for cursor override' }),
      }, undefined, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', { agent: 'cursor' }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'manual', detail: 'ladder ran for cursor override' })
      expect(calls.notify).toBe(0)
    })

    it('agent=codex skips the embedded rung entirely → falls through to ladder', async () => {
      // codex has no embedded adapter yet (§3.4) — it uses tmux/manual.
      queue.add({}, 'pending markdown')
      const calls = { notify: 0 }
      const session = fakeDispatchSession('ready', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'codex',
        channelsFlag: false,
        dispatchFn: async () => ({ rung: 'manual' as const, detail: 'ladder ran for codex' }),
      }, undefined, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'manual', detail: 'ladder ran for codex' })
      expect(calls.notify).toBe(0)
    })

    it('embedded: false disables the rung → ladder runs, session never touched', async () => {
      // The policy escape hatch (research doc §Billing): a consumer can opt back into
      // terminal-only dispatch without a plugin release if Anthropic's headless posture flips.
      queue.add({}, 'pending markdown')
      const calls = { notify: 0 }
      const session = fakeDispatchSession('ready', calls)
      const mwEmbed = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code',
        channelsFlag: false,
        embedded: false,
        dispatchFn: async () => ({ rung: 'manual' as const, detail: 'ladder ran' }),
      }, undefined, session)
      const res = fakeRes()
      await run(mwEmbed, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'manual', detail: 'ladder ran' })
      expect(calls.notify).toBe(0)
    })

    it('session not wired → embedded check skipped, existing behavior unchanged', async () => {
      // Backward compat: callers that omit the session param still hit the ladder.
      queue.add({}, 'pending markdown')
      const mwNoSession = createForgeMiddleware(queue, [], undefined, {
        agent: 'claude-code',
        channelsFlag: false,
        dispatchFn: async () => ({ rung: 'manual' as const, detail: 'normal ladder' }),
      })
      const res = fakeRes()
      await run(mwNoSession, fakeReq('POST', '/__the-forge/dispatch', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ rung: 'manual', detail: 'normal ladder' })
    })
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

describe('GET /.well-known/appspecific/com.chrome.devtools.json (Chrome DevTools Automatic Workspace Folders — task A5)', () => {
  it('exports the exact well-known path constant', () => {
    expect(DEVTOOLS_JSON_PATH).toBe('/.well-known/appspecific/com.chrome.devtools.json')
  })

  it('200s with workspace root + a stable uuid when dispatchConfig.cwd is configured', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const mwWithCwd = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, cwd })
    const res = fakeRes()
    await run(mwWithCwd, fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.workspace.root).toBe(cwd)
    expect(body.workspace.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('the uuid is stable across repeated requests (same middleware instance)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const mwWithCwd = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, cwd })
    const res1 = fakeRes()
    await run(mwWithCwd, fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: 'localhost:5173' }), res1)
    const res2 = fakeRes()
    await run(mwWithCwd, fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: 'localhost:5173' }), res2)
    expect(JSON.parse(res1.body).workspace.uuid).toBe(JSON.parse(res2.body).workspace.uuid)
  })

  it('strips a query string before matching the well-known path', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const mwWithCwd = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, cwd })
    const res = fakeRes()
    await run(mwWithCwd, fakeReq('GET', `${DEVTOOLS_JSON_PATH}?foo=bar`, undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).workspace.root).toBe(cwd)
  })

  it('falls through to next() unchanged when dispatchConfig.cwd is absent (legacy tests/callers)', async () => {
    // Default `mw` from beforeEach is constructed with the default dispatchConfig (no cwd).
    let nexted = false
    const res = fakeRes()
    await new Promise<void>((resolve) => {
      mw(fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: 'localhost:5173' }) as never, res as never, () => {
        nexted = true
        resolve()
      })
    })
    expect(nexted).toBe(true)
    expect(res.statusCode).toBe(0) // never written to — next() was called, not send()
  })

  it('403s a disallowed Host header even with cwd configured — the response leaks an absolute filesystem path', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const mwWithCwd = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, cwd })
    const res = fakeRes()
    await run(mwWithCwd, fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: 'evil.com:5173' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('allows Host: 127.0.0.1 and localhost equally (same DNS-rebinding gate as the rest of the middleware)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const mwWithCwd = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, cwd })
    const res = fakeRes()
    await run(mwWithCwd, fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: '127.0.0.1:5173' }), res)
    expect(res.statusCode).toBe(200)
  })

  it('does not require the X-Forge-Secret header — Chrome DevTools cannot send custom headers on this request', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const SECRET = 'devtools-secret'
    const securedWithCwd = createForgeMiddleware(queue, [], SECRET, { agent: 'claude-code', channelsFlag: false, cwd })
    const res = fakeRes()
    await run(securedWithCwd, fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(200)
  })

  it('403s when X-Forwarded-Host is a disallowed host even though Host is loopback (Next proxy rewrites Host)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const mwWithCwd = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, cwd })
    const res = fakeRes()
    await run(
      mwWithCwd,
      fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: '127.0.0.1:4568', 'x-forwarded-host': 'evil.com:3000' }),
      res
    )
    expect(res.statusCode).toBe(403)
  })

  it('200s when X-Forwarded-Host is an allowed host (the proxied Next path)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const mwWithCwd = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, cwd })
    const res = fakeRes()
    await run(
      mwWithCwd,
      fakeReq('GET', DEVTOOLS_JSON_PATH, undefined, { host: '127.0.0.1:4568', 'x-forwarded-host': 'localhost:5175' }),
      res
    )
    expect(res.statusCode).toBe(200)
  })

  // Non-GET: 405, matching the convention this middleware already uses for every other route
  // it owns (e.g. POST /pull, /mark, /wait all 405 on the wrong method) — consistent behavior
  // rather than inventing a bespoke fall-through just for this one route.
  it('405s a non-GET method rather than falling through to next()', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devtools-cwd-'))
    const mwWithCwd = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false, cwd })
    const res = fakeRes()
    await run(mwWithCwd, fakeReq('POST', DEVTOOLS_JSON_PATH, undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(405)
  })
})

describe('POST /__the-forge/unwatch', () => {
  it('rejects GET with 405', async () => {
    const res = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/unwatch', undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('requires the secret when one is configured', async () => {
    const secured = createForgeMiddleware(queue, [], 'test-secret')
    const res = fakeRes()
    await run(secured, fakeReq('POST', '/__the-forge/unwatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('unlinks a parked watcher: its /wait resolves {stop, unlinked} and /status reports none', async () => {
    const hub = new WatcherHub({ claim: () => queue.pull() })
    const SECRET = 'test-secret'
    const mwWithHub = createForgeMiddleware(queue, [], SECRET, { agent: 'claude-code', channelsFlag: false }, hub)
    const { promise } = hub.wait('tok-e2e')
    const res = fakeRes()
    await run(
      mwWithHub,
      fakeReq('POST', '/__the-forge/unwatch', {}, { host: 'localhost:5173', 'x-forge-secret': SECRET }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ watcher: 'none' })
    await expect(promise).resolves.toEqual({ stop: true, reason: 'unlinked' })
    const statusRes = fakeRes()
    await run(mwWithHub, fakeReq('GET', '/__the-forge/status?ids=', undefined, { host: 'localhost:5173' }), statusRes)
    expect(JSON.parse(statusRes.body).watcher).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// Session endpoints (Task 4)
// ---------------------------------------------------------------------------

/** A fake SessionAdapter that lets tests emit events manually. */
class FakeAdapter implements SessionAdapter {
  onEvent: (e: SessionEvent) => void = () => {}
  start(_opts: { cwd: string; resumeId?: string }) {}
  sendTurn(_text: string) {}
  interrupt() {}
  stop() {}
  emit(e: SessionEvent) { this.onEvent(e) }
}

/** Streaming response stub — tracks written NDJSON lines. */
function fakeStreamRes() {
  const r = {
    statusCode: 0,
    lines: [] as string[],
    headers: {} as Record<string, string>,
    listeners: {} as Record<string, () => void>,
    on(event: string, cb: () => void) { this.listeners[event] = cb },
    emitClose() { this.listeners['close']?.() },
    setHeader(k: string, v: string) { this.headers[k] = v },
    write(s: string) { this.lines.push(...s.split('\n').filter(Boolean)) },
    flushHeaders() {},
    end() {},
  }
  return r
}

/** Build a ForgeSessionHandles-compatible test fixture with a fan-out broadcaster
 * wired to the registry's onChange — mirrors the wiring createForgeRuntime will do. */
function makeTestSession(manager: SessionManager): { session: ForgeSessionHandles; approvals: ApprovalRegistry } {
  const listeners = new Set<(e: ApprovalFeedItem) => void>()
  const approvals = new ApprovalRegistry({
    onChange: (e) => { for (const fn of listeners) fn(e) },
  })
  const session: ForgeSessionHandles = {
    manager,
    approvals,
    onApproval: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return { session, approvals }
}

describe('session endpoints (Task 4)', () => {
  const SECRET = 'session-secret'
  let sessionDir: string
  let adapter: FakeAdapter
  let manager: SessionManager
  let session: ForgeSessionHandles
  let approvals: ApprovalRegistry
  let mwSession: ReturnType<typeof createForgeMiddleware>
  let mwSecured: ReturnType<typeof createForgeMiddleware>

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-session-'))
    adapter = new FakeAdapter()
    manager = new SessionManager({
      makeAdapter: () => adapter,
      forgeDir: sessionDir,
      cwd: sessionDir,
    })
    const built = makeTestSession(manager)
    session = built.session
    approvals = built.approvals

    mwSession = createForgeMiddleware(queue, [], undefined, { agent: 'claude-code', channelsFlag: false }, undefined, session)
    mwSecured = createForgeMiddleware(queue, [], SECRET, { agent: 'claude-code', channelsFlag: false }, undefined, session)
  })

  describe('absent session → 404 for all new paths', () => {
    it('GET /session/events 404s when session not wired', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body)).toEqual({ error: 'embedded session unavailable' })
    })

    it('POST /session/interrupt 404s when session not wired', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/session/interrupt', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body)).toEqual({ error: 'embedded session unavailable' })
    })

    it('POST /approval 404s when session not wired', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/approval', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body)).toEqual({ error: 'embedded session unavailable' })
    })

    it('POST /approval/decide 404s when session not wired', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('POST', '/__the-forge/approval/decide', { id: 'x', allow: true }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body)).toEqual({ error: 'embedded session unavailable' })
    })
  })

  describe('secret gating', () => {
    it('GET /session/events 403s without the secret when one is configured', async () => {
      const res = fakeRes()
      await run(mwSecured, fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'missing or invalid X-Forge-Secret' })
    })

    it('GET /session/events 403s with a wrong secret', async () => {
      const res = fakeRes()
      await run(mwSecured, fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173', 'x-forge-secret': 'wrong' }), res)
      expect(res.statusCode).toBe(403)
    })

    it('POST /session/interrupt 403s without the secret', async () => {
      const res = fakeRes()
      await run(mwSecured, fakeReq('POST', '/__the-forge/session/interrupt', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(403)
    })

    it('POST /approval 403s without the secret', async () => {
      const res = fakeRes()
      await run(mwSecured, fakeReq('POST', '/__the-forge/approval', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(403)
    })

    it('POST /approval/decide 403s without the secret', async () => {
      const res = fakeRes()
      await run(mwSecured, fakeReq('POST', '/__the-forge/approval/decide', { id: 'x', allow: true }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(403)
    })
  })

  describe('GET /__the-forge/session/events', () => {
    it('responds 200 with Content-Type application/x-ndjson', () => {
      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})
      expect(res.statusCode).toBe(200)
      expect(res.headers['Content-Type']).toBe('application/x-ndjson')
    })

    it('replays buffered feed events from eventsSince(since)', () => {
      // Push an event to the manager's ring first
      manager.notifyDesignEdits() // spawn + immediate pull turn → busy
      adapter.emit({ kind: 'started', sessionId: 'sid1', model: 'm1', mcpLoaded: false }) // seq=1
      adapter.emit({ kind: 'assistant-text', text: 'hello' }) // seq=2

      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events?since=0', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})

      expect(res.lines.length).toBeGreaterThanOrEqual(2)
      const parsed = res.lines.map((l) => JSON.parse(l))
      expect(parsed.some((p) => p.type === 'feed' && p.event.kind === 'started')).toBe(true)
      expect(parsed.some((p) => p.type === 'feed' && p.event.kind === 'assistant-text')).toBe(true)
    })

    it('respects the since parameter (only events strictly after since)', () => {
      manager.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'sid', model: 'm', mcpLoaded: false }) // seq=1
      adapter.emit({ kind: 'assistant-text', text: 'old' }) // seq=2
      adapter.emit({ kind: 'assistant-text', text: 'new' }) // seq=3

      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events?since=2', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})

      const parsed = res.lines.map((l) => JSON.parse(l))
      // Only seq=3 in replay
      const feedLines = parsed.filter((p) => p.type === 'feed')
      expect(feedLines).toHaveLength(1)
      expect(feedLines[0].seq).toBe(3)
      expect(feedLines[0].event.text).toBe('new')
    })

    it('replays pending approvals as type=approval rows', () => {
      approvals.request('bash', 'ls -la')

      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})

      const parsed = res.lines.map((l) => JSON.parse(l))
      const approvalRow = parsed.find((p) => p.type === 'approval')
      expect(approvalRow).toBeDefined()
      expect(approvalRow.toolName).toBe('bash')
      expect(approvalRow.detail).toBe('ls -la')
    })

    it('pushes live feed events after connection', () => {
      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})

      const before = res.lines.length
      // Start session then emit a live event
      manager.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'live-sid', model: 'm', mcpLoaded: false })

      expect(res.lines.length).toBeGreaterThan(before)
      const newLines = res.lines.slice(before).map((l) => JSON.parse(l))
      expect(newLines.some((p) => p.type === 'feed' && p.event.kind === 'started')).toBe(true)
    })

    it('pushes live approval-request events', () => {
      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})

      const before = res.lines.length
      approvals.request('write', 'src/index.ts')

      const newLines = res.lines.slice(before).map((l) => JSON.parse(l))
      expect(newLines.some((p) => p.type === 'approval' && p.toolName === 'write')).toBe(true)
    })

    it('pushes live approval-resolved events when decided', () => {
      const { id } = approvals.request('bash', 'echo hi')
      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})

      const before = res.lines.length
      approvals.decide(id, true)

      const newLines = res.lines.slice(before).map((l) => JSON.parse(l))
      expect(newLines.some((p) => p.type === 'approval-resolved' && p.id === id && p.allow === true)).toBe(true)
    })

    it('close unsubscribes both manager and approval listeners — no further writes', () => {
      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})

      res.emitClose()

      const before = res.lines.length
      // Events after close should NOT appear
      manager.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'post-close', model: 'm', mcpLoaded: false })
      approvals.request('bash', 'after close')

      expect(res.lines.length).toBe(before) // no new lines written after close
    })

    it('non-numeric since defaults to 0', () => {
      manager.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's', model: 'm', mcpLoaded: false }) // seq=1

      const res = fakeStreamRes()
      mwSession(fakeReq('GET', '/__the-forge/session/events?since=abc', undefined, { host: 'localhost:5173' }) as never, res as never, () => {})

      const parsed = res.lines.map((l) => JSON.parse(l))
      expect(parsed.some((p) => p.type === 'feed' && p.seq === 1)).toBe(true)
    })
  })

  describe('POST /__the-forge/session/interrupt', () => {
    it('calls manager.interrupt() and responds with {state}', async () => {
      const interruptSpy = vi.spyOn(manager, 'interrupt')
      const res = fakeRes()
      await run(mwSession, fakeReq('POST', '/__the-forge/session/interrupt', {}, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(interruptSpy).toHaveBeenCalledTimes(1)
      const body = JSON.parse(res.body)
      expect(body).toHaveProperty('state')
      expect(body.state).toBe(manager.state())
    })

    it('responds 405 to GET', async () => {
      const res = fakeRes()
      await run(mwSession, fakeReq('GET', '/__the-forge/session/interrupt', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(405)
    })
  })

  describe('POST /__the-forge/approval', () => {
    it('long-poll resolves with {behavior:allow} when decided allow', async () => {
      const approvalRes = fakeRes()
      const approvalPromise = run(mwSession, fakeReq('POST', '/__the-forge/approval', { toolName: 'bash', detail: 'ls' }, { host: 'localhost:5173' }), approvalRes)

      // Wait for body parsing + approvals.request() to register the approval
      await new Promise((r) => setTimeout(r, 20))

      const pending = approvals.pending()
      expect(pending).toHaveLength(1)
      const { id } = pending[0]

      const decideRes = fakeRes()
      await run(mwSession, fakeReq('POST', '/__the-forge/approval/decide', { id, allow: true }, { host: 'localhost:5173' }), decideRes)

      await approvalPromise
      expect(approvalRes.statusCode).toBe(200)
      expect(JSON.parse(approvalRes.body)).toEqual({ behavior: 'allow' })
    })

    it('long-poll resolves with {behavior:deny, reason:user} when decided deny', async () => {
      const approvalRes = fakeRes()
      const approvalPromise = run(mwSession, fakeReq('POST', '/__the-forge/approval', { toolName: 'bash', detail: 'rm -rf' }, { host: 'localhost:5173' }), approvalRes)

      await new Promise((r) => setTimeout(r, 20))
      const { id } = approvals.pending()[0]

      const decideRes = fakeRes()
      await run(mwSession, fakeReq('POST', '/__the-forge/approval/decide', { id, allow: false }, { host: 'localhost:5173' }), decideRes)

      await approvalPromise
      expect(JSON.parse(approvalRes.body)).toEqual({ behavior: 'deny', reason: 'user' })
    })

    it('treats missing toolName/detail as empty strings', async () => {
      const approvalRes = fakeRes()
      const approvalPromise = run(mwSession, fakeReq('POST', '/__the-forge/approval', {}, { host: 'localhost:5173' }), approvalRes)

      await new Promise((r) => setTimeout(r, 20))
      const pending = approvals.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].toolName).toBe('')
      expect(pending[0].detail).toBe('')

      approvals.decide(pending[0].id, true)
      await approvalPromise
      expect(approvalRes.statusCode).toBe(200)
    })

    it('405s on GET', async () => {
      const res = fakeRes()
      await run(mwSession, fakeReq('GET', '/__the-forge/approval', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(405)
    })
  })

  describe('POST /__the-forge/approval/decide', () => {
    it('returns {ok:true} for a known pending approval id', async () => {
      const { id } = approvals.request('bash', 'test')
      const res = fakeRes()
      await run(mwSession, fakeReq('POST', '/__the-forge/approval/decide', { id, allow: true }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true })
    })

    it('returns {ok:false} for an unknown id', async () => {
      const res = fakeRes()
      await run(mwSession, fakeReq('POST', '/__the-forge/approval/decide', { id: 'nonexistent-id', allow: false }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: false })
    })

    it('400s when id is missing', async () => {
      const res = fakeRes()
      await run(mwSession, fakeReq('POST', '/__the-forge/approval/decide', { allow: true }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(400)
    })

    it('400s when allow is not a boolean', async () => {
      const res = fakeRes()
      await run(mwSession, fakeReq('POST', '/__the-forge/approval/decide', { id: 'x', allow: 'yes' }, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(400)
    })

    it('405s on GET', async () => {
      const res = fakeRes()
      await run(mwSession, fakeReq('GET', '/__the-forge/approval/decide', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(405)
    })
  })

  describe('GET /__the-forge/status session field', () => {
    it('includes session=manager.state() when session is wired', async () => {
      const res = fakeRes()
      await run(mwSession, fakeReq('GET', '/__the-forge/status', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.session).toBe(manager.state()) // 'idle' initially
    })

    it('includes session="unavailable" when no session param is wired', async () => {
      const res = fakeRes()
      await run(mw, fakeReq('GET', '/__the-forge/status', undefined, { host: 'localhost:5173' }), res)
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.session).toBe('unavailable')
    })

    it('session field reflects live state transitions', async () => {
      manager.notifyDesignEdits() // spawn + immediate pull turn → busy
      const res = fakeRes()
      await run(mwSession, fakeReq('GET', '/__the-forge/status', undefined, { host: 'localhost:5173' }), res)
      expect(JSON.parse(res.body).session).toBe('busy')
    })
  })
})

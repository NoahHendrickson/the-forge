import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { createForgeRuntime } from '../../src/server/runtime'
import { SessionManager } from '../../src/server/session/manager'
import { ApprovalRegistry } from '../../src/server/session/approvals'
import { CursorAdapter } from '../../src/server/session/cursor'
import { INIT_RESPONSE, SESSION_NEW_RESPONSE, PERMISSION_REQUEST_EXECUTE } from './session/fixtures/cursor-acp-jsonrpc'

// Never spawns a real cursor-agent/claude process — createForgeRuntime's factory (Task 4)
// unconditionally constructs adapters with the default (real) spawnFn, so the makeAdapter
// factory tests below intercept node:child_process's own spawn, the same seam
// ClaudeAdapter/CursorAdapter's defaultSpawnFn calls through.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const spawnMock = vi.mocked(spawn)

/** In-memory fake child (PassThrough stdio, no real process) — mirrors tests/server/session/
 * cursor.test.ts's makeChild/makeFakeSpawn exactly, just wired through the module mock above
 * instead of an injected SpawnFn (createForgeRuntime never exposes one to inject). */
function makeFakeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  return {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    on: vi.fn(),
  }
}

function pushLine(child: ReturnType<typeof makeFakeChild>, line: string) {
  child.stdout.write(line + '\n')
}

/** Synchronously drains every JSON line written to the fake child's stdin so far. */
function readWrites(child: ReturnType<typeof makeFakeChild>): Array<Record<string, unknown>> {
  const raw: string[] = []
  let chunk: Buffer | string | null
  while ((chunk = child.stdin.read() as Buffer | string | null) !== null) {
    raw.push(typeof chunk === 'string' ? chunk : chunk.toString())
  }
  return raw
    .join('')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const tick = () => new Promise((r) => setImmediate(r))

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-'))
  spawnMock.mockReset()
})

describe('createForgeRuntime', () => {
  it('constructs a Queue rooted at <resolvedRoot>/.the-forge', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.forgeDir).toBe(path.join(root, '.the-forge'))
    const item = runtime.queue.add({}, '# md')
    expect(fs.existsSync(path.join(runtime.forgeDir, 'queue.json'))).toBe(true)
    expect(runtime.queue.get(item.id)!.markdown).toBe('# md')
  })

  it('generates a fresh secret per call', () => {
    const a = createForgeRuntime(root)
    const b = createForgeRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-')))
    expect(a.secret).not.toBe(b.secret)
    expect(typeof a.secret).toBe('string')
    expect(a.secret.length).toBeGreaterThan(0)
  })

  it('wires the hub so claim() pulls from the SAME queue', async () => {
    const runtime = createForgeRuntime(root)
    runtime.queue.add({}, '# for the hub')
    // The hub's `wait()` claims immediately when items are already claimable (no need to
    // wait out the hold window) — proves hub.claim === () => queue.pull() wiring end to end.
    const { promise } = runtime.hub.wait()
    const result = await promise
    expect(result).toMatchObject({ stop: false })
    if (!result.stop) {
      expect(result.items).toHaveLength(1)
      expect(result.items[0].markdown).toBe('# for the hub')
    }
    // The item is now claimed in the queue itself (not a copy) — same instance.
    expect(runtime.queue.list()[0].status).toBe('claimed')
  })

  it('wires hub.applying() to queue.hasFreshClaims()', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.hub.state()).toBe('none')
    const item = runtime.queue.add({}, '# fresh claim test')
    runtime.queue.pull() // claims it — hasFreshClaims() now true
    expect(runtime.queue.get(item.id)!.status).toBe('claimed')
    // hasFreshClaims driving applying() is exercised indirectly via WatcherHub.state() in
    // endpoints/watchers suites; here we just assert the queue backing is the same instance.
    expect(runtime.queue.hasFreshClaims()).toBe(true)
  })

  it('when viteRoot is omitted, does not attempt legacy-dir migration (no viteRoot to migrate from)', () => {
    // Would throw/behave oddly if it tried to migrate from a nonexistent viteRoot other than
    // resolvedRoot; omitting viteRoot must simply skip migrateLegacyForgeDir entirely.
    expect(() => createForgeRuntime(root)).not.toThrow()
  })

  it('when viteRoot is provided and differs from resolvedRoot, migrates a legacy queue.json', () => {
    const viteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-viteroot-'))
    const legacyDir = path.join(viteRoot, '.the-forge')
    fs.mkdirSync(legacyDir, { recursive: true })
    const legacyItem = {
      id: 'legacy-1',
      createdAt: new Date().toISOString(),
      status: 'pending',
      markdown: '# legacy',
      request: null,
    }
    fs.writeFileSync(path.join(legacyDir, 'queue.json'), JSON.stringify([legacyItem]))

    const runtime = createForgeRuntime(root, viteRoot)
    expect(runtime.queue.get('legacy-1')?.markdown).toBe('# legacy')
    // Legacy queue.json is removed by the migration once merged.
    expect(fs.existsSync(path.join(legacyDir, 'queue.json'))).toBe(false)
  })
})

describe('createForgeRuntime — session group (Task 4)', () => {
  it('exposes session.manager as a SessionManager instance', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.session.manager).toBeInstanceOf(SessionManager)
  })

  it('exposes session.approvals as an ApprovalRegistry instance', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.session.approvals).toBeInstanceOf(ApprovalRegistry)
  })

  it('session.manager starts idle (no processes spawned at construction)', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.session.manager.state()).toBe('idle')
  })

  it('session.approvals starts with no pending approvals (idle-zero)', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.session.approvals.pending()).toHaveLength(0)
  })

  it('session.onApproval fan-out: listeners receive approval events from the registry', () => {
    const runtime = createForgeRuntime(root)
    const received: unknown[] = []
    const unsub = runtime.session.onApproval((e) => received.push(e))

    const { id } = runtime.session.approvals.request('bash', 'ls')
    expect(received).toHaveLength(1)
    expect((received[0] as { kind: string }).kind).toBe('approval-request')

    runtime.session.approvals.decide(id, true)
    expect(received).toHaveLength(2)
    expect((received[1] as { kind: string }).kind).toBe('approval-resolved')

    unsub()
    runtime.session.approvals.request('write', 'x')
    expect(received).toHaveLength(2) // no more after unsubscribe
  })

  it('multiple onApproval subscribers each receive the event (fan-out)', () => {
    const runtime = createForgeRuntime(root)
    const a: unknown[] = []
    const b: unknown[] = []
    const unsubA = runtime.session.onApproval((e) => a.push(e))
    const unsubB = runtime.session.onApproval((e) => b.push(e))

    runtime.session.approvals.request('bash', 'test')
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)

    unsubA()
    unsubB()
  })

  it('wires approval lifecycle into the manager watchdog (suspend on request, resume on decide)', () => {
    // The watchdog must not count down while a human is deciding an approval, and an
    // allowed tool gets the longer post-approval leash — that wiring lives HERE, where
    // both the registry and the manager exist (approvals.ts must not import manager.ts).
    const runtime = createForgeRuntime(root)
    const pendingSpy = vi.spyOn(runtime.session.manager, 'onApprovalPending')
    const resolvedSpy = vi.spyOn(runtime.session.manager, 'onApprovalResolved')

    const { id } = runtime.session.approvals.request('Bash', 'npm test')
    expect(pendingSpy).toHaveBeenCalledTimes(1)

    runtime.session.approvals.decide(id, true)
    expect(resolvedSpy).toHaveBeenCalledTimes(1)
    expect(resolvedSpy).toHaveBeenCalledWith(true)
  })
})

describe('createForgeRuntime — harness-keyed adapter factory (Task 4)', () => {
  it("defaultAgent 'cursor' -> manager.harness() is 'cursor'", () => {
    const runtime = createForgeRuntime(root, undefined, { defaultAgent: 'cursor' })
    expect(runtime.session.manager.harness()).toBe('cursor')
  })

  it("defaultAgent 'codex' -> manager.harness() falls back to 'claude-code' (no embedded codex adapter until C2)", () => {
    const runtime = createForgeRuntime(root, undefined, { defaultAgent: 'codex' })
    expect(runtime.session.manager.harness()).toBe('claude-code')
  })

  it('opts omitted entirely -> manager.harness() defaults to claude-code', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.session.manager.harness()).toBe('claude-code')
  })

  it('makeAdapter constructs a CursorAdapter for harness cursor, spawning cursor-agent acp', () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child as never)

    const runtime = createForgeRuntime(root, undefined, { defaultAgent: 'cursor' })
    runtime.session.manager.notifyDesignEdits() // idle -> _start() -> makeAdapter({harness:'cursor'})

    expect(spawnMock).toHaveBeenCalledWith('cursor-agent', ['acp'], expect.objectContaining({ cwd: root }))
  })

  it('makeAdapter constructs a ClaudeAdapter (not cursor-agent) for harness claude-code', () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child as never)

    const runtime = createForgeRuntime(root) // defaultHarness claude-code
    runtime.session.manager.notifyDesignEdits()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][0]).toBe('claude')
  })

  it('cursor onApproval is wired to the SAME ApprovalRegistry the runtime exposes: request -> decide(allow) resolves the adapter round trip (allow_once answered on the wire)', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child as never)

    const runtime = createForgeRuntime(root, undefined, { defaultAgent: 'cursor' })
    runtime.session.manager.notifyDesignEdits() // spawns the CursorAdapter, sends the pull turn

    // Drive the adapter through the ACP boot handshake (fresh session/new — no resumeId yet).
    pushLine(child, INIT_RESPONSE)
    pushLine(child, SESSION_NEW_RESPONSE)
    await tick()

    expect(runtime.session.approvals.pending()).toHaveLength(0)

    // An execute-kind tool_call triggers session/request_permission — NOT edit-kind and NOT
    // the-forge's own MCP tool, so it's the one kind CursorAdapter routes to onApproval rather
    // than auto-allowing (see cursor.ts's kind-split why-comment).
    pushLine(child, PERMISSION_REQUEST_EXECUTE)
    await tick()

    const pending = runtime.session.approvals.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].toolName).toBe('execute')
    expect(pending[0].detail).toBe('`touch /tmp/forge-spike-probe`')

    // decide(allow) on the runtime's OWN registry resolves the adapter's onApproval promise —
    // proving makeAdapter wired a.onApproval to THIS registry, not a disconnected one.
    runtime.session.approvals.decide(pending[0].id, true)
    await tick()

    const writes = readWrites(child)
    const answer = writes.find((m) => m.id === 0 && 'result' in m)
    expect(answer).toBeDefined()
    expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })
})

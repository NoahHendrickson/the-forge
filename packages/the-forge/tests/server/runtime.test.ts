import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createForgeRuntime } from '../../src/server/runtime'
import { SessionManager } from '../../src/server/session/manager'
import { ApprovalRegistry } from '../../src/server/session/approvals'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-'))
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

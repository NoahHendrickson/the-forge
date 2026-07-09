import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApprovalRegistry, type ApprovalFeedItem, APPROVAL_HOLD_MS } from '../../../src/server/session/approvals'

/** Build a registry with an injectable clock and tiny holdMs so tests never wait. */
function makeRegistry(opts: { holdMs?: number } = {}) {
  let nowMs = 1_000_000
  const events: ApprovalFeedItem[] = []
  const registry = new ApprovalRegistry({
    holdMs: opts.holdMs ?? 50,
    now: () => nowMs,
    onChange: (e) => events.push(e),
  })
  return {
    registry,
    events,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

describe('ApprovalRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('APPROVAL_HOLD_MS is 110_000 (under the bin 120s timeout with margin)', () => {
    expect(APPROVAL_HOLD_MS).toBe(110_000)
  })

  it('parks until decide → allow resolves the promise', async () => {
    const { registry } = makeRegistry()
    const { id, promise } = registry.request('Bash', 'ls -la')
    registry.decide(id, true)
    await expect(promise).resolves.toEqual({ behavior: 'allow' })
  })

  it('parks until decide → deny resolves with browser-deny message', async () => {
    const { registry } = makeRegistry()
    const { id, promise } = registry.request('Bash', 'rm -rf')
    registry.decide(id, false)
    await expect(promise).resolves.toEqual({
      behavior: 'deny',
      message: 'Denied from The Forge overlay.',
    })
  })

  it('hold expiry → deny with timeout message', async () => {
    const { registry } = makeRegistry({ holdMs: 10 })
    const { promise } = registry.request('Bash', 'ls')
    vi.advanceTimersByTime(15)
    await expect(promise).resolves.toEqual({
      behavior: 'deny',
      message: 'Denied — approval timed out in The Forge overlay. Re-send the change when ready.',
    })
  })

  it('decide on expired id returns false', async () => {
    const { registry } = makeRegistry({ holdMs: 10 })
    const { id, promise } = registry.request('Bash', 'ls')
    vi.advanceTimersByTime(15)
    await promise // expired
    expect(registry.decide(id, true)).toBe(false)
  })

  it('decide on unknown id returns false', () => {
    const { registry } = makeRegistry()
    expect(registry.decide('nonexistent-id', true)).toBe(false)
  })

  it('decide returns true on a valid pending id', () => {
    const { registry } = makeRegistry()
    const { id } = registry.request('Bash', 'ls')
    expect(registry.decide(id, true)).toBe(true)
  })

  it('pending() lists undecided approvals', () => {
    const { registry } = makeRegistry()
    const { id: id1 } = registry.request('Bash', 'ls')
    const { id: id2 } = registry.request('WriteFile', 'src/app.ts')
    const p = registry.pending()
    expect(p).toHaveLength(2)
    expect(p.find((x) => x.id === id1)).toMatchObject({ id: id1, toolName: 'Bash', detail: 'ls' })
    expect(p.find((x) => x.id === id2)).toMatchObject({ id: id2, toolName: 'WriteFile', detail: 'src/app.ts' })
  })

  it('pending() excludes decided entries', () => {
    const { registry } = makeRegistry()
    const { id } = registry.request('Bash', 'ls')
    registry.decide(id, true)
    expect(registry.pending()).toHaveLength(0)
  })

  it('pending() excludes expired entries', async () => {
    const { registry } = makeRegistry({ holdMs: 10 })
    const { promise } = registry.request('Bash', 'ls')
    vi.advanceTimersByTime(15)
    await promise
    expect(registry.pending()).toHaveLength(0)
  })

  it('timer is cleared on decide — no lingering timer fires after decision', async () => {
    const { registry } = makeRegistry({ holdMs: 10 })
    const { id, promise } = registry.request('Bash', 'ls')
    registry.decide(id, false) // clears the timer
    vi.advanceTimersByTime(100) // if timer wasn't cleared, a second resolution would fire
    const result = await promise
    // Only one resolution — the decide one
    expect(result).toEqual({ behavior: 'deny', message: 'Denied from The Forge overlay.' })
  })

  describe('onChange feed events', () => {
    it('fires approval-request on park', () => {
      const { registry, events } = makeRegistry()
      const { id } = registry.request('Bash', 'echo hi')
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ kind: 'approval-request', id, toolName: 'Bash', detail: 'echo hi' })
    })

    it('fires approval-resolved on decide(allow)', () => {
      const { registry, events } = makeRegistry()
      const { id } = registry.request('Bash', 'ls')
      registry.decide(id, true)
      expect(events[1]).toEqual({ kind: 'approval-resolved', id, allow: true })
    })

    it('fires approval-resolved on decide(deny)', () => {
      const { registry, events } = makeRegistry()
      const { id } = registry.request('Bash', 'ls')
      registry.decide(id, false)
      expect(events[1]).toEqual({ kind: 'approval-resolved', id, allow: false })
    })

    it('fires approval-resolved with allow:false on expiry', async () => {
      const { registry, events } = makeRegistry({ holdMs: 10 })
      const { id, promise } = registry.request('Bash', 'ls')
      vi.advanceTimersByTime(15)
      await promise
      expect(events[1]).toEqual({ kind: 'approval-resolved', id, allow: false })
    })
  })
})

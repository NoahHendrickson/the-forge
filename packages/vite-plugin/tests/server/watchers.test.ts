import { describe, it, expect } from 'vitest'
import { WatcherHub, type WaitResponse } from '../../src/server/watchers'
import type { QueueItem } from '../../src/server/queue'

function item(id: string): QueueItem {
  return { id, createdAt: '2026-01-01T00:00:00.000Z', status: 'pending', markdown: `## ${id}`, request: null }
}

/** Builds a hub with an injected clock and a mutable claimable list — claim() drains it,
 * mirroring Queue.pull()'s claim-once semantics. Tiny holdMs so no test ever sits through
 * a real hold window. */
function makeHub(opts: { holdMs?: number; idleStopMs?: number; freshMs?: number } = {}) {
  let nowMs = 1_000_000
  const claimable: QueueItem[] = []
  const hub = new WatcherHub({
    claim: () => claimable.splice(0, claimable.length),
    now: () => nowMs,
    holdMs: opts.holdMs ?? 30,
    idleStopMs: opts.idleStopMs ?? 10_000,
    freshMs: opts.freshMs ?? 5_000,
  })
  return {
    hub,
    queueItem: (i: QueueItem) => claimable.push(i),
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

describe('WatcherHub', () => {
  it('claims items queued before the wait arrives (between-cycles delivery)', async () => {
    const { hub, queueItem } = makeHub()
    queueItem(item('a'))
    const { promise } = hub.wait()
    await expect(promise).resolves.toEqual({ stop: false, items: [expect.objectContaining({ id: 'a' })] })
  })

  it('notify() delivers to a parked waiter', async () => {
    const { hub, queueItem } = makeHub()
    const { promise } = hub.wait()
    queueItem(item('b'))
    hub.notify()
    await expect(promise).resolves.toEqual({ stop: false, items: [expect.objectContaining({ id: 'b' })] })
  })

  it('notify() with nothing claimable leaves the waiter parked (raced consumer)', async () => {
    const { hub, queueItem } = makeHub()
    const { promise } = hub.wait()
    hub.notify() // nothing claimable — must NOT resolve empty and burn the hold
    queueItem(item('c'))
    hub.notify()
    const res = await promise
    expect(res).toEqual({ stop: false, items: [expect.objectContaining({ id: 'c' })] })
  })

  it('hold expiry resolves empty (the re-arm tick)', async () => {
    const { hub } = makeHub({ holdMs: 10 })
    const { promise } = hub.wait()
    await expect(promise).resolves.toEqual({ stop: false, items: [] })
  })

  it('idle auto-stop: a wait after idleStopMs of no deliveries gets {stop, idle} and the hub sleeps', async () => {
    const { hub, advance } = makeHub({ holdMs: 5, idleStopMs: 1_000, freshMs: 10_000 })
    await hub.wait().promise // empty tick — starts the watch, does NOT reset the idle clock
    advance(1_500)
    const res = await hub.wait().promise
    expect(res).toEqual({ stop: true, reason: 'idle' })
    // asleep IMMEDIATELY — not live for another freshMs (freshMs here is deliberately huge)
    expect(hub.state()).toBe('asleep')
  })

  it('empty holds do not reset the idle clock (the loop cannot keep itself alive)', async () => {
    const { hub, advance } = makeHub({ holdMs: 5, idleStopMs: 1_000, freshMs: 60_000 })
    await hub.wait().promise
    advance(600)
    await hub.wait().promise // still under idleStopMs — empty tick
    advance(600) // 1200 since watch start, only 600 since last (empty) tick
    const res = await hub.wait().promise
    expect(res).toEqual({ stop: true, reason: 'idle' })
  })

  it('a delivery resets the idle clock', async () => {
    const { hub, queueItem, advance } = makeHub({ holdMs: 5, idleStopMs: 1_000, freshMs: 60_000 })
    await hub.wait().promise
    advance(900)
    queueItem(item('d'))
    await hub.wait().promise // delivers — activity!
    advance(900) // 1800 since watch start but only 900 since delivery
    const res = await hub.wait().promise
    expect(res).toEqual({ stop: false, items: [] })
  })

  it('re-arm after idle-stop resets the idle clock (fresh /forge-watch works immediately)', async () => {
    const { hub, advance } = makeHub({ holdMs: 5, idleStopMs: 1_000 })
    await hub.wait().promise
    advance(1_500)
    await hub.wait().promise // idle stop
    const res = await hub.wait().promise // the user re-armed — must park, not insta-stop
    expect(res).toEqual({ stop: false, items: [] })
    expect(hub.state()).not.toBe('none')
  })

  it('re-arm after a SILENT death (stale heartbeat, no stop ever delivered) also resets the idle clock', async () => {
    const { hub, advance } = makeHub({ holdMs: 5, idleStopMs: 1_000, freshMs: 500 })
    const { cancel } = hub.wait()
    cancel() // bin vanished — no stop response was ever sent, `watching` was never cleared
    advance(2_000) // past BOTH freshMs (heartbeat stale) and idleStopMs
    const res = await hub.wait().promise // fresh /forge-watch — must not be insta-stopped
    expect(res).toEqual({ stop: false, items: [] })
  })

  it('a second wait preempts the first with {stop, replaced}; the new one keeps watching', async () => {
    const { hub, queueItem } = makeHub({ holdMs: 50 })
    const first = hub.wait()
    const second = hub.wait()
    await expect(first.promise).resolves.toEqual({ stop: true, reason: 'replaced' })
    expect(hub.state()).toBe('live') // the hub watches on — only the OLD session was stopped
    queueItem(item('e'))
    hub.notify()
    await expect(second.promise).resolves.toEqual({ stop: false, items: [expect.objectContaining({ id: 'e' })] })
  })

  it('cancel frees the slot without resolving; a later notify does not deliver into the void', async () => {
    const { hub, queueItem } = makeHub({ holdMs: 50 })
    const { promise, cancel } = hub.wait()
    let settled = false
    void promise.then(() => {
      settled = true
    })
    cancel()
    queueItem(item('f'))
    hub.notify() // no parked waiter — items stay claimable for the next wait
    const next = await hub.wait().promise
    expect(next).toEqual({ stop: false, items: [expect.objectContaining({ id: 'f' })] })
    expect(settled).toBe(false)
  })

  describe('state()', () => {
    it('none before anything ever watched', () => {
      const { hub } = makeHub()
      expect(hub.state()).toBe('none')
      expect(hub.isLive()).toBe(false)
    })

    it('live while parked and within the freshness window between cycles', async () => {
      const { hub, advance } = makeHub({ holdMs: 5, freshMs: 1_000 })
      const { promise } = hub.wait()
      expect(hub.state()).toBe('live') // parked
      await promise
      expect(hub.state()).toBe('live') // between cycles, heartbeat fresh
      advance(999)
      expect(hub.state()).toBe('live')
      advance(2)
      expect(hub.state()).toBe('asleep') // heartbeat stale — loop died without a stop
    })

    it('asleep immediately after an idle stop, even with a fresh heartbeat', async () => {
      const { hub, advance } = makeHub({ holdMs: 5, idleStopMs: 100, freshMs: 60_000 })
      await hub.wait().promise
      advance(200)
      await hub.wait().promise // {stop, idle}
      expect(hub.state()).toBe('asleep')
      expect(hub.isLive()).toBe(false)
    })
  })
})

// Type-level guard: WaitResponse's discriminant is `stop`, and the client/bin both rely on it.
const _stopShape: WaitResponse = { stop: true, reason: 'idle' }
const _itemsShape: WaitResponse = { stop: false, items: [] }
void _stopShape
void _itemsShape

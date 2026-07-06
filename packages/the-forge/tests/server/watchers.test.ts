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
  let applying = false
  const claimable: QueueItem[] = []
  const hub = new WatcherHub({
    claim: () => claimable.splice(0, claimable.length),
    applying: () => applying,
    now: () => nowMs,
    holdMs: opts.holdMs ?? 30,
    idleStopMs: opts.idleStopMs ?? 10_000,
    freshMs: opts.freshMs ?? 5_000,
  })
  return {
    hub,
    queueItem: (i: QueueItem) => claimable.push(i),
    setApplying: (v: boolean) => {
      applying = v
    },
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

  it('the re-arm window runs from hold END, not wait entry — a slow re-invoke keeps the full freshMs', async () => {
    // Before the hold-end lastSeen stamp, the effective re-arm margin was freshMs - holdMs:
    // a watcher whose agent took longer than that to re-invoke the tool read as 'asleep',
    // and a Send in the gap went down the keystroke ladder INTO the watching session.
    const { hub, advance } = makeHub({ holdMs: 5, freshMs: 150, idleStopMs: 60_000 })
    const { promise } = hub.wait() // lastSeen stamped at entry (t=0)
    advance(100) // the clock moves while the hold is open
    await promise // hold expires at t=100 — lastSeen re-stamped there
    advance(120) // t=220: stale measured from entry (220 > 150), fresh from hold end (120 < 150)
    expect(hub.state()).toBe('live')
  })

  it('a dropped connection gets no hold-end heartbeat — cancel clears the timer before it can stamp', async () => {
    const { hub, advance } = makeHub({ holdMs: 5, freshMs: 150, idleStopMs: 60_000 })
    const w = hub.wait()
    w.cancel() // socket closed mid-hold — the bin is gone
    advance(1)
    expect(hub.state()).toBe('asleep') // no ghost 'live' window from a phantom hold-end stamp
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

  it('a slow-but-alive loop (gaps beyond freshMs) still hits the idle auto-stop — the cost bound holds', async () => {
    // PR #1 high-severity finding: heartbeat staleness must NOT read as a re-arm, or a
    // loop ticking slower than freshMs would reset its own idle clock forever.
    const { hub, advance } = makeHub({ holdMs: 5, idleStopMs: 1_000, freshMs: 100 })
    await hub.wait().promise // watch starts
    advance(400)
    await hub.wait().promise // gap > freshMs, loop still alive — clock must NOT reset
    advance(400)
    await hub.wait().promise
    advance(400) // 1200 since watch start > idleStopMs
    const res = await hub.wait().promise
    expect(res).toEqual({ stop: true, reason: 'idle' })
  })

  it('applying (claimed items in flight) keeps the watcher live through the apply window', async () => {
    const { hub, advance, setApplying } = makeHub({ holdMs: 5, freshMs: 100, idleStopMs: 60_000 })
    await hub.wait().promise // watch starts; hold expires
    setApplying(true) // the agent is mid-apply — not parked, heartbeat going stale
    advance(500) // well past freshMs
    expect(hub.state()).toBe('live') // a Send now must NOT fall to the keystroke ladder
    setApplying(false) // mark_applied landed but the loop never came back
    expect(hub.state()).toBe('asleep')
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

  it('re-arm after a SILENT death (dropped connection, no stop ever delivered) also resets the idle clock', async () => {
    const { hub, advance } = makeHub({ holdMs: 5, idleStopMs: 1_000, freshMs: 500 })
    const { cancel } = hub.wait()
    cancel() // bin vanished — no stop response was ever sent
    advance(2_000) // past BOTH freshMs and idleStopMs
    const res = await hub.wait().promise // fresh /forge-watch — must not be insta-stopped
    expect(res).toEqual({ stop: false, items: [] })
  })

  it('a dropped connection reads asleep IMMEDIATELY — no ghost-live window for dispatch to claim delivery', () => {
    const { hub } = makeHub({ holdMs: 5_000, freshMs: 60_000 })
    const { cancel } = hub.wait()
    expect(hub.state()).toBe('live')
    cancel() // socket died mid-hold; heartbeat is still fresh, but nobody is watching
    expect(hub.state()).toBe('asleep')
    expect(hub.isLive()).toBe(false)
  })

  it('a STALE cancel (a newer wait already took the slot) does not kill the new watcher', async () => {
    const { hub, queueItem } = makeHub({ holdMs: 5_000 })
    const first = hub.wait()
    const second = hub.wait() // preempts first; first's close event hasn't landed yet
    await first.promise // {stop, replaced}
    first.cancel() // the replaced session's socket close arrives late — must be a no-op
    expect(hub.state()).toBe('live')
    queueItem(item('s'))
    hub.notify()
    await expect(second.promise).resolves.toEqual({ stop: false, items: [expect.objectContaining({ id: 's' })] })
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

  describe('watcher tokens (mechanical no-ping-pong)', () => {
    it('a replaced token that keeps calling is absorbed with {stop, replaced} — the winner is never bumped', async () => {
      const { hub, queueItem } = makeHub({ holdMs: 5_000 })
      const a = hub.wait('token-a')
      const b = hub.wait('token-b') // takes over; a is told replaced
      await expect(a.promise).resolves.toEqual({ stop: true, reason: 'replaced' })

      // Disobedient session A retries anyway — absorbed instantly, B stays parked.
      const aRetry = hub.wait('token-a')
      await expect(aRetry.promise).resolves.toEqual({ stop: true, reason: 'replaced' })
      expect(hub.state()).toBe('live')
      queueItem(item('t'))
      hub.notify()
      await expect(b.promise).resolves.toEqual({ stop: false, items: [expect.objectContaining({ id: 't' })] })
    })

    it('a replaced token may re-arm normally once the winner is gone', async () => {
      const { hub, advance } = makeHub({ holdMs: 5, freshMs: 100, idleStopMs: 60_000 })
      const a = hub.wait('token-a')
      const b = hub.wait('token-b')
      await a.promise // replaced
      b.cancel() // winner dies (asleep immediately)
      advance(10)
      const res = await hub.wait('token-a').promise // user re-runs /forge-watch in session A
      expect(res).toEqual({ stop: false, items: [] })
      expect(hub.state()).toBe('live')
    })

    it("re-arming after a takeover does not deny the winner's OWN later cycles (denial is cleared)", async () => {
      const { hub } = makeHub({ holdMs: 5, freshMs: 0 }) // freshMs 0: state decays instantly between cycles
      const a = hub.wait('token-a')
      const b = hub.wait('token-b')
      await a.promise // a replaced
      await b.promise // b's hold expires; freshMs 0 → hub no longer live
      const aAgain = await hub.wait('token-a').promise // legitimate re-arm — denial lifted
      expect(aAgain).toEqual({ stop: false, items: [] })
      // a's own NEXT cycle must not be absorbed by its stale denylist entry
      const aNext = await hub.wait('token-a').promise
      expect(aNext).toEqual({ stop: false, items: [] })
    })

    it('same-token preemption (abort + retry from one session) does not deny that session its own slot', async () => {
      const { hub } = makeHub({ holdMs: 5, freshMs: 60_000 })
      const first = hub.wait('token-a')
      const second = hub.wait('token-a') // same bin re-arming while its old request lingers
      await expect(first.promise).resolves.toEqual({ stop: true, reason: 'replaced' })
      await expect(second.promise).resolves.toEqual({ stop: false, items: [] }) // parked normally, hold expires
      const third = await hub.wait('token-a').promise // and its loop keeps working
      expect(third).toEqual({ stop: false, items: [] })
    })
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

describe('unlink (browser ✕ — 2026-07-05 watcher-unlink spec)', () => {
  it('settles a parked waiter with {stop, unlinked} and resets state to none', async () => {
    const { hub } = makeHub()
    const { promise } = hub.wait('tok-a')
    hub.unlink()
    await expect(promise).resolves.toEqual({ stop: true, reason: 'unlinked' })
    expect(hub.state()).toBe('none')
  })

  it('a parked-unlinked token re-arms cleanly on its next wait (trusted like the idle stop)', async () => {
    const { hub } = makeHub()
    const first = hub.wait('tok-a')
    hub.unlink()
    await first.promise
    const second = hub.wait('tok-a') // deliberate /forge-watch re-run
    expect(hub.state()).toBe('live')
    second.cancel()
  })

  it('denies the NEXT wait of a live-but-not-parked watcher once, then re-arms (mid-apply / between cycles)', async () => {
    const { hub, setApplying } = makeHub()
    const first = hub.wait('tok-a')
    await first.promise // hold expires (holdMs 30) — between cycles now
    setApplying(true)
    expect(hub.state()).toBe('live') // mid-apply liveness
    hub.unlink()
    expect(hub.state()).toBe('none')
    await expect(hub.wait('tok-a').promise).resolves.toEqual({ stop: true, reason: 'unlinked' }) // one-shot denial
    const rearm = hub.wait('tok-a') // wait after the denial is a deliberate re-run
    expect(hub.state()).toBe('live')
    rearm.cancel()
  })

  it('dismisses an asleep watcher back to none without denying its next wait', async () => {
    const { hub, advance } = makeHub()
    const first = hub.wait('tok-a')
    first.cancel() // bin vanished — watching flips off
    advance(6_000) // past freshMs (5s)
    expect(hub.state()).toBe('asleep')
    hub.unlink()
    expect(hub.state()).toBe('none')
    const rearm = hub.wait('tok-a')
    expect(hub.state()).toBe('live') // no one-shot stop for a dismissed-asleep token
    rearm.cancel()
  })

  it('is a no-op when nothing ever watched', () => {
    const { hub } = makeHub()
    hub.unlink()
    expect(hub.state()).toBe('none')
  })
})

// Type-level guard: WaitResponse's discriminant is `stop`, and the client/bin both rely on it.
const _stopShape: WaitResponse = { stop: true, reason: 'idle' }
const _itemsShape: WaitResponse = { stop: false, items: [] }
void _stopShape
void _itemsShape

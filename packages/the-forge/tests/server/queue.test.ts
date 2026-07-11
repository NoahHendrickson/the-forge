import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Queue, CLAIM_TIMEOUT_MS, PRUNE_AFTER_MS } from '../../src/server/queue'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-queue-'))
})

describe('Queue', () => {
  it('adds items with id/createdAt/pending and persists them', () => {
    const q = new Queue(dir)
    const item = q.add({ elements: [] }, '# md')
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(item.status).toBe('pending')
    expect(new Date(item.createdAt).getTime()).toBeGreaterThan(0)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'))
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].id).toBe(item.id)
  })

  // queue.json holds change-request markdown (project source excerpts) and .the-forge/ sits
  // next to the secret-bearing endpoint file — both stay owner-only (2026-07-10 security review).
  it('persists queue.json owner-only (0600) in an owner-only dir (0700)', () => {
    const fresh = path.join(dir, 'nested', '.the-forge')
    const q = new Queue(fresh)
    q.add({}, '# md')
    expect(fs.statSync(path.join(fresh, 'queue.json')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700)
  })

  it('pull claims all pending items', () => {
    const q = new Queue(dir)
    const a = q.add({}, 'a')
    const b = q.add({}, 'b')
    const pulled = q.pull()
    expect(pulled.map((i) => i.id)).toEqual([a.id, b.id])
    expect(q.get(a.id)!.status).toBe('claimed')
    expect(q.pull()).toEqual([]) // nothing pending anymore
  })

  it('mark finalizes items with status and note', () => {
    const q = new Queue(dir)
    const a = q.add({}, 'a')
    q.pull()
    const marked = q.mark([a.id], 'applied', 'done')
    expect(marked[0].status).toBe('applied')
    expect(marked[0].note).toBe('done')
    expect(q.mark(['nope'], 'applied')).toEqual([]) // unknown ids ignored
  })

  // Agent-facing text renders ids as 8-char prefixes (mcp/protocol.ts renderItems — full
  // UUIDs cost ~15-22 tokens each and appeared 3x per item), so mark() must resolve a
  // unique prefix back to the full id. Full ids keep working; an ambiguous prefix marks
  // nothing rather than guessing.
  it('mark resolves a unique 8-char id prefix', () => {
    const q = new Queue(dir)
    const a = q.add({}, 'a')
    q.pull()
    const marked = q.mark([a.id.slice(0, 8)], 'applied')
    expect(marked).toHaveLength(1)
    expect(q.get(a.id)!.status).toBe('applied')
  })

  it('mark ignores an ambiguous prefix instead of guessing', () => {
    const q = new Queue(dir)
    const a = q.add({}, 'a')
    const b = q.add({}, 'b')
    // Force two items onto the same 8-char prefix.
    ;(q as unknown as { items: Array<{ id: string }> }).items[0].id = 'aaaaaaaa-1111-4111-8111-111111111111'
    ;(q as unknown as { items: Array<{ id: string }> }).items[1].id = 'aaaaaaaa-2222-4222-8222-222222222222'
    q.pull()
    expect(q.mark(['aaaaaaaa'], 'applied')).toEqual([])
    expect(q.get('aaaaaaaa-1111-4111-8111-111111111111')!.status).toBe('claimed')
    void a
    void b
  })

  it('does not let a stale mark() clobber an item already in a terminal state (double-claim)', () => {
    const q = new Queue(dir)
    const a = q.add({}, 'a')
    q.pull()
    const firstMark = q.mark([a.id], 'applied', 'first-claimer-succeeded')
    expect(firstMark.map((i) => i.id)).toEqual([a.id])

    // a second (stale) claimer tries to mark the same item failed after the fact
    const secondMark = q.mark([a.id], 'failed', 'second-claimer-thinks-it-failed')
    expect(secondMark).toEqual([]) // not actually marked — already terminal

    expect(q.get(a.id)!.status).toBe('applied')
    expect(q.get(a.id)!.note).toBe('first-claimer-succeeded')
  })

  it('reloads persisted state across instances', () => {
    const q1 = new Queue(dir)
    const a = q1.add({}, 'a')
    const q2 = new Queue(dir)
    expect(q2.get(a.id)!.markdown).toBe('a')
    expect(q2.pull().map((i) => i.id)).toEqual([a.id])
  })

  it('survives a corrupt queue file by starting empty', () => {
    fs.writeFileSync(path.join(dir, 'queue.json'), 'not json')
    const q = new Queue(dir)
    expect(q.list()).toEqual([])
  })

  it('persists atomically: no queue.json.tmp left behind after a write', () => {
    const q = new Queue(dir)
    q.add({}, 'a')
    expect(fs.existsSync(path.join(dir, 'queue.json.tmp'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'queue.json'))).toBe(true)
  })

  describe('claim timeout', () => {
    it('re-treats a claimed item as pending after CLAIM_TIMEOUT_MS and restamps claimedAt', () => {
      let now = 1_000_000
      const q = new Queue(dir, () => now)
      const a = q.add({}, 'a')
      const firstPull = q.pull()
      expect(firstPull.map((i) => i.id)).toEqual([a.id])
      expect(q.get(a.id)!.claimedAt).toBeDefined()
      const firstClaimedAt = q.get(a.id)!.claimedAt

      // still within timeout: not re-claimable
      now += CLAIM_TIMEOUT_MS - 1
      expect(q.pull()).toEqual([])

      // past timeout: re-claimed, with a restamped claimedAt
      now += 2
      const secondPull = q.pull()
      expect(secondPull.map((i) => i.id)).toEqual([a.id])
      expect(q.get(a.id)!.claimedAt).not.toBe(firstClaimedAt)
    })

    it('does not re-claim items already finalized', () => {
      let now = 0
      const q = new Queue(dir, () => now)
      const a = q.add({}, 'a')
      q.pull()
      q.mark([a.id], 'applied')
      now += CLAIM_TIMEOUT_MS + 1
      expect(q.pull()).toEqual([])
    })

    describe('hasFreshClaims (the watcher-liveness apply signal)', () => {
      it('false for empty/pending, true right after a pull, false again after mark', () => {
        let now = 1_000_000
        const q = new Queue(dir, () => now)
        expect(q.hasFreshClaims()).toBe(false)
        const a = q.add({}, 'a')
        expect(q.hasFreshClaims()).toBe(false) // pending is queued, not mid-apply
        q.pull()
        expect(q.hasFreshClaims()).toBe(true)
        q.mark([a.id], 'applied')
        expect(q.hasFreshClaims()).toBe(false)
      })

      it('goes false once the claim exceeds CLAIM_TIMEOUT_MS WITHOUT anyone calling pull() — a dead watcher never pulls, so the age bound must be intrinsic', () => {
        let now = 1_000_000
        const q = new Queue(dir, () => now)
        q.add({}, 'a')
        q.pull() // watcher claims, then dies mid-apply
        expect(q.hasFreshClaims()).toBe(true)
        now += CLAIM_TIMEOUT_MS + 1
        expect(q.hasFreshClaims()).toBe(false) // no pull() happened — still must decay
      })

      it('treats a claimed item with missing or unparseable claimedAt as stale, same as pull()', () => {
        const legacy = [
          { id: 'l1', createdAt: new Date(0).toISOString(), status: 'claimed', markdown: 'x', request: null },
          { id: 'l2', createdAt: new Date(0).toISOString(), status: 'claimed', claimedAt: 'not-a-date', markdown: 'y', request: null },
        ]
        fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(legacy))
        const q = new Queue(dir, () => 1_000_000)
        expect(q.hasFreshClaims()).toBe(false)
      })
    })

    it('re-claims a legacy `claimed` item with a MISSING claimedAt immediately (stale — no way to know its age)', () => {
      // Legacy M4 queue.json shape: a claimed item persisted before claimedAt existed at all.
      const legacyItem = {
        id: 'legacy-1',
        createdAt: new Date(0).toISOString(),
        status: 'claimed',
        markdown: 'legacy',
        request: null,
        // claimedAt intentionally absent
      }
      fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([legacyItem]))
      const q = new Queue(dir)
      const pulled = q.pull()
      expect(pulled.map((i) => i.id)).toEqual(['legacy-1'])
      expect(q.get('legacy-1')!.claimedAt).toBeDefined() // restamped on re-claim
    })

    it('re-claims a `claimed` item with an UNPARSEABLE (NaN) claimedAt immediately', () => {
      const badItem = {
        id: 'legacy-2',
        createdAt: new Date(0).toISOString(),
        status: 'claimed',
        markdown: 'legacy',
        request: null,
        claimedAt: 'not-a-date',
      }
      fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([badItem]))
      const q = new Queue(dir)
      const pulled = q.pull()
      expect(pulled.map((i) => i.id)).toEqual(['legacy-2'])
      expect(q.get('legacy-2')!.claimedAt).toBeDefined()
      expect(Number.isNaN(new Date(q.get('legacy-2')!.claimedAt!).getTime())).toBe(false)
    })
  })

  describe('concurrent instances', () => {
    it('scopes the tmp file by pid so two instances never collide on the same tmp path', () => {
      const q = new Queue(dir)
      q.add({}, 'a')
      expect(fs.existsSync(path.join(dir, `queue.json.tmp.${process.pid}`))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'queue.json'))).toBe(true)
    })

    it('a persist by instance B does not drop items added by instance A (merge-on-persist)', () => {
      const a = new Queue(dir)
      const itemA = a.add({}, 'from-a')

      const b = new Queue(dir) // loads state at this point, includes itemA
      const itemB = b.add({}, 'from-b') // b persists here — must merge, not overwrite

      // a persists again (e.g. via pull/mark) without having seen itemB
      a.pull()

      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'))
      const ids = onDisk.map((i: { id: string }) => i.id)
      expect(ids).toContain(itemA.id)
      expect(ids).toContain(itemB.id)
    })

    it('in-memory items win over disk for ids known to this instance', () => {
      const a = new Queue(dir)
      const itemA = a.add({}, 'from-a')

      const b = new Queue(dir)
      b.mark([itemA.id], 'applied', 'b-was-here') // b knows itemA too; persists its view

      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'))
      const found = onDisk.find((i: { id: string }) => i.id === itemA.id)
      expect(found.status).toBe('applied')
      expect(found.note).toBe('b-was-here')
    })
  })

  describe('pruning basis (finishedAt)', () => {
    it('does not prune an item created 25h ago but marked terminal just now', () => {
      let now = 0
      const q = new Queue(dir, () => now)
      const a = q.add({}, 'old-but-just-finished')
      q.pull()
      now = 25 * 60 * 60 * 1000 // 25h later
      q.mark([a.id], 'applied') // finishedAt stamped "now" (25h), not createdAt (0h)
      const b = q.add({}, 'trigger-persist') // triggers another persist/prune pass
      const ids = q.list().map((i) => i.id)
      expect(ids).toContain(a.id)
      expect(ids).toContain(b.id)
    })

    it('prunes an item that was marked terminal 25h ago, even if created even earlier', () => {
      let now = 0
      const q = new Queue(dir, () => now)
      const a = q.add({}, 'created-early')
      q.pull()
      q.mark([a.id], 'applied') // finishedAt stamped at now=0
      now = PRUNE_AFTER_MS + 1
      q.add({}, 'trigger-persist') // triggers persist/prune — finishedAt is now stale
      expect(q.list().map((i) => i.id)).not.toContain(a.id)
    })
  })

  describe('pruning', () => {
    it('drops applied/failed items older than PRUNE_AFTER_MS on persist', () => {
      let now = 0
      const q = new Queue(dir, () => now)
      const a = q.add({}, 'old')
      q.pull()
      q.mark([a.id], 'applied')
      now += PRUNE_AFTER_MS + 1
      const b = q.add({}, 'new') // triggers a persist/prune pass
      expect(q.list().map((i) => i.id)).toEqual([b.id])
    })

    it('never prunes pending or claimed items regardless of age', () => {
      let now = 0
      const q = new Queue(dir, () => now)
      const pending = q.add({}, 'still-pending')
      const q2 = new Queue(dir, () => now)
      const toClaim = q2.add({}, 'to-claim')
      q2.pull()
      now += PRUNE_AFTER_MS + 1
      q2.add({}, 'trigger-persist')
      const ids = q2.list().map((i) => i.id)
      expect(ids).toContain(pending.id)
      expect(ids).toContain(toClaim.id)
    })

    it('caps total stored items at 200, dropping oldest terminal-status items first', () => {
      let now = 0
      const q = new Queue(dir, () => now)
      // 210 applied items, each older than the last (ascending createdAt/finalized order)
      const ids: string[] = []
      for (let i = 0; i < 210; i++) {
        const item = q.add({}, `item-${i}`)
        q.pull()
        q.mark([item.id], 'applied')
        ids.push(item.id)
        now += 1
      }
      expect(q.list().length).toBeLessThanOrEqual(200)
      // the earliest-created items should be the ones pruned
      const remaining = new Set(q.list().map((i) => i.id))
      expect(remaining.has(ids[0])).toBe(false)
      expect(remaining.has(ids[ids.length - 1])).toBe(true)
    })

    it('prunes a stale terminal item known only via disk-merge from another instance', () => {
      let now = 0
      const a = new Queue(dir, () => now)
      const oldItem = a.add({}, 'old-terminal-from-a')
      a.pull()
      a.mark([oldItem.id], 'applied')
      // a's persist wrote oldItem to disk; now advance time past PRUNE_AFTER_MS

      now += PRUNE_AFTER_MS + 1
      const b = new Queue(dir, () => now) // b loads disk state including stale oldItem
      const newItem = b.add({}, 'new-from-b') // b's persist must prune the stale disk item

      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'))
      const ids = onDisk.map((i: { id: string }) => i.id)
      expect(ids).not.toContain(oldItem.id) // should be pruned despite coming from disk-merge
      expect(ids).toContain(newItem.id)
    })

    it('mergeItems adds items with ids this instance does not know, then persists', () => {
      const q = new Queue(dir)
      const existing = q.add({}, 'existing')
      const legacyItem = {
        id: 'legacy-item-1',
        createdAt: new Date(0).toISOString(),
        status: 'pending' as const,
        markdown: 'legacy-md',
        request: null,
      }
      q.mergeItems([legacyItem])

      const ids = q.list().map((i) => i.id)
      expect(ids).toContain(existing.id)
      expect(ids).toContain('legacy-item-1')
      expect(q.get('legacy-item-1')!.markdown).toBe('legacy-md')

      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'))
      expect(onDisk.map((i: { id: string }) => i.id)).toContain('legacy-item-1')
    })

    it('mergeItems: in-memory item wins over a merged item with the same id', () => {
      const q = new Queue(dir)
      const existing = q.add({}, 'from-memory')
      q.mark([existing.id], 'applied', 'memory-wins')

      q.mergeItems([{ ...q.get(existing.id)!, markdown: 'stale-disk-version', status: 'pending', note: undefined }])

      expect(q.get(existing.id)!.markdown).toBe('from-memory')
      expect(q.get(existing.id)!.status).toBe('applied')
      expect(q.get(existing.id)!.note).toBe('memory-wins')
    })

    it('sorts merged queue by createdAt ascending so queue.json preserves creation order', () => {
      let now = 0
      const a = new Queue(dir, () => now)
      const aItem1 = a.add({}, 'a-first')
      now += 100

      const b = new Queue(dir, () => now)
      const bItem1 = b.add({}, 'b-first')
      now += 100

      const aItem2 = a.add({}, 'a-second')
      // now a's next persist sees bItem1 on disk (unknown to a yet)

      a.pull() // triggers persist with merge
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'))
      const createdAtOrder = onDisk.map((i: { createdAt: string }) => new Date(i.createdAt).getTime())

      // verify chronological order: aItem1 < bItem1 < aItem2
      expect(createdAtOrder[0]).toBeLessThan(createdAtOrder[1])
      expect(createdAtOrder[1]).toBeLessThan(createdAtOrder[2])
    })

    it('quarantines a corrupt queue.json (renamed with timestamp) instead of silently discarding it', () => {
      fs.writeFileSync(path.join(dir, 'queue.json'), '{definitely not json')
      const q = new Queue(dir, () => 1751600000000)
      expect(q.list()).toEqual([])
      const corrupt = path.join(dir, 'queue.json.corrupt-1751600000000')
      expect(fs.existsSync(corrupt)).toBe(true)
      expect(fs.readFileSync(corrupt, 'utf8')).toBe('{definitely not json')
      expect(fs.existsSync(path.join(dir, 'queue.json'))).toBe(false)
    })

    it('treats parseable-but-non-array queue.json as corrupt (quarantined, not silently ignored)', () => {
      fs.writeFileSync(path.join(dir, 'queue.json'), '{"items": []}')
      const q = new Queue(dir, () => 1751600000000)
      expect(q.list()).toEqual([])
      expect(fs.existsSync(path.join(dir, 'queue.json.corrupt-1751600000000'))).toBe(true)
    })

    it('quarantines a file that becomes corrupt mid-session on the next persist (mergeWithDisk path)', () => {
      const q = new Queue(dir)
      q.add({}, 'a')
      fs.writeFileSync(path.join(dir, 'queue.json'), 'garbage-written-by-something-else')
      q.add({}, 'b')
      const names = fs.readdirSync(dir)
      expect(names.some((n) => /^queue\.json\.corrupt-\d+$/.test(n))).toBe(true)
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'))
      expect(onDisk).toHaveLength(2)
    })

    it('a missing queue.json is NOT corruption — no quarantine file appears', () => {
      const q = new Queue(dir)
      expect(q.list()).toEqual([])
      expect(fs.readdirSync(dir).filter((n) => n.includes('corrupt'))).toEqual([])
    })
  })
})

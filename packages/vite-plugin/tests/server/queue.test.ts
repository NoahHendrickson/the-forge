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
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Queue } from '../../src/server/queue'

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
})

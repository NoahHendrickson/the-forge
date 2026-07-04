import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface QueueItem {
  id: string
  createdAt: string
  status: 'pending' | 'claimed' | 'applied' | 'failed'
  markdown: string
  request: unknown
  note?: string
}

export class Queue {
  private items: QueueItem[] = []
  private file: string

  constructor(private dir: string) {
    this.file = path.join(dir, 'queue.json')
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(raw)) this.items = raw as QueueItem[]
    } catch {
      this.items = []
    }
  }

  add(request: unknown, markdown: string): QueueItem {
    const item: QueueItem = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      markdown,
      request,
    }
    this.items.push(item)
    this.persist()
    return item
  }

  pull(): QueueItem[] {
    const pending = this.items.filter((i) => i.status === 'pending')
    for (const item of pending) item.status = 'claimed'
    if (pending.length > 0) this.persist()
    return pending
  }

  mark(ids: string[], status: 'applied' | 'failed', note?: string): QueueItem[] {
    const marked: QueueItem[] = []
    for (const id of ids) {
      const item = this.items.find((i) => i.id === id)
      if (!item) continue
      item.status = status
      if (note !== undefined) item.note = note
      marked.push(item)
    }
    if (marked.length > 0) this.persist()
    return marked
  }

  list(): QueueItem[] {
    return [...this.items]
  }

  get(id: string): QueueItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2))
  }
}

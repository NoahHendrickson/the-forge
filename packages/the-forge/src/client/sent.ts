import type { TaggedElement } from './source'

export interface SentEntry {
  id: string
  elements: Array<{
    el: TaggedElement
    dcSource: string | null
    /** the DraftStore's actual keys for this element at send time — used for targeted commit,
     * since `changes` may use collapsed shorthand property names (see COLLAPSE in request.ts)
     * that don't match any DraftStore key. */
    draftProps: string[]
    changes: Array<{ property: string; afterCss: string }>
  }>
}

export class SentRegistry {
  private entries = new Map<string, SentEntry>()

  add(id: string, elements: SentEntry['elements']): void {
    this.entries.set(id, { id, elements })
  }

  pendingIds(): string[] {
    return [...this.entries.keys()]
  }

  take(id: string): SentEntry | undefined {
    const entry = this.entries.get(id)
    if (entry) this.entries.delete(id)
    return entry
  }

  size(): number {
    return this.entries.size
  }
}

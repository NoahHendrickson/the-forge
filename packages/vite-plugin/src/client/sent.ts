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

  /** True when an in-flight entry already carries this element with an IDENTICAL change set
   * (same properties → same after values). Guards the double-Send case: re-queueing an
   * identical request tells the agent to redo utility renames whose "before" class the first
   * apply already removed. Identical-only on purpose — an element re-edited to DIFFERENT
   * values is a genuinely new request and must go through. */
  isDuplicate(el: TaggedElement, changes: Array<{ property: string; afterCss: string }>): boolean {
    for (const entry of this.entries.values()) {
      for (const sent of entry.elements) {
        if (sent.el !== el || sent.changes.length !== changes.length) continue
        const sentAfter = new Map(sent.changes.map((c) => [c.property, c.afterCss]))
        if (changes.every((c) => sentAfter.get(c.property) === c.afterCss)) return true
      }
    }
    return false
  }

  size(): number {
    return this.entries.size
  }
}

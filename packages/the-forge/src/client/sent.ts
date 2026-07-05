import type { TaggedElement } from './source'

/** One sent property delta — named once so SentEntry and isDuplicate can't drift apart. */
export interface SentChange {
  property: string
  afterCss: string
}

export interface SentEntry {
  id: string
  elements: Array<{
    el: TaggedElement
    dcSource: string | null
    /** Position among querySelectorAll('[data-dc-source="..."]') matches at send time — passed
     * through to lifecycle-store's resolveElement() so re-locating a disconnected element picks
     * the SAME list instance, not always the first match. Optional and defaults to 0 so existing
     * construction sites (and tests) that never set it keep compiling and behaving exactly as
     * before — first-match was already the historical fallback. */
    index?: number
    /** the DraftStore's actual keys for this element at send time — used for targeted commit,
     * since `changes` may use collapsed shorthand property names (see COLLAPSE in request.ts)
     * that don't match any DraftStore key. */
    draftProps: string[]
    changes: SentChange[]
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

  /** Read-only lookup — unlike take(), the entry stays registered. Used by the verifier's
   * poll loop to emit per-element stage events for entries that are still in flight. */
  get(id: string): SentEntry | undefined {
    return this.entries.get(id)
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
  isDuplicate(el: TaggedElement, changes: SentChange[]): boolean {
    for (const entry of this.entries.values()) {
      for (const sent of entry.elements) {
        // Strict reference match first; then the same dcSource fallback the verifier's
        // locate() uses — a reload restores in-flight entries with detached placeholder
        // elements (see restoreLifecycle), and a placeholder must still shield its real,
        // re-mounted element from an identical re-queue.
        const sameEl =
          sent.el === el ||
          (!sent.el.isConnected && sent.dcSource !== null && el.dataset.dcSource === sent.dcSource)
        if (!sameEl || sent.changes.length !== changes.length) continue
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

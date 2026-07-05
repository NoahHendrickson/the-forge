import type { SentChange, SentEntry } from './sent'
import type { ElementChange } from './request'
import type { TaggedElement } from './source'
import type { StageEvent, LifecycleStage } from './verifier'
import { resolveElement } from './lifecycle-store'
import type { PersistedLifecycle, PersistedSentElement } from './lifecycle-store'

/** One sent element's payload — unchanged shape from pre-refactor changelist.ts. */
export interface SentSeed {
  el: TaggedElement
  dcSource: string | null
  /** Position among matches for `dcSource` at send time — carried through to healPlaceholders()
   * (via resolveElement) so a restored/detached seed heals to the SAME list instance it was
   * originally sent for, not just whichever instance happens to match first. */
  index: number
  draftProps: string[]
  change: ElementChange
}

/** Stages a row can no longer leave via poll events — a late 'sent'/'applying' tick for an
 * already-resolved id (races between take() and the next poll) must not resurrect a receipt. */
const TERMINAL: ReadonlySet<LifecycleStage> = new Set(['done', 'mismatch', 'unverified', 'failed'])

/** One seed's live lifecycle state — was ChangeList's SentRow, now living here so
 * verifier/UI/persistence read the SAME record. */
export interface SeedRecord {
  seed: SentSeed
  stage: LifecycleStage
  note?: string
  mismatches?: StageEvent['mismatches']
}

/** Structural dependency the Verifier consumes — five methods, unchanged from the old
 * SentRegistry's public surface, so the verifier needed no behavioral changes, only this
 * shape swap. */
export interface SentStore {
  pendingIds(): string[]
  get(id: string): SentEntry | undefined
  take(id: string): SentEntry | undefined
  size(): number
  isDuplicate(el: TaggedElement, changes: SentChange[]): boolean
}

export type SessionChangeListener = () => void

/** Single owner of sent-state, replacing three previously hand-synced stores (SentRegistry +
 * DesignMode.sentSeeds + ChangeList.sentRows). One Map<requestId, seeds[]> backs verifier
 * consumption (SentStore), UI rows (records()), and persistence (toPersistedSent/restoreSent). */
export class LifecycleSession implements SentStore {
  private entries = new Map<string, SeedRecord[]>()
  private listeners: SessionChangeListener[] = []

  onChange(fn: SessionChangeListener): void {
    this.listeners.push(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  /** Registers a freshly-sent (or restored) batch of seeds under `id`, each starting at stage
   * 'sent'. Single construction point for what used to be SentRegistry.add + sentSeeds.set +
   * ChangeList.addSent, called together everywhere. */
  register(id: string, seeds: SentSeed[]): void {
    this.entries.set(id, seeds.map((seed) => ({ seed, stage: 'sent' as LifecycleStage })))
    this.notify()
  }

  // ---- SentStore (verifier dependency) ----

  pendingIds(): string[] {
    return [...this.entries.keys()]
  }

  /** Read-only lookup — unlike take(), the entry stays registered. Used by the verifier's
   * poll loop to emit per-element stage events for entries that are still in flight. */
  get(id: string): SentEntry | undefined {
    const seeds = this.entries.get(id)
    return seeds ? this.toSentEntry(id, seeds) : undefined
  }

  take(id: string): SentEntry | undefined {
    const seeds = this.entries.get(id)
    if (!seeds) return undefined
    this.entries.delete(id)
    this.notify()
    return this.toSentEntry(id, seeds)
  }

  size(): number {
    return this.entries.size
  }

  /** True when an in-flight entry already carries this element with an IDENTICAL change set
   * (same properties → same after values). Guards the double-Send case: re-queueing an
   * identical request tells the agent to redo utility renames whose "before" class the first
   * apply already removed. Identical-only on purpose — an element re-edited to DIFFERENT
   * values is a genuinely new request and must go through. Ported verbatim from
   * SentRegistry.isDuplicate, including the dcSource-fallback-for-disconnected-entries. */
  isDuplicate(el: TaggedElement, changes: SentChange[]): boolean {
    for (const seeds of this.entries.values()) {
      for (const rec of seeds) {
        const sentEl = rec.seed.el
        const sentDcSource = rec.seed.dcSource
        const sentChanges = rec.seed.change.changes.map((c) => ({ property: c.property, afterCss: c.afterCss }))
        // Strict reference match first; then the same dcSource fallback the verifier's
        // locate() uses — a reload restores in-flight entries with detached placeholder
        // elements (see restoreLifecycle), and a placeholder must still shield its real,
        // re-mounted element from an identical re-queue.
        const sameEl =
          sentEl === el || (!sentEl.isConnected && sentDcSource !== null && el.dataset.dcSource === sentDcSource)
        if (!sameEl || sentChanges.length !== changes.length) continue
        const sentAfter = new Map(sentChanges.map((c) => [c.property, c.afterCss]))
        if (changes.every((c) => sentAfter.get(c.property) === c.afterCss)) return true
      }
    }
    return false
  }

  private toSentEntry(id: string, seeds: SeedRecord[]): SentEntry {
    return {
      id,
      elements: seeds.map((rec) => ({
        el: rec.seed.el,
        dcSource: rec.seed.dcSource,
        index: rec.seed.index,
        draftProps: rec.seed.draftProps,
        changes: rec.seed.change.changes.map((c) => ({ property: c.property, afterCss: c.afterCss })),
      })),
    }
  }

  // ---- UI (ChangeList view) ----

  /** All seed records in insertion order — ChangeList reverses this itself for newest-first
   * display. */
  records(): SeedRecord[] {
    return [...this.entries.values()].flat()
  }

  /** Returns true only when this event actually changed a row's stage — poll re-emissions of
   * an unchanged stage (verifier ticks every ~2s while a request is pending) are expected and
   * must be a no-op, not just for rendering but for the caller's own state-change bookkeeping
   * (index.ts persists to sessionStorage only when this returns true — see final-review F4). */
  applyStage(e: StageEvent): boolean {
    const rec = this.entries.get(e.requestId)?.[e.elIndex]
    if (!rec) return false
    if (rec.stage === e.stage) return false // poll re-emissions are expected — no re-render churn
    if (TERMINAL.has(rec.stage)) return false
    rec.stage = e.stage
    rec.note = e.note
    rec.mismatches = e.mismatches
    this.notify()
    return true
  }

  /** Removes every seed whose stage is 'done' or 'unverified' ("Clear done"). */
  clearResolved(): void {
    for (const [id, seeds] of this.entries) {
      const kept = seeds.filter((rec) => rec.stage !== 'done' && rec.stage !== 'unverified')
      if (kept.length === 0) this.entries.delete(id)
      else this.entries.set(id, kept)
    }
    this.notify()
  }

  /** Removes one specific seed (by identity) wherever it lives — used by row dismiss/resend
   * removal, keyed by seed rather than the internal record since callers only hold the seed. */
  removeSeed(seed: SentSeed): void {
    for (const [id, seeds] of this.entries) {
      const kept = seeds.filter((rec) => rec.seed !== seed)
      if (kept.length !== seeds.length) {
        if (kept.length === 0) this.entries.delete(id)
        else this.entries.set(id, kept)
      }
    }
    this.notify()
  }

  /** Restored placeholder seeds (from restoreSent, a locate() miss on boot) carry a detached
   * `document.createElement(tag)` element forever — nothing ever re-locates them, so a row
   * stays greyed even after the framework mounts the real element, AND inFlightProps (which
   * dedupes by `seed.el` identity) misses because the draft's `el` and the placeholder are
   * different objects. Heal at render time — every render is a natural re-check point —
   * mirroring the verifier's own locate() fallback: a disconnected element with a dcSource
   * always gets one more chance to resolve to its live DOM counterpart. MUTATING `seed.el` in
   * place (not replacing the record) is what makes the fix reach every consumer that shares the
   * seed object: inFlightProps, persist(), and row click/hover handlers. */
  healPlaceholders(): void {
    for (const rec of this.records()) {
      if (rec.seed.el.isConnected) continue
      if (!rec.seed.dcSource) continue
      const located = resolveElement(rec.seed.el, rec.seed.dcSource, rec.seed.index)
      if (located) rec.seed.el = located
    }
  }

  clear(): void {
    this.entries.clear()
    this.notify()
  }

  // ---- persistence projection ----

  /** Projects live sent state into the shape lifecycle-store persists. */
  toPersistedSent(): PersistedLifecycle['sent'] {
    const sent: PersistedLifecycle['sent'] = []
    for (const [id, seeds] of this.entries) {
      sent.push({
        id,
        elements: seeds.map(({ seed }) => ({
          dcSource: seed.dcSource,
          // Read the seed's OWN index rather than recomputing via sourceIndex(seed.el, ...): for
          // a still-detached placeholder seed, sourceIndex(el, dcSource) can never find `el`
          // among the live DOM matches (it's not there) and always degrades to 0, silently
          // losing which list instance this entry actually refers to on every persist() while
          // detached. Seeds carry their index from send/restore time — trust it instead.
          index: seed.index,
          tag: seed.change.tag,
          draftProps: seed.draftProps,
          changes: seed.change.changes.map((c) => ({ property: c.property, afterCss: c.afterCss })),
          change: seed.change,
        })),
      })
    }
    return sent
  }

  /** Rebuilds session entries from a persisted lifecycle snapshot (full page reload). Elements
   * whose dcSource can't be located yet get a detached placeholder; healPlaceholders() self-heals
   * them once the framework mounts the real node. */
  restoreSent(persistedSent: PersistedLifecycle['sent'], locate: (dcSource: string, index: number) => TaggedElement | null): void {
    for (const s of persistedSent) {
      const seeds: SentSeed[] = s.elements.map((pe: PersistedSentElement) => ({
        el: (pe.dcSource && locate(pe.dcSource, pe.index)) || (document.createElement(pe.tag) as TaggedElement),
        dcSource: pe.dcSource,
        index: pe.index,
        draftProps: pe.draftProps,
        change: pe.change,
      }))
      this.entries.set(s.id, seeds.map((seed) => ({ seed, stage: 'sent' as LifecycleStage })))
    }
    this.notify()
  }
}

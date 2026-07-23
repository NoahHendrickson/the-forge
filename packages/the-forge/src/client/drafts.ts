import type { TaggedElement } from './source'
import type { StructuralOp } from './request'
import { draftToOps, opsIdentical } from './ops'
import { locateBySource, sourceIndex } from './lifecycle-store'

interface DraftProp {
  original: string
  value: string
}

/** A Figma-pivot structural draft (spec 2026-07-22 §2) — lives BESIDE the css map, never
 * inside it: a delete previews as inline `display:none` but must never surface as a
 * `display` property delta in a change request, and text isn't a css property at all. */
export type StructuralDraft =
  | { kind: 'text'; original: string; value: string }
  | { kind: 'delete'; priorInlineDisplay: string }

function writeInline(el: TaggedElement, prop: string, css: string): void {
  if (css) el.style.setProperty(prop, css)
  else el.style.removeProperty(prop)
}

export class DraftStore {
  onChange: (() => void) | null = null

  private drafts = new Map<TaggedElement, Map<string, DraftProp>>()
  private structural = new Map<TaggedElement, StructuralDraft>()
  private showingOriginal = new Set<TaggedElement>()
  /** (dcSource, index) recorded when a structural draft is minted — structural drafts are
   * keyed by live node reference, and an unrelated HMR remount replaces that node, visibly
   * reverting the preview while the draft lingers as a phantom (counted by the pill, skipped
   * by the send builder's isConnected sweep — unsendable until discard-all). This address is
   * what healStructural() re-locates by, mirroring the sent entries' healPlaceholders()
   * (PR #44 review). null for untagged elements: preview-only, pruned if disconnected. */
  private structuralAddr = new Map<TaggedElement, { dcSource: string; index: number } | null>()

  apply(el: TaggedElement, prop: string, value: string): void {
    // Same tombstone guard as applyText: Compare un-hides a delete-drafted element
    // (writeAll 'original' restores its display), which makes it selectable and scrubbable
    // again — a css draft minted there would ride the same request as the delete, telling
    // the agent to both restyle and remove the element (PR #44 review).
    if (this.structural.get(el)?.kind === 'delete') return
    let props = this.drafts.get(el)
    if (!props) {
      props = new Map()
      this.drafts.set(el, props)
    }
    const existing = props.get(prop)
    if (existing) existing.value = value
    else props.set(prop, { original: el.style.getPropertyValue(prop), value })

    if (this.showingOriginal.has(el)) {
      // auto-exit compare so the user sees the edit they just made
      this.showingOriginal.delete(el)
      this.writeAll(el, 'value')
    }
    el.style.setProperty(prop, value)
    this.emit()
  }

  /** Text-content draft. Records `original` once (first call) — later calls only move
   * `value`, mirroring the css DraftProp capture rule — and writes the value to the DOM
   * (idempotent when a contenteditable session already typed it there). `originalHint` is
   * for callers whose DOM was already mutated before this call (the contenteditable path
   * commits AFTER typing): without it the "original" would be read from a DOM that already
   * shows the new text, collapsing every edit into a no-op. No-op on a delete-drafted
   * element: there is nothing meaningful to retype on a tombstone. */
  applyText(el: TaggedElement, value: string, originalHint?: string): void {
    const existing = this.structural.get(el)
    if (existing?.kind === 'delete') return
    if (existing?.kind === 'text') {
      if (existing.value === value) return
      if (existing.original === value) {
        // Edited back to the recorded original — the draft is a no-op now. Drop it entirely:
        // unlike css no-ops (dropped at send time via computed-style compare), text ops have
        // no send-time filter, so a surviving {X→X} draft would inflate the pill and ship a
        // nonsense 'Text: "X" → "X"' ask that terminally lands 'unverified' (PR #44 review).
        this.structural.delete(el)
        this.structuralAddr.delete(el)
        if (!this.drafts.has(el)) this.showingOriginal.delete(el)
        el.textContent = value
        this.emit()
        return
      }
      existing.value = value
    } else {
      const original = originalHint ?? el.textContent ?? ''
      if (original === value) return // nothing changed — don't mint a no-op draft
      this.structural.set(el, { kind: 'text', original, value })
      this.recordAddr(el)
    }
    if (this.showingOriginal.has(el)) {
      // auto-exit compare so the user sees the edit they just made (same rule as apply())
      this.showingOriginal.delete(el)
      this.writeAll(el, 'value')
    }
    el.textContent = value
    this.emit()
  }

  /** Delete draft. Preview = inline `display:none`, held HERE (not as a css draft — it must
   * never render as a `display` property delta). Existing css drafts are discarded (the
   * user deleted the element; its style edits are moot) and a text draft is rolled back to
   * its original before being replaced, so a later discard resurrects the true element.
   * Deleting moots every draft in the SUBTREE too: without the descendant sweep, one request
   * would carry "Delete this element (and children)" alongside style/text ops for elements
   * inside it — contradictory asks whose deltas get measured through the ancestor's
   * display:none into non-laid-out garbage values (PR #44 review). One emit for the whole
   * operation (the old discard-then-re-emit fired two full onChange cascades per element). */
  applyDelete(el: TaggedElement): void {
    const existing = this.structural.get(el)
    if (existing?.kind === 'delete') return
    if (existing?.kind === 'text') el.textContent = existing.original
    for (const other of [...this.drafts.keys()]) {
      if (other !== el && el.contains(other)) this.discardInternal(other)
    }
    for (const other of [...this.structural.keys()]) {
      if (other !== el && el.contains(other)) this.discardInternal(other)
    }
    if (this.drafts.has(el)) this.discardInternal(el)
    this.structural.set(el, { kind: 'delete', priorInlineDisplay: el.style.getPropertyValue('display') })
    this.recordAddr(el)
    this.showingOriginal.delete(el)
    el.style.setProperty('display', 'none')
    this.emit()
  }

  /** Captures (dcSource, index) once per structural draft — see structuralAddr. */
  private recordAddr(el: TaggedElement): void {
    if (this.structuralAddr.has(el)) return
    const dcSource = el.dataset?.dcSource
    this.structuralAddr.set(el, dcSource ? { dcSource, index: sourceIndex(el, dcSource) } : null)
  }

  /** Re-binds structural drafts whose DOM node was replaced (an unrelated HMR remount) onto
   * the freshly-mounted node — re-applying the preview — and PRUNES drafts that can't be
   * re-located (or lost their address). The structural analog of the sent entries'
   * healPlaceholders(); without it a remount leaves a phantom draft the pill counts but the
   * send builder skips (PR #44 review). Called from the send path and the draft-sync flush —
   * cheap no-op while every drafted node is still connected. */
  healStructural(): boolean {
    let changed = false
    for (const [el, s] of [...this.structural]) {
      if (el.isConnected) continue
      const addr = this.structuralAddr.get(el) ?? null
      const next = addr ? locateBySource(addr.dcSource, addr.index) : null
      this.structural.delete(el)
      this.structuralAddr.delete(el)
      if (!this.drafts.has(el)) this.showingOriginal.delete(el)
      changed = true
      if (!next || this.structural.has(next)) continue
      if (s.kind === 'text') {
        // Re-capture original from the fresh node — it renders the source truth; the stale
        // original described a node that no longer exists. A fresh original equal to the
        // drafted value means the draft became a no-op — don't re-mint it.
        const original = next.textContent ?? ''
        if (original === s.value) continue
        this.structural.set(next, { kind: 'text', original, value: s.value })
        this.structuralAddr.set(next, addr)
        next.textContent = s.value
      } else {
        this.structural.set(next, { kind: 'delete', priorInlineDisplay: next.style.getPropertyValue('display') })
        this.structuralAddr.set(next, addr)
        next.style.setProperty('display', 'none')
      }
    }
    if (changed) this.emit()
    return changed
  }

  structuralOf(el: TaggedElement): StructuralDraft | null {
    return this.structural.get(el) ?? null
  }

  structuralEntries(): ReadonlyMap<TaggedElement, StructuralDraft> {
    return this.structural
  }

  current(el: TaggedElement, prop: string): string | null {
    return this.drafts.get(el)?.get(prop)?.value ?? null
  }

  hasDrafts(el: TaggedElement): boolean {
    return this.drafts.has(el) || this.structural.has(el)
  }

  elementCount(): number {
    let n = this.drafts.size
    for (const el of this.structural.keys()) if (!this.drafts.has(el)) n++
    return n
  }

  /** Total drafted properties across all elements — the composer pill's "N changes" count.
   * Same cheap Map-size read as elementCount(); a CSS draft scrubbed back to its exact
   * original still counts (css no-ops are only detectable at send time via computed styles —
   * see buildChangeRequestWithElements), matching elementCount()'s identical blind spot.
   * Text drafts have no such blind spot: applyText collapses an edit back to the original. */
  changeCount(): number {
    let n = this.structural.size // one change per structural draft (text or delete)
    for (const props of this.drafts.values()) n += props.size
    return n
  }

  compare(el: TaggedElement, on: boolean): void {
    if (!this.hasDrafts(el) || on === this.showingOriginal.has(el)) return
    if (on) this.showingOriginal.add(el)
    else this.showingOriginal.delete(el)
    this.writeAll(el, on ? 'original' : 'value')
    this.emit()
  }

  compareAll(on: boolean): void {
    for (const el of this.draftedElements()) {
      if (on) this.showingOriginal.add(el)
      else this.showingOriginal.delete(el)
      this.writeAll(el, on ? 'original' : 'value')
    }
    this.emit()
  }

  isComparing(el: TaggedElement): boolean {
    return this.showingOriginal.has(el)
  }

  isComparingAll(): boolean {
    // Runs on EVERY drafts.onChange (refreshStatus → overlay.updateStatus), i.e. per scrub
    // tick — count arithmetically via elementCount() (O(structural), typically 0-2 entries)
    // instead of iterating the whole drafted-element union per pointermove (PR #44 review).
    const total = this.elementCount()
    return total > 0 && this.showingOriginal.size === total
  }

  entries(): ReadonlyMap<TaggedElement, ReadonlyMap<string, { original: string; value: string }>> {
    return this.drafts
  }

  discard(el: TaggedElement, props?: string[]): void {
    const draftProps = this.drafts.get(el)
    if (props) {
      if (!draftProps) return
      // targeted discard: restore only the listed properties' recorded originals —
      // an un-targeted draft on the same element must survive untouched.
      // Targeted discards are css-only by contract: structural drafts have no property
      // names to target and must survive them.
      for (const prop of props) {
        const d = draftProps.get(prop)
        if (!d) continue
        writeInline(el, prop, d.original)
        draftProps.delete(prop)
      }
      if (draftProps.size === 0) {
        this.drafts.delete(el)
        if (!this.structural.has(el)) this.showingOriginal.delete(el)
      }
    } else {
      if (!draftProps && !this.structural.has(el)) return
      this.discardInternal(el)
    }
    this.emit()
  }

  /** Full-discard body without the emit — restores css originals + the structural original
   * side and forgets every record for `el`. Shared by discard() and applyDelete()'s subtree
   * sweep so a multi-element operation cascades onChange exactly once. */
  private discardInternal(el: TaggedElement): void {
    const draftProps = this.drafts.get(el)
    if (draftProps) for (const [prop, d] of draftProps) writeInline(el, prop, d.original)
    this.restoreStructural(el)
    this.drafts.delete(el)
    this.structural.delete(el)
    this.structuralAddr.delete(el)
    this.showingOriginal.delete(el)
  }

  /** Puts the DOM back to the structural draft's original side (used by full discard). */
  private restoreStructural(el: TaggedElement): void {
    const s = this.structural.get(el)
    if (!s) return
    if (s.kind === 'text') el.textContent = s.original
    else writeInline(el, 'display', s.priorInlineDisplay)
  }

  commit(el: TaggedElement, props?: string[]): void {
    const draftProps = this.drafts.get(el)
    if (props) {
      if (!draftProps) return
      // targeted commit: only forget the properties that were actually verified/sent —
      // an un-sent draft on the same element (e.g. a different property edited after
      // the request went out) must survive so it isn't silently lost.
      // Targeted commits are css-only by contract (see targeted discard above).
      for (const prop of props) {
        el.style.removeProperty(prop)
        draftProps.delete(prop)
      }
      if (draftProps.size === 0) {
        this.drafts.delete(el)
        if (!this.structural.has(el)) this.showingOriginal.delete(el)
      }
    } else {
      if (!draftProps && !this.structural.has(el)) return
      if (draftProps) for (const prop of draftProps.keys()) el.style.removeProperty(prop)
      // Structural commit semantics: the code owns the result now. Text → leave the DOM
      // as-is (HMR re-rendered it from source). Delete → leave display:none in place: the
      // JSX is gone from source, so a surviving stale node must stay invisible until the
      // framework drops it — un-hiding it would flash a ghost of the deleted element.
      this.drafts.delete(el)
      this.structural.delete(el)
      this.structuralAddr.delete(el)
      this.showingOriginal.delete(el)
    }
    this.emit()
  }

  /** Targeted structural commit — the structural analog of commit(el, props): forgets the
   * structural draft ONLY when it still matches what was actually sent/verified, so a
   * structural draft re-edited AFTER the send (new text typed while in flight) survives
   * exactly like an un-sent css draft does. DOM is deliberately untouched: text was
   * re-rendered from source by HMR, and a deleted element's display:none must stay on any
   * surviving stale node (see commit()'s structural comment). Takes the wire StructuralOp
   * directly (a TYPE-only import erases at build, so it can't cycle — changelist.ts and
   * lifecycle.ts already type-import it the same way); the match rule is ops.ts's shared
   * opsIdentical, not a third inline copy of the identity table. */
  commitStructural(el: TaggedElement, sent: StructuralOp): void {
    const s = this.structural.get(el)
    if (!s) return
    if (!opsIdentical(draftToOps(s), [sent])) return
    this.structural.delete(el)
    this.structuralAddr.delete(el)
    if (!this.drafts.has(el)) this.showingOriginal.delete(el)
    this.emit()
  }

  discardAll(): void {
    for (const el of [...this.drafts.keys()]) {
      const props = this.drafts.get(el)!
      for (const [prop, d] of props) writeInline(el, prop, d.original)
      this.showingOriginal.delete(el)
    }
    for (const el of [...this.structural.keys()]) {
      this.restoreStructural(el)
      this.showingOriginal.delete(el)
    }
    this.drafts.clear()
    this.structural.clear()
    this.structuralAddr.clear()
    this.emit()
  }

  /** The css+structural drafted-element union — THE one iteration every consumer walks
   * (request builder, changelist, compareAll). Public since the PR #44 review: the two
   * external hand-rolled sweeps of entries()-then-structuralEntries() had already diverged
   * on their isConnected filters. */
  *draftedElements(): IterableIterator<TaggedElement> {
    yield* this.drafts.keys()
    for (const el of this.structural.keys()) if (!this.drafts.has(el)) yield el
  }

  private writeAll(el: TaggedElement, side: 'original' | 'value'): void {
    const props = this.drafts.get(el)
    if (props) for (const [prop, d] of props) writeInline(el, prop, d[side])
    const s = this.structural.get(el)
    if (!s) return
    // 'original' delegates to restoreStructural — ONE owner of what "the original side"
    // means for a structural draft, shared with discard (PR #44 review: the two inline
    // copies would drift the compare-toggle restore apart from the discard restore).
    if (side === 'original') this.restoreStructural(el)
    else if (s.kind === 'text') el.textContent = s.value
    else el.style.setProperty('display', 'none')
  }

  private emit(): void {
    this.onChange?.()
  }
}

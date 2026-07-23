import type { TaggedElement } from './source'

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

  apply(el: TaggedElement, prop: string, value: string): void {
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
      existing.value = value
    } else {
      const original = originalHint ?? el.textContent ?? ''
      if (original === value) return // nothing changed — don't mint a no-op draft
      this.structural.set(el, { kind: 'text', original, value })
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
   * its original before being replaced, so a later discard resurrects the true element. */
  applyDelete(el: TaggedElement): void {
    const existing = this.structural.get(el)
    if (existing?.kind === 'delete') return
    if (existing?.kind === 'text') el.textContent = existing.original
    if (this.drafts.has(el)) this.discard(el) // restores css originals + emits; delete below re-emits
    this.structural.set(el, { kind: 'delete', priorInlineDisplay: el.style.getPropertyValue('display') })
    this.showingOriginal.delete(el)
    el.style.setProperty('display', 'none')
    this.emit()
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
   * Same cheap Map-size read as elementCount(); a draft scrubbed back to its exact original
   * still counts (no-ops are only detectable at send time via computed styles — see
   * buildChangeRequestWithElements), matching elementCount()'s identical blind spot. */
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
    for (const el of this.allDraftedElements()) {
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
    let total = 0
    for (const _ of this.allDraftedElements()) total++
    return total > 0 && this.showingOriginal.size === total
  }

  entries(): ReadonlyMap<TaggedElement, ReadonlyMap<string, { original: string; value: string }>> {
    return this.drafts
  }

  discard(el: TaggedElement, props?: string[]): void {
    const draftProps = this.drafts.get(el)
    if (!draftProps && !(props === undefined && this.structural.has(el))) return
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
      if (draftProps) for (const [prop, d] of draftProps) writeInline(el, prop, d.original)
      this.restoreStructural(el)
      this.drafts.delete(el)
      this.structural.delete(el)
      this.showingOriginal.delete(el)
    }
    this.emit()
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
    if (!draftProps && !(props === undefined && this.structural.has(el))) return
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
      if (draftProps) for (const prop of draftProps.keys()) el.style.removeProperty(prop)
      // Structural commit semantics: the code owns the result now. Text → leave the DOM
      // as-is (HMR re-rendered it from source). Delete → leave display:none in place: the
      // JSX is gone from source, so a surviving stale node must stay invisible until the
      // framework drops it — un-hiding it would flash a ghost of the deleted element.
      this.drafts.delete(el)
      this.structural.delete(el)
      this.showingOriginal.delete(el)
    }
    this.emit()
  }

  /** Targeted structural commit — the structural analog of commit(el, props): forgets the
   * structural draft ONLY when it still matches what was actually sent/verified, so a
   * structural draft re-edited AFTER the send (new text typed while in flight) survives
   * exactly like an un-sent css draft does. DOM is deliberately untouched: text was
   * re-rendered from source by HMR, and a deleted element's display:none must stay on any
   * surviving stale node (see commit()'s structural comment). The param is a structural
   * shape rather than request.ts's StructuralOp to keep this module import-free of the
   * request layer (request.ts already imports DraftStore — a value import back would cycle). */
  commitStructural(el: TaggedElement, sent: { kind: 'text'; after: string } | { kind: 'delete' }): void {
    const s = this.structural.get(el)
    if (!s) return
    if (sent.kind === 'delete' ? s.kind !== 'delete' : s.kind !== 'text' || s.value !== sent.after) return
    this.structural.delete(el)
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
    this.emit()
  }

  private *allDraftedElements(): IterableIterator<TaggedElement> {
    yield* this.drafts.keys()
    for (const el of this.structural.keys()) if (!this.drafts.has(el)) yield el
  }

  private writeAll(el: TaggedElement, side: 'original' | 'value'): void {
    const props = this.drafts.get(el)
    if (props) for (const [prop, d] of props) writeInline(el, prop, d[side])
    const s = this.structural.get(el)
    if (!s) return
    if (s.kind === 'text') el.textContent = side === 'original' ? s.original : s.value
    else if (side === 'original') writeInline(el, 'display', s.priorInlineDisplay)
    else el.style.setProperty('display', 'none')
  }

  private emit(): void {
    this.onChange?.()
  }
}

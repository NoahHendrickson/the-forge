import type { TaggedElement } from './source'

interface DraftProp {
  original: string
  value: string
}

function writeInline(el: TaggedElement, prop: string, css: string): void {
  if (css) el.style.setProperty(prop, css)
  else el.style.removeProperty(prop)
}

export class DraftStore {
  onChange: (() => void) | null = null

  private drafts = new Map<TaggedElement, Map<string, DraftProp>>()
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

  current(el: TaggedElement, prop: string): string | null {
    return this.drafts.get(el)?.get(prop)?.value ?? null
  }

  hasDrafts(el: TaggedElement): boolean {
    return this.drafts.has(el)
  }

  elementCount(): number {
    return this.drafts.size
  }

  compare(el: TaggedElement, on: boolean): void {
    if (!this.drafts.has(el) || on === this.showingOriginal.has(el)) return
    if (on) this.showingOriginal.add(el)
    else this.showingOriginal.delete(el)
    this.writeAll(el, on ? 'original' : 'value')
    this.emit()
  }

  compareAll(on: boolean): void {
    for (const el of this.drafts.keys()) {
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
    return this.drafts.size > 0 && this.showingOriginal.size === this.drafts.size
  }

  entries(): ReadonlyMap<TaggedElement, ReadonlyMap<string, { original: string; value: string }>> {
    return this.drafts
  }

  discard(el: TaggedElement): void {
    const props = this.drafts.get(el)
    if (!props) return
    for (const [prop, d] of props) writeInline(el, prop, d.original)
    this.drafts.delete(el)
    this.showingOriginal.delete(el)
    this.emit()
  }

  discardAll(): void {
    for (const el of [...this.drafts.keys()]) {
      const props = this.drafts.get(el)!
      for (const [prop, d] of props) writeInline(el, prop, d.original)
      this.showingOriginal.delete(el)
    }
    this.drafts.clear()
    this.emit()
  }

  private writeAll(el: TaggedElement, side: 'original' | 'value'): void {
    const props = this.drafts.get(el)
    if (!props) return
    for (const [prop, d] of props) writeInline(el, prop, d[side])
  }

  private emit(): void {
    this.onChange?.()
  }
}

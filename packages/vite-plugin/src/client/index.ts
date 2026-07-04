import { Overlay } from './overlay'
import { findTaggedElement, type TaggedElement } from './source'
import { buildInspectorData } from './inspector'
import { DraftStore } from './drafts'
import { Panel } from './panel'

declare global {
  interface Window {
    __DESIGN_COMPANION__?: { mode: DesignMode }
  }
}

export class DesignMode {
  active = false
  selected: TaggedElement | null = null

  private moveRaf = 0
  private reflowRaf = 0
  private lastMove: MouseEvent | null = null
  private drafts: DraftStore
  private panel: Panel

  constructor(
    private overlay: Overlay,
    panel?: Panel,
    drafts?: DraftStore
  ) {
    this.drafts = drafts ?? new DraftStore()
    this.panel = panel ?? new Panel(this.drafts, () => this.remeasure())
    overlay.toggle.addEventListener('click', () => this.setActive(!this.active))
    overlay.compareAllButton.addEventListener('click', () => {
      this.drafts.compareAll(!this.drafts.isComparingAll())
      this.panel.refresh()
    })
    overlay.resetAllButton.addEventListener('click', () => {
      this.drafts.discardAll()
      this.panel.refresh()
      this.remeasure()
    })
    this.drafts.onChange = () => {
      this.overlay.updateStatus(this.drafts.elementCount(), this.drafts.isComparingAll())
    }
  }

  get panelRoot(): HTMLElement {
    return this.panel.root
  }

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    this.overlay.setActive(on)
    if (on) {
      document.addEventListener('mousemove', this.onMove, true)
      document.addEventListener('click', this.onClick, true)
      document.addEventListener('keydown', this.onKey, true)
      document.addEventListener('scroll', this.onReflow, { capture: true, passive: true })
      window.addEventListener('resize', this.onReflow, { passive: true })
      this.overlay.updateStatus(this.drafts.elementCount(), this.drafts.isComparingAll())
    } else {
      document.removeEventListener('mousemove', this.onMove, true)
      document.removeEventListener('click', this.onClick, true)
      document.removeEventListener('keydown', this.onKey, true)
      document.removeEventListener('scroll', this.onReflow, true)
      window.removeEventListener('resize', this.onReflow)
      if (this.moveRaf) cancelAnimationFrame(this.moveRaf)
      if (this.reflowRaf) cancelAnimationFrame(this.reflowRaf)
      this.moveRaf = 0
      this.reflowRaf = 0
      this.lastMove = null
      this.selected = null
      this.panel.hide()
    }
  }

  select(el: TaggedElement): void {
    this.selected = el
    this.overlay.showSelectOutline(el.getBoundingClientRect())
    this.panel.show(el, buildInspectorData(el))
  }

  deselect(): void {
    this.selected = null
    this.overlay.hideSelectOutline()
    this.panel.hide()
  }

  private remeasure(): void {
    if (this.selected) this.overlay.showSelectOutline(this.selected.getBoundingClientRect())
  }

  private onMove = (e: MouseEvent): void => {
    this.lastMove = e
    if (this.moveRaf) return
    this.moveRaf = requestAnimationFrame(() => {
      this.moveRaf = 0
      const ev = this.lastMove
      if (!this.active || !ev || this.overlay.contains(ev.target)) return
      const el = findTaggedElement(ev.target as Element)
      if (el && el !== this.selected) this.overlay.showOutline(el.getBoundingClientRect())
      else this.overlay.hideOutline()
    })
  }

  private onClick = (e: MouseEvent): void => {
    if (this.overlay.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    const el = findTaggedElement(e.target as Element)
    if (el) this.select(el)
    else this.deselect()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (this.selected) this.deselect()
    else this.setActive(false)
  }

  private onReflow = (): void => {
    if (this.reflowRaf) return
    this.reflowRaf = requestAnimationFrame(() => {
      this.reflowRaf = 0
      if (!this.active) return
      this.remeasure()
      // hover position is stale after scroll/resize — hide; next mousemove redraws
      this.overlay.hideOutline()
      this.lastMove = null
    })
  }
}

function boot(): void {
  const overlay = new Overlay()
  overlay.mount()
  const mode = new DesignMode(overlay)
  overlay.attachPanel(mode.panelRoot)
  window.__DESIGN_COMPANION__ = { mode }
}

if (typeof document !== 'undefined' && !import.meta.vitest) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
}

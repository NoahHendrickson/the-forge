import { Overlay } from './overlay'
import { findTaggedElement } from './source'
import { buildInspectorData } from './inspector'

export class DesignMode {
  active = false
  private rafId = 0

  constructor(private overlay: Overlay) {
    overlay.toggle.addEventListener('click', () => this.setActive(!this.active))
  }

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    this.overlay.setActive(on)
    if (on) {
      document.addEventListener('mousemove', this.onMove, true)
      document.addEventListener('click', this.onClick, true)
      document.addEventListener('keydown', this.onKey, true)
    } else {
      document.removeEventListener('mousemove', this.onMove, true)
      document.removeEventListener('click', this.onClick, true)
      document.removeEventListener('keydown', this.onKey, true)
      if (this.rafId) cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  private onMove = (e: MouseEvent): void => {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      if (!this.active || this.overlay.contains(e.target)) return
      const el = findTaggedElement(e.target as Element)
      if (el) this.overlay.showOutline(el.getBoundingClientRect())
      else this.overlay.hideOutline()
    })
  }

  private onClick = (e: MouseEvent): void => {
    if (this.overlay.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    const el = findTaggedElement(e.target as Element)
    if (el) this.overlay.showPanel(buildInspectorData(el))
    else this.overlay.hidePanel()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.setActive(false)
  }
}

function boot(): void {
  const overlay = new Overlay()
  overlay.mount()
  new DesignMode(overlay)
}

if (typeof document !== 'undefined' && !import.meta.vitest) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
}

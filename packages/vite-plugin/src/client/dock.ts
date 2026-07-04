export type PanelMode = 'docked' | 'floating'

export interface PanelPrefs {
  width: number
  mode: PanelMode
}

export const MIN_WIDTH = 280
export const MAX_WIDTH = 560
export const DEFAULT_WIDTH = 320
export const STORAGE_KEY = 'the-forge:panel'

/**
 * Clamp order matters: MIN is applied LAST so it wins over the 50vw viewport cap on
 * tiny windows — an under-min panel is unusable, while a page squeezed below 50% is
 * merely cramped (user-ratified: min 280 = the pre-dock fixed width, so every existing
 * clip fix keeps holding).
 */
export function clampWidth(width: number, viewportWidth: number): number {
  const max = Math.min(MAX_WIDTH, Math.floor(viewportWidth * 0.5))
  return Math.max(MIN_WIDTH, Math.min(width, max))
}

export function loadPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { width: DEFAULT_WIDTH, mode: 'docked' }
    // unknown + manual checks at the I/O boundary — project convention, no schema libs.
    const parsed: unknown = JSON.parse(raw)
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
      width?: unknown
      mode?: unknown
    }
    const width =
      typeof obj.width === 'number' && Number.isFinite(obj.width) ? obj.width : DEFAULT_WIDTH
    const mode: PanelMode = obj.mode === 'floating' ? 'floating' : 'docked'
    return { width: clampWidth(width, window.innerWidth), mode }
  } catch {
    // Storage disabled (some privacy modes throw) or corrupt JSON — defaults, never crash.
    return { width: DEFAULT_WIDTH, mode: 'docked' }
  }
}

export function savePrefs(prefs: PanelPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Persistence is a nicety — a full/blocked storage must never break an edit session.
  }
}

import type { Panel } from './panel'

/**
 * Owns the docked-vs-floating layout state of the panel. "Docked" pushes the page
 * content left by setting an inline margin-right on <html> (the VisBug-style
 * mechanism) — the page's own position:fixed elements and 100vw sizing don't shift
 * (viewport-relative; we can't shrink the real viewport like DevTools), which is the
 * accepted trade for a dev tool. The pre-existing inline margin (if any) is saved and
 * restored VERBATIM on exit.
 */
export class Dock {
  private prefs: PanelPrefs
  /** null = we have not touched the html margin; '' = touched, page had no inline value. */
  private savedHtmlMarginRight: string | null = null
  private active = false

  constructor(
    private host: HTMLElement,
    private panel: Panel,
    private status: HTMLElement,
    private toggle: HTMLElement
  ) {
    this.prefs = loadPrefs()
    // Seed the width var at boot — pure inline style, no listeners, zero idle overhead.
    this.host.style.setProperty('--forge-dock-w', `${this.prefs.width}px`)
    // Element-scoped listeners on our own shadow DOM (same pattern as Overlay's toggle
    // click) — the document/window-level drag listeners exist only during a drag.
    this.panel.resizeHandle.addEventListener('pointerdown', this.onResizeStart)
    this.panel.modeButton.addEventListener('click', () => {
      this.setMode(this.prefs.mode === 'docked' ? 'floating' : 'docked')
    })
    this.syncModeButton()
  }

  mode(): PanelMode {
    return this.prefs.mode
  }

  width(): number {
    return this.prefs.width
  }

  /** Design mode turned on. */
  enter(): void {
    this.active = true
    if (this.prefs.mode === 'docked') this.applyDocked()
    window.addEventListener('resize', this.onWindowResize)
  }

  /** Design mode turned off — every page mutation is undone here. */
  exit(): void {
    this.active = false
    window.removeEventListener('resize', this.onWindowResize)
    this.removeDocked()
  }

  setMode(mode: PanelMode): void {
    if (mode === this.prefs.mode) return
    this.prefs = { ...this.prefs, mode }
    savePrefs(this.prefs)
    this.syncModeButton()
    if (!this.active) return
    if (mode === 'docked') this.applyDocked()
    else this.removeDocked()
  }

  private applyDocked(): void {
    this.panel.setDocked(true)
    // Same DOM node moves — ids, listeners, and updateStatus() lookups all survive.
    this.panel.footer.appendChild(this.status)
    this.toggle.classList.add('dock-open')
    if (this.savedHtmlMarginRight === null) {
      this.savedHtmlMarginRight = document.documentElement.style.marginRight
    }
    document.documentElement.style.marginRight = `${this.prefs.width}px`
  }

  private removeDocked(): void {
    this.panel.setDocked(false)
    this.host.shadowRoot!.appendChild(this.status)
    this.toggle.classList.remove('dock-open')
    if (this.savedHtmlMarginRight !== null) {
      document.documentElement.style.marginRight = this.savedHtmlMarginRight
      this.savedHtmlMarginRight = null
    }
  }

  private applyWidth(width: number): void {
    this.prefs = { ...this.prefs, width }
    this.host.style.setProperty('--forge-dock-w', `${width}px`)
    if (this.active && this.prefs.mode === 'docked') {
      document.documentElement.style.marginRight = `${width}px`
    }
  }

  private onWindowResize = (): void => {
    const clamped = clampWidth(this.prefs.width, window.innerWidth)
    if (clamped !== this.prefs.width) {
      this.applyWidth(clamped)
      savePrefs(this.prefs)
    }
  }

  private onResizeStart = (e: PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = this.prefs.width
    // Window-level move/up listeners live only for the duration of the drag. No
    // setPointerCapture — jsdom doesn't implement it, and window listeners cover
    // the pointer leaving the handle anyway.
    const onMove = (ev: PointerEvent): void => {
      // Panel is on the RIGHT: dragging the handle LEFT (clientX decreases) widens.
      this.applyWidth(clampWidth(startWidth + (startX - ev.clientX), window.innerWidth))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      savePrefs(this.prefs)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  private syncModeButton(): void {
    const docked = this.prefs.mode === 'docked'
    this.panel.modeButton.textContent = docked ? '⇱' : '⇥'
    this.panel.modeButton.title = docked ? 'Float panel' : 'Dock panel'
  }
}

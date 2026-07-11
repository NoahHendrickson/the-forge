export interface CanvasState { x: number; y: number; scale: number }
export interface CanvasPrefs { on: boolean; state: CanvasState }

export const MIN_SCALE = 0.1
export const MAX_SCALE = 4
export const CANVAS_STORAGE_KEY = 'the-forge:canvas'
export const FIT_MARGIN = 32

export function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))
}

/**
 * Zoom toward a viewport point: the page-point under (cx, cy) must stay under it.
 * With transform-origin 0 0, a page point p projects to p·s + t, so the point under
 * the cursor is p = (c − t)/s and the new translate is t′ = c − p·s′.
 */
export function zoomAt(state: CanvasState, cx: number, cy: number, nextScale: number): CanvasState {
  const scale = clampScale(nextScale)
  const px = (cx - state.x) / state.scale
  const py = (cy - state.y) / state.scale
  return { x: cx - px * scale, y: cy - py * scale, scale }
}

export function panBy(state: CanvasState, dx: number, dy: number): CanvasState {
  return { x: state.x + dx, y: state.y + dy, scale: state.scale }
}

/**
 * Fit the whole artboard into the viewport area the panel doesn't cover. MIN_SCALE
 * deliberately wins over "whole page visible" for absurdly tall pages — a sub-10%
 * artboard is unreadable and unclickable, so the floor is the better failure mode.
 */
export function fitState(
  viewportW: number, viewportH: number, pageW: number, pageH: number, panelW: number
): CanvasState {
  const availW = Math.max(1, viewportW - panelW - FIT_MARGIN * 2)
  const availH = Math.max(1, viewportH - FIT_MARGIN * 2)
  const scale = clampScale(Math.min(availW / Math.max(1, pageW), availH / Math.max(1, pageH)))
  return {
    x: FIT_MARGIN + Math.max(0, (availW - pageW * scale) / 2),
    y: FIT_MARGIN + Math.max(0, (availH - pageH * scale) / 2),
    scale,
  }
}

const DEFAULT_STATE: CanvasState = { x: 0, y: 0, scale: 1 }

export function loadCanvasPrefs(): CanvasPrefs {
  try {
    const raw = sessionStorage.getItem(CANVAS_STORAGE_KEY)
    if (!raw) return { on: false, state: { ...DEFAULT_STATE } }
    // unknown + manual checks at the I/O boundary — project convention, no schema libs.
    const parsed: unknown = JSON.parse(raw)
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
      on?: unknown
      state?: unknown
    }
    const s = (typeof obj.state === 'object' && obj.state !== null ? obj.state : {}) as {
      x?: unknown; y?: unknown; scale?: unknown
    }
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback
    return {
      on: obj.on === true,
      state: { x: num(s.x, 0), y: num(s.y, 0), scale: clampScale(num(s.scale, 1)) },
    }
  } catch {
    // Storage disabled or corrupt JSON — defaults, never crash (dock.ts pattern).
    return { on: false, state: { ...DEFAULT_STATE } }
  }
}

export function saveCanvasPrefs(p: CanvasPrefs): void {
  try {
    sessionStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Persistence is a nicety — a full/blocked storage must never break the session.
  }
}

export const CANVAS_BG = '#3c3c3c'
const ARTBOARD_SHADOW = '0 4px 32px rgba(0,0,0,0.35)'

export interface CanvasModeOpts {
  dock: { setCanvasActive(on: boolean): void; mode(): 'docked' | 'floating'; width(): number }
  hostContains: (t: EventTarget | null) => boolean
  onChange: () => void
}

interface SavedStyles {
  bodyTransform: string
  bodyTransformOrigin: string
  bodyBoxShadow: string
  bodyBackgroundColor: string
  htmlOverflow: string
  htmlBackgroundColor: string
}

function isEditable(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
  )
}

export class CanvasMode {
  private prefs: CanvasPrefs
  private state: CanvasState = { x: 0, y: 0, scale: 1 }
  private saved: SavedStyles | null = null

  constructor(private opts: CanvasModeOpts) {
    this.prefs = loadCanvasPrefs()
  }

  isOn(): boolean { return this.prefs.on }
  isApplied(): boolean { return this.saved !== null }
  scale(): number { return this.state.scale }

  setOn(on: boolean): void {
    if (on === this.prefs.on) return
    this.prefs = { ...this.prefs, on }
    saveCanvasPrefs(this.prefs)
    // Fresh toggle-on seeds pixel-identical from the live scroll — NOT from the persisted
    // state (that path is resume()/reload, where the page scroll is gone but the canvas
    // view survives in prefs).
    if (on) this.apply({ x: -window.scrollX, y: -window.scrollY, scale: 1 })
    else this.unapply()
    this.opts.onChange()
  }

  /** Design mode turned on — re-enter canvas if this session had it on. */
  resume(): void {
    if (this.prefs.on && !this.isApplied()) {
      this.apply(this.prefs.state)
      this.opts.onChange()
    }
  }

  /** Design mode turned off — every page mutation undone, preference kept. */
  suspend(): void {
    if (this.isApplied()) {
      this.unapply()
      this.opts.onChange()
    }
  }

  setZoomCentered(scale: number): void {
    this.setState(zoomAt(this.state, window.innerWidth / 2, window.innerHeight / 2, scale))
  }

  zoomToFit(): void {
    const panelW = this.opts.dock.mode() === 'docked' ? this.opts.dock.width() : 0
    this.setState(
      fitState(
        window.innerWidth, window.innerHeight,
        document.body.scrollWidth, document.body.scrollHeight, panelW
      )
    )
  }

  private apply(seed: CanvasState): void {
    if (this.saved !== null) return
    const html = document.documentElement
    const body = document.body
    this.saved = {
      bodyTransform: body.style.transform,
      bodyTransformOrigin: body.style.transformOrigin,
      bodyBoxShadow: body.style.boxShadow,
      bodyBackgroundColor: body.style.backgroundColor,
      htmlOverflow: html.style.overflow,
      htmlBackgroundColor: html.style.backgroundColor,
    }
    // Read the html background BEFORE painting it gray — if the page's background lives
    // on <html> and body is transparent, the artboard must keep the page's color or the
    // whole page reads as canvas-gray.
    const bodyBg = getComputedStyle(body).backgroundColor
    const htmlBg = getComputedStyle(html).backgroundColor
    // An UNSET background computes to 'rgba(0, 0, 0, 0)' (never ''), so the fallback
    // decision needs the same transparent check as body — a bare `htmlBg === ''` test
    // would copy transparent onto body and leave the artboard canvas-gray.
    const isTransparent = (c: string): boolean =>
      c === 'transparent' || c === 'rgba(0, 0, 0, 0)' || c === ''
    html.style.overflow = 'hidden'
    html.style.backgroundColor = CANVAS_BG
    if (isTransparent(bodyBg)) body.style.backgroundColor = isTransparent(htmlBg) ? '#ffffff' : htmlBg
    body.style.boxShadow = ARTBOARD_SHADOW
    body.style.transformOrigin = '0 0'
    this.setState(seed)
    this.addListeners()
    this.opts.dock.setCanvasActive(true)
  }

  private unapply(): void {
    if (this.saved === null) return
    this.removeListeners()
    // Where to land the real scroll: the page-point currently at the viewport top-left.
    const sx = Math.max(0, -this.state.x / this.state.scale)
    const sy = Math.max(0, -this.state.y / this.state.scale)
    const html = document.documentElement
    const body = document.body
    body.style.transform = this.saved.bodyTransform
    body.style.transformOrigin = this.saved.bodyTransformOrigin
    body.style.boxShadow = this.saved.bodyBoxShadow
    body.style.backgroundColor = this.saved.bodyBackgroundColor
    html.style.overflow = this.saved.htmlOverflow
    html.style.backgroundColor = this.saved.htmlBackgroundColor
    this.saved = null
    this.opts.dock.setCanvasActive(false)
    window.scrollTo(sx, sy)
  }

  private setState(next: CanvasState): void {
    this.state = next
    document.body.style.transform =
      `translate(${next.x}px, ${next.y}px) scale(${next.scale})`
    this.prefs = { ...this.prefs, state: next }
    saveCanvasPrefs(this.prefs)
    this.opts.onChange()
  }

  private spaceHeld = false
  private didPan = false

  /** composedPath()[0] over e.target — shadow DOM retargets, same convention as ui/menu. */
  private realTarget(e: Event): EventTarget | null {
    return e.composedPath?.()[0] ?? e.target
  }

  private onWheel = (e: WheelEvent): void => {
    if (this.opts.hostContains(this.realTarget(e))) return // panel scrolls itself
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      // Pinch arrives as ctrlKey wheel (Chrome/Safari/Firefox). Exponential factor keeps
      // zoom speed feel constant across devices and directions.
      const factor = Math.exp(-e.deltaY * 0.01)
      this.setState(zoomAt(this.state, e.clientX, e.clientY, this.state.scale * factor))
    } else {
      this.setState(panBy(this.state, -e.deltaX, -e.deltaY))
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = this.realTarget(e)
    if (isEditable(target) || this.opts.hostContains(target)) return
    if (e.code === 'Space') {
      this.spaceHeld = true
      e.preventDefault() // page can't scroll anyway; this stops button re-activation
      return
    }
    if (e.shiftKey && e.code === 'Digit0') { e.preventDefault(); this.setZoomCentered(1) }
    else if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); this.zoomToFit() }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.spaceHeld = false
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.spaceHeld || e.button !== 0) return
    if (this.opts.hostContains(this.realTarget(e))) return
    e.preventDefault()
    e.stopPropagation() // window-capture fires before index.ts's document-capture handlers
    this.didPan = false
    const startX = e.clientX
    const startY = e.clientY
    const start = this.state
    const onMove = (ev: PointerEvent): void => {
      this.didPan = true
      this.setState(panBy(start, ev.clientX - startX, ev.clientY - startY))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // The click that follows a pan-drag would land as a selection click — squelch
      // exactly one. window-capture beats index.ts's document-capture click handler.
      if (this.didPan) {
        const squelch = (ce: MouseEvent): void => { ce.stopPropagation(); ce.preventDefault() }
        window.addEventListener('click', squelch, { capture: true, once: true })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  private addListeners(): void {
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('pointerdown', this.onPointerDown, true)
  }

  private removeListeners(): void {
    window.removeEventListener('wheel', this.onWheel, true)
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('pointerdown', this.onPointerDown, true)
    this.spaceHeld = false
  }
}

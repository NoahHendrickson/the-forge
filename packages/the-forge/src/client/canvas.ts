import { armPageTransition } from './motion'

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

/** px per DOM_DELTA_LINE wheel step — Firefox mouse wheels report ±3 LINES per notch, not
 *  pixels; without this a Firefox pan crawls at ~3px/notch (30× slower than Chrome). */
export const WHEEL_LINE_PX = 16

/** Per-event cap on the zoom wheel delta. A discrete mouse notch is deltaY ≈ ±100–120,
 *  which through exp(−d·0.01) would jump ~2.7–3.3× per notch; capped at 32 a notch steps
 *  e^0.32 ≈ 1.38× (Figma-like). Trackpad pinch deltas are small (<~30/event) and land
 *  under the cap, so pinch speed is unchanged. */
export const ZOOM_WHEEL_CLAMP = 32

/**
 * Figma's keyboard-zoom ladder — powers of two (… 25% 50% 100% 200% 400%), clamped.
 * The ±1e-9 epsilon keeps a scale already ON a stop moving to the NEXT one instead of
 * re-landing on itself through float noise.
 */
export function zoomStopAfter(s: number): number {
  return clampScale(Math.pow(2, Math.floor(Math.log2(s) + 1e-9) + 1))
}

export function zoomStopBefore(s: number): number {
  return clampScale(Math.pow(2, Math.ceil(Math.log2(s) - 1e-9) - 1))
}

/** A rectangle in PAGE coordinates (untransformed body space). */
export interface PageRect { x: number; y: number; w: number; h: number }

/** A rectangle in VIEWPORT coordinates (post-canvas-transform, getBoundingClientRect space).
 *  Deliberately a distinct shape from PageRect — the two coordinate spaces must never be
 *  conflated, and zoomToSelection() owns the only mapping between them. */
export interface ViewportRect { left: number; top: number; width: number; height: number }

/** Union AABB of the elements' client rects, or null when empty — the selectionRect
 *  feeder, kept here so index.ts's opt wiring stays a one-liner (2026-07-11 PR review). */
export function unionClientRect(els: ReadonlyArray<Element>): ViewportRect | null {
  if (els.length === 0) return null
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const el of els) {
    const r = el.getBoundingClientRect()
    left = Math.min(left, r.left)
    top = Math.min(top, r.top)
    right = Math.max(right, r.right)
    bottom = Math.max(bottom, r.bottom)
  }
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * Fit a page-space rect into the viewport area the panel doesn't cover, centered.
 * Shared by zoom-to-fit (rect = the whole artboard) and Shift+2 zoom-to-selection.
 */
export function fitRectState(
  viewportW: number, viewportH: number, rect: PageRect, panelW: number
): CanvasState {
  const availW = Math.max(1, viewportW - panelW - FIT_MARGIN * 2)
  const availH = Math.max(1, viewportH - FIT_MARGIN * 2)
  const scale = clampScale(Math.min(availW / Math.max(1, rect.w), availH / Math.max(1, rect.h)))
  return {
    x: FIT_MARGIN + Math.max(0, (availW - rect.w * scale) / 2) - rect.x * scale,
    y: FIT_MARGIN + Math.max(0, (availH - rect.h * scale) / 2) - rect.y * scale,
    scale,
  }
}

/**
 * Fit the whole artboard into the viewport area the panel doesn't cover. MIN_SCALE
 * deliberately wins over "whole page visible" for absurdly tall pages — a sub-10%
 * artboard is unreadable and unclickable, so the floor is the better failure mode.
 */
export function fitState(
  viewportW: number, viewportH: number, pageW: number, pageH: number, panelW: number
): CanvasState {
  return fitRectState(viewportW, viewportH, { x: 0, y: 0, w: pageW, h: pageH }, panelW)
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
  /** Current selection's bounding box in VIEWPORT coordinates (already canvas-transformed),
   *  or null when nothing is selected — Shift+2 zoom-to-selection. */
  selectionRect?: () => ViewportRect | null
}

interface SavedStyles {
  bodyTransform: string
  bodyTransformOrigin: string
  bodyWillChange: string
  bodyBoxShadow: string
  bodyBackgroundColor: string
  htmlOverflow: string
  htmlBackgroundColor: string
  htmlCursor: string
}

/** Exported since the Figma pivot (P1): index.ts's Del-to-delete guard needs the exact same
 * "typing surface" rule as canvas mode's Space/zoom shortcuts — one definition, not two. */
export function isEditable(t: EventTarget | null): boolean {
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
    // Fresh toggle-on seeds pixel-identical from the live scroll — NOT from the persisted
    // state (that path is resume()/reload, where the page scroll is gone but the canvas
    // view survives in prefs).
    if (on) this.apply({ x: -window.scrollX, y: -window.scrollY, scale: 1 })
    else this.unapply()
    // setState (via apply) and unapply() are the only onChange notify sites (single-site
    // notification, 2026-07-11 review) — no explicit call here, or this fires twice per toggle.
    this.persist()
  }

  /** Design mode turned on — re-enter canvas if this session had it on. */
  resume(): void {
    if (this.prefs.on && !this.isApplied()) {
      // apply() -> setState() is the sole notify site here (single-site notification).
      this.apply(this.prefs.state)
    }
  }

  /** Design mode turned off — every page mutation undone, preference kept. */
  suspend(): void {
    if (this.isApplied()) {
      // unapply() notifies and persists itself (single-site notification).
      this.unapply()
    }
  }

  setZoomCentered(scale: number): void {
    this.armZoomTween()
    this.setState(zoomAt(this.state, window.innerWidth / 2, window.innerHeight / 2, scale))
    this.persist()
  }

  /** One keyboard/menu zoom step through the powers-of-2 ladder (Figma's +/− behavior). */
  zoomStep(dir: 1 | -1): void {
    this.setZoomCentered(dir > 0 ? zoomStopAfter(this.state.scale) : zoomStopBefore(this.state.scale))
  }

  private panelWidth(): number {
    return this.opts.dock.mode() === 'docked' ? this.opts.dock.width() : 0
  }

  zoomToFit(): void {
    this.armZoomTween()
    this.setState(
      fitState(
        window.innerWidth, window.innerHeight,
        document.body.scrollWidth, document.body.scrollHeight, this.panelWidth()
      )
    )
    this.persist()
  }

  /** Shift+2 — fit the current selection (Figma parity). No-op without a selection. */
  zoomToSelection(): void {
    const r = this.opts.selectionRect?.()
    if (!r || r.width <= 0 || r.height <= 0) return
    this.armZoomTween()
    // selectionRect is viewport-space (post-transform) — map back to page space first.
    const { x, y, scale } = this.state
    const page: PageRect = {
      x: (r.left - x) / scale, y: (r.top - y) / scale,
      w: r.width / scale, h: r.height / scale,
    }
    this.setState(fitRectState(window.innerWidth, window.innerHeight, page, this.panelWidth()))
    this.persist()
  }

  private apply(seed: CanvasState): void {
    if (this.saved !== null) return
    const html = document.documentElement
    const body = document.body
    this.saved = {
      bodyTransform: body.style.transform,
      bodyTransformOrigin: body.style.transformOrigin,
      bodyWillChange: body.style.willChange,
      bodyBoxShadow: body.style.boxShadow,
      bodyBackgroundColor: body.style.backgroundColor,
      htmlOverflow: html.style.overflow,
      htmlBackgroundColor: html.style.backgroundColor,
      htmlCursor: html.style.cursor,
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
    // Keep the artboard on its own compositor layer for the whole canvas session — pan/zoom
    // writes transform every tick, and without the hint some engines re-rasterize on the
    // main thread per frame instead of compositing.
    body.style.willChange = 'transform'
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
    body.style.willChange = this.saved.bodyWillChange
    body.style.boxShadow = this.saved.bodyBoxShadow
    body.style.backgroundColor = this.saved.bodyBackgroundColor
    html.style.overflow = this.saved.htmlOverflow
    html.style.backgroundColor = this.saved.htmlBackgroundColor
    html.style.cursor = this.saved.htmlCursor
    this.saved = null
    this.opts.dock.setCanvasActive(false)
    window.scrollTo(sx, sy)
    // unapply() is a discrete action (suspend/design-off/exit) AND the single notify site
    // for the "turned off" transition (single-site onChange, 2026-07-11 review) — persist
    // the final state (covers suspend, so a reload after suspend restores the last view)
    // and notify exactly once here, not at every caller (setOn(false)/suspend()).
    this.persist()
    this.opts.onChange()
  }

  /** Splits paint from persist: setState (called on every wheel tick / pointermove) must
   *  stay a pure, cheap DOM write — synchronous JSON.stringify + sessionStorage.setItem on
   *  every tick would jank a trackpad pan. Gesture ends and discrete actions (setZoomCentered,
   *  zoomToFit, setOn, unapply) call persist() directly; wheel has no end event, so onWheel
   *  debounces it instead (Dock persists on gesture-end for the same reason — dock.ts onUp). */
  private persist(): void {
    saveCanvasPrefs(this.prefs)
  }

  private setState(next: CanvasState): void {
    this.state = next
    document.body.style.transform =
      `translate(${next.x}px, ${next.y}px) scale(${next.scale})`
    this.prefs = { ...this.prefs, state: next }
    this.opts.onChange()
  }

  private spaceHeld = false
  private didPan = false
  /** Live drag teardown — set while a space-drag is in flight so removeListeners() can
   *  kill the transient move/up/cancel pair; otherwise a mid-drag unapply() leaves them
   *  alive and the next pointermove writes a transform onto the already-restored page. */
  private dragTeardown: (() => void) | null = null

  /** The armed once:true click squelch (below), so removeListeners() can remove it directly —
   *  without a reference, a gesture that ends without a following click (design mode toggled
   *  off before the browser's click fires, or the user never clicks again) leaves this window
   *  listener alive indefinitely and it eats one unrelated page click whenever it does land,
   *  even after design mode is off (a zero-idle-overhead violation). */
  private clickSquelch: ((e: MouseEvent) => void) | null = null

  /** composedPath()[0] over e.target — shadow DOM retargets, same convention as ui/menu. */
  private realTarget(e: Event): EventTarget | null {
    return e.composedPath?.()[0] ?? e.target
  }

  /** Trailing debounce for the continuous gestures' persist() — wheel and Safari pinch have
   *  no gesture-end event usable as a persist point (unlike pointerup/setZoomCentered/
   *  zoomToFit), so a full trackpad pan would otherwise never persist until the NEXT
   *  discrete action. Idle-zero holds: the timer only exists while actively gesturing —
   *  armed here, cleared (and flushed) in removeListeners(). */
  private wheelPersistTimer: ReturnType<typeof setTimeout> | null = null

  private armPersistDebounce(): void {
    if (this.wheelPersistTimer) clearTimeout(this.wheelPersistTimer)
    this.wheelPersistTimer = setTimeout(() => {
      this.wheelPersistTimer = null
      this.persist()
    }, 250)
  }

  /** Undoes an in-flight discrete-zoom tween (restores body's prior inline transition
   * verbatim). Non-null only while a tween is live — the continuous-gesture paths call it
   * unconditionally per tick, so the null-check must stay the cheap common case. */
  private zoomTweenCleanup: (() => void) | null = null

  /** Arms a transform tween for the NEXT setState write — the discrete zooms only
   * (fit/ladder/percent-menu/Shift+0-1-2). Enter/exit stay seamless by construction (the
   * seed transform matches the live scroll), and wheel/pinch/drag must never be damped:
   * every continuous path clears this before writing. The arm/restore/self-clean dance
   * (incl. the transitionend bubbling guard) lives in motion.ts's armPageTransition —
   * shared with Dock's margin push. EASE_OUT, not the spring: an overshooting zoom
   * re-rasterizes the artboard past its target and reads as focus hunting. */
  private armZoomTween(): void {
    if (this.saved === null) return
    this.zoomTweenCleanup?.()
    this.zoomTweenCleanup = armPageTransition(document.body, 'transform', () => {
      this.zoomTweenCleanup = null
    })
  }

  /** Paint only if the gesture actually moved the state — at the zoom clamp every further
   *  pinch tick resolves to an identical state, and repainting it would burn a transform
   *  write + a full onChange (chrome sync + outline reflow) per tick for nothing. */
  private setStateIfChanged(next: CanvasState): void {
    const s = this.state
    if (next.x === s.x && next.y === s.y && next.scale === s.scale) return
    this.setState(next)
  }

  private onWheel = (e: WheelEvent): void => {
    if (this.opts.hostContains(this.realTarget(e))) return // panel scrolls itself
    e.preventDefault()
    this.zoomTweenCleanup?.() // continuous gesture — direct manipulation must never be damped
    // deltaMode normalization: Firefox mouse wheels report LINES (±3/notch), not pixels.
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? window.innerHeight : 1
    if (e.ctrlKey || e.metaKey) {
      // Pinch arrives as ctrlKey wheel on Chrome/Firefox (Safari uses gesture events, below).
      // Exponential factor keeps zoom speed feel constant across devices and directions;
      // the clamp tames discrete mouse notches without touching pinch (see ZOOM_WHEEL_CLAMP).
      const dy = Math.max(-ZOOM_WHEEL_CLAMP, Math.min(ZOOM_WHEEL_CLAMP, e.deltaY * unit))
      const factor = Math.exp(-dy * 0.01)
      this.setStateIfChanged(zoomAt(this.state, e.clientX, e.clientY, this.state.scale * factor))
    } else {
      let dx = e.deltaX * unit
      let dy = e.deltaY * unit
      // Shift+wheel pans horizontally (Figma standard). Browsers that already remap
      // shift+wheel report it in deltaX — only swap when the device gave us none.
      if (e.shiftKey && dx === 0) { dx = dy; dy = 0 }
      this.setStateIfChanged(panBy(this.state, -dx, -dy))
    }
    this.armPersistDebounce()
  }

  // ── Safari pinch ────────────────────────────────────────────────────────────
  // Safari does NOT synthesize ctrlKey wheel events for trackpad pinch — it fires
  // nonstandard gesturestart/gesturechange/gestureend with a cumulative e.scale
  // relative to gesture start. Without these the browser page-zooms instead.
  private gestureStartScale = 1

  private onGestureStart = (e: Event): void => {
    if (this.opts.hostContains(this.realTarget(e))) return
    e.preventDefault()
    this.gestureStartScale = this.state.scale
  }

  private onGestureChange = (e: Event): void => {
    if (this.opts.hostContains(this.realTarget(e))) return
    e.preventDefault()
    this.zoomTweenCleanup?.() // continuous gesture — direct manipulation must never be damped
    const g = e as Event & { scale?: number; clientX?: number; clientY?: number }
    if (typeof g.scale !== 'number' || !Number.isFinite(g.scale) || g.scale <= 0) return
    const cx = typeof g.clientX === 'number' ? g.clientX : window.innerWidth / 2
    const cy = typeof g.clientY === 'number' ? g.clientY : window.innerHeight / 2
    this.setStateIfChanged(zoomAt(this.state, cx, cy, this.gestureStartScale * g.scale))
    this.armPersistDebounce()
  }

  private onGestureEnd = (e: Event): void => {
    e.preventDefault()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = this.realTarget(e)
    if (isEditable(target) || this.opts.hostContains(target)) return
    if (e.code === 'Space') {
      this.spaceHeld = true
      e.preventDefault() // page can't scroll anyway; this stops button re-activation
      // Hand cursor while space is armed — Figma's pan affordance. Skipped mid-drag so
      // auto-repeat can't downgrade an active 'grabbing' back to 'grab'.
      if (!this.dragTeardown) this.setCursor('grab')
      return
    }
    if (e.shiftKey && e.code === 'Digit0') { e.preventDefault(); this.setZoomCentered(1) }
    else if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); this.zoomToFit() }
    else if (e.shiftKey && e.code === 'Digit2') { e.preventDefault(); this.zoomToSelection() }
    // Bare +/− step the zoom ladder (Figma). Modified +/− (Cmd/Ctrl) stays the browser's.
    else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.code === 'Equal' || e.code === 'NumpadAdd') { e.preventDefault(); this.zoomStep(1) }
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); this.zoomStep(-1) }
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    // No isEditable/hostContains guards on purpose: clearing is idempotent, and spaceHeld
    // can only be true if the matching keydown already passed those guards. NOTE: keyup is
    // NOT guaranteed to arrive — Cmd+Tab (or any focus-stealing app switch) while Space is
    // held swallows the keyup entirely, so this alone is not sufficient; onBlur (below) is
    // the backstop for that case.
    if (e.code === 'Space') {
      this.spaceHeld = false
      if (!this.dragTeardown) this.setCursor('')
    }
  }

  /** Backstop for the keyup that never arrives: losing window focus (Cmd+Tab, alt-tab,
   *  clicking another app) mid Space-hold means the OS delivers the keyup to whatever
   *  window now has focus, not this page — spaceHeld would otherwise stick forever and
   *  the next pointerdown in this window would wrongly start a pan. Blur must kill BOTH
   *  the space-hold state AND any in-flight drag: with the pointer gone no pointermove
   *  arrives either (so onMove's buttons===0 self-heal can't fire), and the stale onUp
   *  closure would otherwise catch the REFOCUS click's pointerup — finish() doesn't
   *  inspect the event — and arm a squelch off the old didPan, eating that unrelated click. */
  private onBlur = (): void => {
    this.spaceHeld = false // before the teardown: finish() restores the cursor from spaceHeld
    this.dragTeardown?.() // finish(false) — removes the drag listeners, restores the cursor, no squelch
    this.setCursor('') // no-drag path: drop the 'grab' affordance (teardown already restored otherwise)
  }

  /** Cursor writes go on <html> (the overlay host's parent) so they win over page CSS
   *  without touching body. Clearing ('') restores the page's own saved inline cursor —
   *  not a bare wipe — so a page that set one keeps it between gestures. */
  private setCursor(c: string): void {
    document.documentElement.style.cursor = c || (this.saved?.htmlCursor ?? '')
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Two pan triggers, both Figma's: space+left-drag, and middle-button drag (no space).
    // preventDefault on middle also suppresses Chrome's autoscroll widget.
    const middle = e.button === 1
    if (!middle && !(this.spaceHeld && e.button === 0)) return
    if (this.opts.hostContains(this.realTarget(e))) return
    e.preventDefault()
    e.stopPropagation() // window-capture fires before index.ts's document-capture handlers
    this.setCursor('grabbing')
    this.didPan = false
    // Pan incrementally from LIVE state, not a frozen pointerdown snapshot — a wheel
    // pan/zoom landing mid-drag must survive the next pointermove instead of being
    // silently reverted to the anchor.
    let lastX = e.clientX
    let lastY = e.clientY
    // The drag belongs to ONE pointer. On pen/touch-equipped hardware a second pointer's
    // stream interleaves with the drag's — a hovering pen reports buttons===0 on its own
    // moves, which would trip the self-heal below and silently end a live mouse drag (and
    // before the self-heal existed, its moves caused pan jitter instead). Filter every
    // drag listener to the pointer that started the gesture.
    const dragPointerId = e.pointerId
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== dragPointerId) return
      // Self-heal a lost pointerup/pointercancel: an app-switch mid-drag can deliver the
      // button release to a DIFFERENT window, so this gesture never sees pointerup at all —
      // the next pointermove we DO get still reports the live button state, and buttons===0
      // means nothing is held anymore. Treat that as the missed gesture-end. No squelch: the
      // browser never fires a click for a gesture whose pointerup it never delivered either.
      if (ev.buttons === 0) { finish(false); return }
      this.zoomTweenCleanup?.() // continuous gesture — direct manipulation must never be damped
      this.didPan = true
      this.setState(panBy(this.state, ev.clientX - lastX, ev.clientY - lastY))
      lastX = ev.clientX
      lastY = ev.clientY
    }
    const finish = (installSquelch: boolean): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      this.dragTeardown = null
      this.setCursor(this.spaceHeld ? 'grab' : '')
      this.persist() // drag ended — a discrete gesture-end, persist regardless of squelch path
      // The click that follows a pan-drag would land as a selection click — squelch
      // exactly one. window-capture beats index.ts's document-capture click handler.
      // Only pointerup gets one: pointercancel (and forced teardown) means the browser
      // never fires a click for this gesture, so arming it would eat an unrelated click.
      if (installSquelch && this.didPan) {
        // A prior pan's squelch that never consumed (the browser dropped that gesture's
        // click) must not accumulate as an orphan only removeListeners' TRACKED reference
        // can't reach — disarm it before arming the replacement, so at most one live
        // squelch ever exists.
        if (this.clickSquelch) window.removeEventListener('click', this.clickSquelch, true)
        const squelch = (ce: MouseEvent): void => {
          ce.stopPropagation()
          ce.preventDefault()
          this.clickSquelch = null // consumed — the once:true listener already removed itself
        }
        this.clickSquelch = squelch
        window.addEventListener('click', squelch, { capture: true, once: true })
      }
    }
    // A middle-button release fires auxclick, not click — index.ts's selection handler
    // never sees it, so no squelch to arm on that path.
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== dragPointerId) return
      finish(!middle)
    }
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId !== dragPointerId) return
      finish(false)
    }
    this.dragTeardown = () => finish(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  private addListeners(): void {
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('pointerdown', this.onPointerDown, true)
    // Safari-only pinch path — feature-detected so other engines never pay for it.
    if ('GestureEvent' in window) {
      window.addEventListener('gesturestart', this.onGestureStart, { capture: true, passive: false })
      window.addEventListener('gesturechange', this.onGestureChange, { capture: true, passive: false })
      window.addEventListener('gestureend', this.onGestureEnd, { capture: true, passive: false })
    }
  }

  private removeListeners(): void {
    this.dragTeardown?.() // a drag in flight must not outlive canvas mode
    this.zoomTweenCleanup?.() // unapply() calls removeListeners() before restoring saved
    // styles — the body's transition must be back to its pre-tween value first, no ordering hazard.
    if (this.wheelPersistTimer) {
      clearTimeout(this.wheelPersistTimer)
      this.wheelPersistTimer = null
      this.persist() // a pending debounced write must not be dropped by teardown
    }
    window.removeEventListener('wheel', this.onWheel, true)
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('pointerdown', this.onPointerDown, true)
    // Unconditional (no feature gate) — removing a never-added listener is a no-op.
    window.removeEventListener('gesturestart', this.onGestureStart, true)
    window.removeEventListener('gesturechange', this.onGestureChange, true)
    window.removeEventListener('gestureend', this.onGestureEnd, true)
    // An armed once:true click squelch that never fired (design mode toggled off before the
    // browser's click landed) must not outlive the gesture — see clickSquelch's doc comment.
    if (this.clickSquelch) {
      window.removeEventListener('click', this.clickSquelch, true)
      this.clickSquelch = null
    }
    this.spaceHeld = false
  }
}

# Canvas mode — pan/zoom the real page like a Figma canvas (2026-07-11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: [docs/specs/2026-07-11-canvas-mode-design.md](../specs/2026-07-11-canvas-mode-design.md).

**Goal:** An opt-in canvas mode inside design mode: the page becomes a full-height artboard on a gray canvas — pan with the wheel, zoom 10%–400% with ctrl/cmd-wheel (pinch), space-drag, Shift+0/Shift+1 — while the panel stays docked exactly as today and the page lays out at full viewport width (dock margin push suspended).

**Architecture:** One new client module `src/client/canvas.ts` (`CanvasMode` class + exported pure math/prefs helpers). The whole mechanism is a single inline `transform: translate(x,y) scale(z)` on `<body>` (`transform-origin: 0 0`), document scroll frozen, every touched inline style saved/restored verbatim (dock.ts discipline). The overlay host moves from `body` to `documentElement` (unconditional) so our chrome never sits in the transformed subtree. `Dock` gains a `setCanvasActive` flag that suspends only the `margin-right` push. Selection/outlines/ripple/inspector/verifier are untouched — they already operate on visual rects and computed styles, both correct under an ancestor transform.

**Tech stack:** TypeScript, vanilla DOM in the shadow overlay, vitest + jsdom, Storybook for the new chrome. Zero new dependencies.

## Global constraints (from spec + CLAUDE.md)

- Zero new runtime dependencies; zero production footprint; **zero idle overhead** — no canvas listener exists until canvas mode is actually on; all are removed on suspend/exit.
- Panel stays docked — no floating panel. Canvas mode never changes panel layout, only the page underneath.
- Enter is pixel-identical (seed `translate(-scrollX, -scrollY) scale(1)`); exit restores inline styles verbatim and scrolls to the content that was at the viewport top-left.
- Zoom clamp **0.1–4** (10%–400%). Keys: **Shift+0** → 100%, **Shift+1** → fit (never Cmd+0/± — those fight browser zoom). Ignored when focus is in an input or inside the overlay host.
- New buttons via `src/client/ui/` factories; new CSS classes are test hooks (`.canvas-toggle`, `.zoom-pill`, `.zoom-pill-wrap`); **no comments inside the CSS string** (bundle bytes — guard-tested lesson).
- `unknown` + manual checks at the sessionStorage boundary (`'the-forge:canvas'`); no schema libs.
- Tests mirror `src/`; root `npm test` green after every task; single-file runs from `packages/the-forge/`.
- jsdom cannot see transforms/layout/hit-testing — Task 8's real-browser E2E is the merge gate.
- Budget first: client bundle ~236/250KB before this work; measure after Task 7 and keep the module lean (~3–4KB min target).

**Sequencing:** Tasks 1→7 in order (each `npm test`-green, each its own commit), Task 8 is the E2E + docs gate.

---

### Task 1 — pure canvas math + prefs (`canvas.ts` foundations)

**Files:**
- Create: `packages/the-forge/src/client/canvas.ts`
- Test: `packages/the-forge/tests/client/canvas.test.ts`

**Interfaces produced (later tasks rely on these exact names):**

```ts
export interface CanvasState { x: number; y: number; scale: number }
export interface CanvasPrefs { on: boolean; state: CanvasState }
export const MIN_SCALE = 0.1
export const MAX_SCALE = 4
export const CANVAS_STORAGE_KEY = 'the-forge:canvas'
export const FIT_MARGIN = 32
export function clampScale(s: number): number
export function zoomAt(state: CanvasState, cx: number, cy: number, nextScale: number): CanvasState
export function panBy(state: CanvasState, dx: number, dy: number): CanvasState
export function fitState(viewportW: number, viewportH: number, pageW: number, pageH: number, panelW: number): CanvasState
export function loadCanvasPrefs(): CanvasPrefs
export function saveCanvasPrefs(p: CanvasPrefs): void
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/client/canvas.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  clampScale, zoomAt, panBy, fitState, loadCanvasPrefs, saveCanvasPrefs,
  MIN_SCALE, MAX_SCALE, CANVAS_STORAGE_KEY, FIT_MARGIN,
} from '../../src/client/canvas'

describe('clampScale', () => {
  it('clamps to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(1.5)).toBe(1.5)
  })
})

describe('zoomAt', () => {
  it('holds the page-point under the cursor fixed (the zoom invariant)', () => {
    const s0 = { x: -100, y: -50, scale: 1 }
    const cx = 400, cy = 300
    const s1 = zoomAt(s0, cx, cy, 2)
    // page point under cursor before: p = (c - t)/s
    const px = (cx - s0.x) / s0.scale
    const py = (cy - s0.y) / s0.scale
    // after: same page point must project back to the cursor
    expect(px * s1.scale + s1.x).toBeCloseTo(cx)
    expect(py * s1.scale + s1.y).toBeCloseTo(cy)
    expect(s1.scale).toBe(2)
  })
  it('clamps the requested scale', () => {
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 0, 0, 100).scale).toBe(MAX_SCALE)
  })
})

describe('panBy', () => {
  it('shifts translate, leaves scale alone', () => {
    expect(panBy({ x: 10, y: 20, scale: 2 }, -5, 15)).toEqual({ x: 5, y: 35, scale: 2 })
  })
})

describe('fitState', () => {
  it('fits a tall page fully inside the viewport minus panel and margins, centered', () => {
    const s = fitState(1280, 800, 1280, 4000, 320)
    const availW = 1280 - 320 - FIT_MARGIN * 2
    const availH = 800 - FIT_MARGIN * 2
    expect(s.scale).toBeCloseTo(Math.min(availW / 1280, availH / 4000))
    // whole artboard inside the available box
    expect(s.x).toBeGreaterThanOrEqual(FIT_MARGIN)
    expect(s.y).toBeCloseTo(FIT_MARGIN)
    expect(4000 * s.scale + s.y).toBeLessThanOrEqual(800 - FIT_MARGIN + 0.5)
  })
  it('never returns a scale below MIN_SCALE even for absurdly tall pages', () => {
    expect(fitState(1280, 800, 1280, 100000, 320).scale).toBe(MIN_SCALE)
  })
})

describe('canvas prefs', () => {
  beforeEach(() => sessionStorage.clear())
  it('defaults when nothing stored', () => {
    expect(loadCanvasPrefs()).toEqual({ on: false, state: { x: 0, y: 0, scale: 1 } })
  })
  it('round-trips', () => {
    saveCanvasPrefs({ on: true, state: { x: -12, y: -300, scale: 0.5 } })
    expect(loadCanvasPrefs()).toEqual({ on: true, state: { x: -12, y: -300, scale: 0.5 } })
  })
  it('survives garbage and clamps scale', () => {
    sessionStorage.setItem(CANVAS_STORAGE_KEY, '{"on":"yes","state":{"x":"a","scale":9000}}')
    const p = loadCanvasPrefs()
    expect(p.on).toBe(false)
    expect(p.state).toEqual({ x: 0, y: 0, scale: MAX_SCALE })
    sessionStorage.setItem(CANVAS_STORAGE_KEY, 'not json')
    expect(loadCanvasPrefs().on).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run (from `packages/the-forge/`): `npx vitest run tests/client/canvas.test.ts`
Expected: FAIL — cannot resolve `../../src/client/canvas`.

- [ ] **Step 3: Implement**

```ts
// src/client/canvas.ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/client/canvas.test.ts` → PASS. Then root `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/canvas.ts packages/the-forge/tests/client/canvas.test.ts
git commit -m "feat(client): canvas-mode math + prefs (zoom invariant, clamps, fit, sessionStorage)"
```

---

### Task 2 — overlay host relocation to `<html>`

**Files:**
- Modify: `packages/the-forge/src/client/overlay.ts` (`mount()`, currently `document.body.appendChild(this.host)` at ~line 734)
- Test: `packages/the-forge/tests/client/overlay.test.ts`

**Interfaces:** none new — `Overlay.mount()` behavior changes; also add `attachChrome(el: HTMLElement)` (same body as `attachPanel`) for Task 7's zoom pill.

- [ ] **Step 1: Write the failing test** (append to `overlay.test.ts`, matching its existing setup helpers)

```ts
it('mounts the host on documentElement, not body — canvas mode transforms <body>, our chrome must stay out of the transformed subtree', () => {
  const overlay = new Overlay()
  overlay.mount()
  expect(overlay.host.parentElement).toBe(document.documentElement)
  expect(document.body.contains(overlay.host)).toBe(false)
})
```

(Adapt construction to the file's existing pattern if `new Overlay()` takes args there — copy a neighboring test's setup.)

- [ ] **Step 2: Run to verify failure**

`npx vitest run tests/client/overlay.test.ts` → FAIL (parent is body).

- [ ] **Step 3: Implement**

```ts
  mount(): void {
    // On <html>, not <body>: canvas mode applies a transform to <body>, and a transformed
    // ancestor hijacks position:fixed — every overlay outline/panel is fixed-positioned.
    // Bonus: app CSS like `body > *` can no longer style the host.
    document.documentElement.appendChild(this.host)
  }

  attachChrome(el: HTMLElement): void {
    this.host.shadowRoot!.appendChild(el)
  }
```

- [ ] **Step 4: Run the FULL suite** — other tests may assert the old parent or rely on body containment.

`npm test` from the root. Fix any failures by updating the assertion to `documentElement` (behavioral change is intended). Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/overlay.test.ts
git commit -m "refactor(client): mount overlay host on <html> so body transforms never touch our chrome"
```

---

### Task 3 — `Dock.setCanvasActive` (suspend the margin push)

**Files:**
- Modify: `packages/the-forge/src/client/dock.ts`
- Test: `packages/the-forge/tests/client/dock.test.ts`

**Interfaces produced:**

```ts
// on Dock:
setCanvasActive(on: boolean): void
```

Semantics: while canvas is active, docked mode keeps ALL its behavior (panel layout, status relocation, width var) except the `margin-right` push on `<html>` — the page lays out full-width and the canvas pans behind the panel. The saved original margin is written back during canvas (not `''` — the page may have had its own inline margin), and the normal push repaints when canvas ends.

- [ ] **Step 1: Write the failing tests** (append to `dock.test.ts`, reusing its fixture helpers)

```ts
it('setCanvasActive(true) writes the page original margin back while docked; false repaints the push', () => {
  document.documentElement.style.marginRight = '7px' // page's own inline margin
  const dock = makeDock() // file's existing helper
  dock.enter()
  expect(document.documentElement.style.marginRight).toBe(`${dock.width()}px`)
  dock.setCanvasActive(true)
  expect(document.documentElement.style.marginRight).toBe('7px')
  dock.setCanvasActive(false)
  expect(document.documentElement.style.marginRight).toBe(`${dock.width()}px`)
  dock.exit()
  expect(document.documentElement.style.marginRight).toBe('7px')
})

it('exit() while canvas is active still restores the original margin verbatim', () => {
  document.documentElement.style.marginRight = ''
  const dock = makeDock()
  dock.enter()
  dock.setCanvasActive(true)
  dock.exit()
  expect(document.documentElement.style.marginRight).toBe('')
})
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run tests/client/dock.test.ts` → FAIL (`setCanvasActive` not a function).

- [ ] **Step 3: Implement** — a flag consulted only inside `syncWidth`:

```ts
  /** True while canvas mode owns the page: the margin push is suspended (the artboard
   * lays out full-width and pans behind the panel) but docked layout is otherwise
   * unchanged. The saved original margin is what gets written back — not '' — so a
   * page's own inline margin survives the whole canvas session. */
  private canvasActive = false

  setCanvasActive(on: boolean): void {
    if (on === this.canvasActive) return
    this.canvasActive = on
    if (this.active && this.prefs.mode === 'docked') this.syncWidth()
  }
```

and in `syncWidth()` replace the margin write:

```ts
    if (this.active && this.prefs.mode === 'docked') {
      document.documentElement.style.marginRight = this.canvasActive
        ? (this.savedHtmlMarginRight ?? '')
        : `${width}px`
    }
```

(`removeDocked` is untouched — its verbatim restore already covers exit-during-canvas.)

- [ ] **Step 4: Run to verify pass**

`npx vitest run tests/client/dock.test.ts` → PASS. Root `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/dock.ts packages/the-forge/tests/client/dock.test.ts
git commit -m "feat(client): Dock.setCanvasActive suspends the margin push while canvas owns the page"
```

---

### Task 4 — `CanvasMode` class: apply/unapply, resume/suspend, setOn

**Files:**
- Modify: `packages/the-forge/src/client/canvas.ts` (add the class below the helpers)
- Test: `packages/the-forge/tests/client/canvas.test.ts` (append)

**Interfaces produced:**

```ts
export interface CanvasModeOpts {
  dock: { setCanvasActive(on: boolean): void; mode(): 'docked' | 'floating'; width(): number }
  hostContains: (t: EventTarget | null) => boolean
  onChange: () => void   // fired after every on/off flip and state change — Task 7's UI sync
}
export class CanvasMode {
  constructor(opts: CanvasModeOpts)
  isOn(): boolean                 // the user preference (survives suspend)
  isApplied(): boolean            // transform currently on the page
  scale(): number
  setOn(on: boolean): void        // user toggled — persists
  resume(): void                  // design mode on — re-applies if pref is on
  suspend(): void                 // design mode off — restores page, keeps pref
  setZoomCentered(scale: number): void
  zoomToFit(): void
}
```

Interaction listeners come in Task 5 — this task is pure state + style save/restore (jsdom-safe).

- [ ] **Step 1: Write the failing tests** (append; `beforeEach` clears sessionStorage and strips inline styles from `document.documentElement`/`document.body`)

```ts
function makeCanvas(over: Partial<CanvasModeOpts> = {}): { canvas: CanvasMode; dockCalls: boolean[] } {
  const dockCalls: boolean[] = []
  const canvas = new CanvasMode({
    dock: { setCanvasActive: (on) => dockCalls.push(on), mode: () => 'docked', width: () => 320 },
    hostContains: () => false,
    onChange: () => {},
    ...over,
  })
  return { canvas, dockCalls }
}

describe('CanvasMode enter/exit', () => {
  it('setOn(true) freezes scroll, transforms body, tells the dock; setOn(false) restores verbatim', () => {
    document.body.style.transform = 'skew(1deg)'      // page's own inline styles must survive
    document.documentElement.style.overflow = 'auto'
    const { canvas, dockCalls } = makeCanvas()
    canvas.setOn(true)
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(document.body.style.transform).toMatch(/translate\(.*\) scale\(1\)/)
    expect(document.body.style.transformOrigin).toBe('0 0')
    expect(dockCalls).toEqual([true])
    canvas.setOn(false)
    expect(document.body.style.transform).toBe('skew(1deg)')
    expect(document.documentElement.style.overflow).toBe('auto')
    expect(dockCalls).toEqual([true, false])
  })

  it('entry is seeded from the current scroll position (pixel-identical)', () => {
    Object.defineProperty(window, 'scrollY', { value: 250, configurable: true })
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true })
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    expect(document.body.style.transform).toBe('translate(0px, -250px) scale(1)')
    canvas.setOn(false)
  })

  it('exit scrolls to the page-point at the viewport top-left', () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.setZoomCentered(0.5) // some non-trivial state
    canvas.setOn(false)
    const [x, y] = scrollTo.mock.calls[0] as [number, number]
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
    vi.unstubAllGlobals()
  })

  it('suspend() restores the page but keeps the pref; resume() re-applies it', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.suspend()
    expect(document.body.style.transform).toBe('')
    expect(canvas.isOn()).toBe(true)
    expect(canvas.isApplied()).toBe(false)
    canvas.resume()
    expect(canvas.isApplied()).toBe(true)
    canvas.setOn(false)
  })

  it('resume() with the pref off does nothing', () => {
    const { canvas } = makeCanvas()
    canvas.resume()
    expect(canvas.isApplied()).toBe(false)
    expect(document.body.style.transform).toBe('')
  })

  it('persists on/state so a reload restores the same view', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.setZoomCentered(2)
    const saved = loadCanvasPrefs()
    expect(saved.on).toBe(true)
    expect(saved.state.scale).toBe(2)
    canvas.setOn(false)
  })

  it('copies the html background onto a transparent body so the artboard is not gray', () => {
    document.documentElement.style.backgroundColor = 'rgb(20, 20, 30)'
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    expect(document.body.style.backgroundColor).toBe('rgb(20, 20, 30)')
    canvas.setOn(false)
    expect(document.body.style.backgroundColor).toBe('')
    document.documentElement.style.backgroundColor = ''
  })
})
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run tests/client/canvas.test.ts` → FAIL (`CanvasMode` not exported).

- [ ] **Step 3: Implement** (in `canvas.ts`; listeners land in Task 5 — `addListeners`/`removeListeners` are empty stubs here)

```ts
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
    const transparent = bodyBg === 'transparent' || bodyBg === 'rgba(0, 0, 0, 0)' || bodyBg === ''
    html.style.overflow = 'hidden'
    html.style.backgroundColor = CANVAS_BG
    if (transparent) body.style.backgroundColor = htmlBg === '' ? '#ffffff' : htmlBg
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

  private addListeners(): void {}   // Task 5
  private removeListeners(): void {} // Task 5
}
```

- [ ] **Step 4: Run to verify pass**

`npx vitest run tests/client/canvas.test.ts` → PASS. Root `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/canvas.ts packages/the-forge/tests/client/canvas.test.ts
git commit -m "feat(client): CanvasMode apply/unapply with verbatim style restore and scroll handoff"
```

---

### Task 5 — interaction listeners: wheel pan/zoom, space-drag, Shift+0/1

**Files:**
- Modify: `packages/the-forge/src/client/canvas.ts` (fill in `addListeners`/`removeListeners`)
- Test: `packages/the-forge/tests/client/canvas.test.ts` (append)

**Interfaces:** none new. All listeners exist only between `apply()` and `unapply()`.

Bindings (spec §Interaction): plain wheel → pan; ctrl/cmd-wheel (pinch emits ctrlKey) → zoom toward cursor; Space held + drag → pan; Shift+0 → 100% centered; Shift+1 → fit. Events whose `composedPath()` starts inside the overlay host pass through untouched (panel scrolls itself). Key handling skipped when the target is editable (`input`/`textarea`/`select`/contenteditable) or inside the host.

- [ ] **Step 1: Write the failing tests**

```ts
function bodyTransform(): string { return document.body.style.transform }

describe('CanvasMode interactions', () => {
  it('plain wheel pans; ctrl-wheel zooms toward the cursor; both prevented', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true) // seeds translate(0px, 0px) scale(1) at scroll 0
    const pan = new WheelEvent('wheel', { deltaX: 10, deltaY: 40, cancelable: true, bubbles: true })
    window.dispatchEvent(pan)
    expect(pan.defaultPrevented).toBe(true)
    expect(bodyTransform()).toBe('translate(-10px, -40px) scale(1)')
    const zoom = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0, cancelable: true, bubbles: true })
    window.dispatchEvent(zoom)
    expect(zoom.defaultPrevented).toBe(true)
    expect(bodyTransform()).toContain('scale(') // scale changed
    expect(canvas.scale()).toBeGreaterThan(1)
    canvas.setOn(false)
  })

  it('wheel inside the overlay host passes through untouched', () => {
    const { canvas } = makeCanvas({ hostContains: () => true })
    canvas.setOn(true)
    const e = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(bodyTransform()).toBe('translate(0px, 0px) scale(1)')
    canvas.setOn(false)
  })

  it('Shift+0 → 100%, Shift+1 → fit; both skipped when focus is editable', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.setZoomCentered(2)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit0', shiftKey: true, bubbles: true }))
    expect(canvas.scale()).toBe(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', shiftKey: true, bubbles: true }))
    // jsdom has no layout: body scrollWidth/Height are 0, so fitState clamps to MAX_SCALE.
    // This asserts the key ROUTED to zoomToFit (scale left 1) — fit geometry is E2E's job.
    expect(canvas.scale()).toBe(MAX_SCALE)
    const input = document.createElement('input')
    document.body.appendChild(input)
    canvas.setZoomCentered(2)
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit0', shiftKey: true, bubbles: true }))
    expect(canvas.scale()).toBe(2)
    input.remove()
    canvas.setOn(false)
  })

  it('space+drag pans and squelches the click that would select', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, cancelable: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 130, clientY: 80, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }))
    expect(bodyTransform()).toBe('translate(30px, -20px) scale(1)')
    // the click right after a pan-drag must not reach the page (selection would fire)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    const reached = vi.fn()
    document.addEventListener('click', reached, true)
    window.dispatchEvent(click)
    expect(reached).not.toHaveBeenCalled()
    document.removeEventListener('click', reached, true)
    canvas.setOn(false)
  })

  it('listeners are fully gone after setOn(false) — zero idle overhead', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.setOn(false)
    const e = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(bodyTransform()).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run tests/client/canvas.test.ts` → FAIL (wheel does nothing — stubs).

- [ ] **Step 3: Implement**

```ts
function isEditable(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
  )
}
```

Class fields + handlers (arrow properties, dock.ts drag pattern for the transient move/up pair):

```ts
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
```

- [ ] **Step 4: Run to verify pass**

`npx vitest run tests/client/canvas.test.ts` → PASS. Root `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/canvas.ts packages/the-forge/tests/client/canvas.test.ts
git commit -m "feat(client): canvas interactions — wheel pan, ctrl-wheel zoom-to-cursor, space-drag, Shift+0/1"
```

---

### Task 6 — `createMenuButton` gains `label` + `opensUp` (zoom pill needs both)

**Files:**
- Modify: `packages/the-forge/src/client/ui/menu.ts`
- Modify: `packages/the-forge/stories/menu.stories.ts` (add a zoom-pill-shaped story)
- Test: `packages/the-forge/tests/client/ui.test.ts` (append)

**Interfaces produced:** two additive optional fields on `MenuButtonOpts` — existing call sites unchanged:

```ts
export interface MenuButtonOpts {
  // ...existing fields...
  /** Trigger label — defaults to the '▾' chevron. Call sites may update button.textContent live. */
  label?: string
  /** Open the popover ABOVE the trigger (for bottom-anchored chrome like the zoom pill). */
  opensUp?: boolean
}
```

- [ ] **Step 1: Write the failing tests** (append to `ui.test.ts`, following its existing menu tests' setup)

```ts
it('createMenuButton honors a custom label', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const menu = createMenuButton({ label: '100%', items: () => [], onSelect: () => {}, popoverHost: host })
  expect(menu.button.textContent).toBe('100%')
  host.remove()
})

it('opensUp positions the popover above the trigger', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const menu = createMenuButton({
    opensUp: true,
    items: () => [{ value: 'a', label: 'A' }],
    onSelect: () => {},
    popoverHost: host,
  })
  host.appendChild(menu.button)
  menu.button.click()
  const popover = host.querySelector('.menu-popover') as HTMLElement
  expect(popover).toBeTruthy()
  // jsdom has no layout (offsetTop/Height are 0) — assert the sign of the offset instead
  // of real geometry: an opensUp popover's top must be <= the trigger's offsetTop.
  expect(parseFloat(popover.style.top)).toBeLessThanOrEqual(menu.button.offsetTop)
  menu.close()
  host.remove()
})
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run tests/client/ui.test.ts` → FAIL (label ignored / popover below).

- [ ] **Step 3: Implement**

In `createMenuButton`, replace the button creation line:

```ts
  const button = createButton({ label: opts.label ?? '▾', title: opts.title, className: 'menu-btn' })
```

and in `open()`, replace the `popover.style.top` line with:

```ts
    // Append before measuring — offsetHeight is 0 until the popover is in the tree.
    opts.popoverHost.append(popover)
    popover.style.top = opts.opensUp
      ? `${button.offsetTop - popover.offsetHeight - 2}px`
      : `${button.offsetTop + button.offsetHeight + 2}px`
```

(Keep the existing `left` clamp line as-is, and drop the old duplicate `append` further down.)

- [ ] **Step 4: Add the story** — in `stories/menu.stories.ts`, add a story rendering the real control shaped like the zoom pill (label `'100%'`, `opensUp: true`, items `Zoom to fit · 50% · 100% ✓ · 200%`), following the file's existing story pattern.

- [ ] **Step 5: Run to verify pass**

`npx vitest run tests/client/ui.test.ts` → PASS. Root `npm test` → green. Optional visual check: `npm run storybook -w forge-mode`.

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/ui/menu.ts packages/the-forge/tests/client/ui.test.ts packages/the-forge/stories/menu.stories.ts
git commit -m "feat(ui): menu factory learns custom trigger label and opens-up positioning"
```

---

### Task 7 — chrome + wiring: panel toggle, zoom pill, index.ts lifecycle

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts` (new header button, next to `modeButton` — appended at ~line 206)
- Modify: `packages/the-forge/src/client/overlay.ts` (CSS additions to the `CSS` const)
- Modify: `packages/the-forge/src/client/index.ts` (construct + lifecycle + pill)
- Test: `packages/the-forge/tests/client/panel.test.ts`, `packages/the-forge/tests/client/canvas.test.ts` (append)

**Interfaces produced:**

```ts
// panel.ts — new public field, same pattern as modeButton:
canvasButton: HTMLButtonElement   // classes: 'panel-mode canvas-toggle'; '.on' class when active
```

- [ ] **Step 1: Write the failing tests**

`panel.test.ts` (follow the file's existing header-button tests):

```ts
it('renders the canvas toggle in the header actions, before the dock-mode button', () => {
  const panel = makePanel() // file's existing helper
  const btn = panel.root.querySelector('.canvas-toggle') as HTMLButtonElement
  expect(btn).toBeTruthy()
  expect(btn.nextElementSibling).toBe(panel.modeButton)
})
```

- [ ] **Step 2: Run to verify failure**

`npx vitest run tests/client/panel.test.ts` → FAIL.

- [ ] **Step 3: Implement panel button** — in `panel.ts` next to the `modeButton` field (~line 64):

```ts
  canvasButton = createButton({ label: '⛶', title: 'Canvas mode', className: 'panel-mode canvas-toggle' })
```

set `this.canvasButton.type = 'button'` beside the `modeButton` setup (~line 202), and change the header append (~line 206) to:

```ts
    this.headActions.append(this.promptButton, this.canvasButton, this.modeButton)
```

- [ ] **Step 4: CSS additions** — in `overlay.ts`'s `CSS` const (no comments in the string). Reuse the existing header-button look via the shared `panel-mode` class; only the active state and the pill are new:

```css
.canvas-toggle.on { color: var(--forge-accent, #4e9cf6); }
.zoom-pill-wrap { position: fixed; left: 16px; bottom: 16px; z-index: 2147483647; }
.zoom-pill-wrap[hidden] { display: none; }
.zoom-pill-wrap .menu-btn { min-width: 52px; padding: 6px 10px; border-radius: 8px; }
```

Match the pill's colors/font to the `.status`/`.toggle` chrome already in the file — copy those declarations rather than inventing new ones. If the file has no `--forge-accent` var, use the same literal the panel uses for active/selected states (find it in the `CSS` const; do not add a new color).

- [ ] **Step 5: Wire index.ts.** In the class that owns `dock`/`overlay`/`panel` (Dock is constructed at ~line 164):

```ts
  private canvas: CanvasMode
  private zoomPillWrap = document.createElement('div')
  private zoomMenu: MenuButton
```

Construction (right after the `dock` line):

```ts
    this.canvas = new CanvasMode({
      dock: this.dock,
      hostContains: (t) => this.overlay.contains(t),
      onChange: () => this.syncCanvasUi(),
    })
    this.zoomPillWrap.className = 'zoom-pill-wrap'
    this.zoomPillWrap.hidden = true
    this.zoomMenu = createMenuButton({
      label: '100%',
      opensUp: true,
      popoverHost: this.zoomPillWrap,
      items: () => [
        { value: 'fit', label: 'Zoom to fit' },
        { value: '0.5', label: '50%', checked: this.canvas.scale() === 0.5, separator: true },
        { value: '1', label: '100%', checked: this.canvas.scale() === 1 },
        { value: '2', label: '200%', checked: this.canvas.scale() === 2 },
      ],
      onSelect: (v) => (v === 'fit' ? this.canvas.zoomToFit() : this.canvas.setZoomCentered(Number(v))),
    })
    this.zoomMenu.button.classList.add('zoom-pill')
    this.zoomPillWrap.appendChild(this.zoomMenu.button)
    this.overlay.attachChrome(this.zoomPillWrap)
    this.panel.canvasButton.addEventListener('click', () => this.canvas.setOn(!this.canvas.isOn()))
```

UI sync (new private method):

```ts
  private syncCanvasUi(): void {
    const applied = this.canvas.isApplied()
    this.zoomPillWrap.hidden = !applied
    this.zoomMenu.button.textContent = `${Math.round(this.canvas.scale() * 100)}%`
    this.panel.canvasButton.classList.toggle('on', this.canvas.isOn())
    this.panel.canvasButton.title = this.canvas.isOn() ? 'Exit canvas mode' : 'Canvas mode'
  }
```

Lifecycle in `setActive` (lines ~529/~567): after `this.dock.enter()` add `this.canvas.resume()`; in the off-branch, immediately before `this.dock.exit()` add `this.canvas.suspend()` (canvas must clear its dock flag while the dock is still active, so the margin repaint path stays coherent).

- [ ] **Step 6: Append a wiring test** to `canvas.test.ts` (or `panel.test.ts` if index-level fixtures live there — follow where existing `setActive` tests are):

```ts
it('design-mode off suspends canvas (page restored) and design-mode on resumes it', () => {
  // use the file's existing app/index fixture; pseudocode shape:
  app.setActive(true)
  app.panel.canvasButton.click()
  expect(document.body.style.transform).toContain('scale(1)')
  app.setActive(false)
  expect(document.body.style.transform).toBe('')
  app.setActive(true)
  expect(document.body.style.transform).toContain('scale(')
  app.setActive(false)
})
```

- [ ] **Step 7: Run to verify pass**

`npx vitest run tests/client/panel.test.ts tests/client/canvas.test.ts` → PASS. Root `npm test` → green.

- [ ] **Step 8: Commit**

```bash
git add packages/the-forge/src/client/panel.ts packages/the-forge/src/client/overlay.ts packages/the-forge/src/client/index.ts packages/the-forge/tests/client/panel.test.ts packages/the-forge/tests/client/canvas.test.ts
git commit -m "feat(client): canvas toggle in panel header + zoom pill, wired into design-mode lifecycle"
```

---

### Task 8 — docs, budget, real-browser E2E (merge gate)

**Files:**
- Modify: `CLAUDE.md` (add `canvas.ts` row to the src/client modules table; add a gotcha line: canvas mode owns the wheel — inner scrollables and document-level sticky UI are inert while it's on)
- Modify: `docs/HANDOFF.md` if it tracks milestone state (follow its existing format)

- [ ] **Step 1: Budget check**

```bash
npm run build
wc -c packages/the-forge/dist/client.js   # expect ≤ ~250KB total, delta ~3–4KB vs main
./scripts/check-prod-clean.sh             # must stay green (320KB package budget)
```

If the delta exceeds ~5KB, hunt bytes (comments in CSS strings, duplicated literals) before proceeding.

- [ ] **Step 2: Real-browser E2E against the demo app** (jsdom proves nothing here — standing gotcha). `lsof -iTCP:5173` first; kill stale servers. Then `npm run dev -w demo-app`, open `localhost:5173`, and walk:

1. Toggle design mode (bottom-right) → panel docks, page pushed as today.
2. Click `⛶` in the panel header → page becomes an artboard on gray; **no pixel jump** at entry; panel still full-height docked right; page now full-width behind it.
3. Wheel → pans. Ctrl/cmd-wheel (and trackpad pinch) → zooms toward cursor; zoom pill % updates; clamp stops at 10%/400%.
4. Shift+1 → whole page visible beside the panel; Shift+0 → 100%. Space-drag → grab pan, and releasing does NOT select the element under the cursor.
5. While zoomed ~50%: hover outlines hug elements, click selects, panel shows correct values, edit a padding → draft preview lands correctly, ripple outlines align.
6. Send (↑) → queue item written; run the agent loop (or `mark_applied` manually) → verifier flips the row to Implemented **while still zoomed**.
7. Panel wheel-scroll works over the panel (passthrough); zoom-pill menu opens upward.
8. Toggle `⛶` off → page restores byte-identical inline styles (inspect `<body>`/`<html>` style attributes in devtools), scroll lands on the content you were looking at.
9. Toggle design mode off while canvas is on → everything restores; design mode back on → canvas resumes where it was. Reload the page with canvas on → canvas state restores after design mode re-activates.
10. Repeat a spot-check on the Next demo (`npm run dev -w next-demo`, port 5175): enter canvas, zoom, select, edit — same client bundle, should be identical.

- [ ] **Step 3: Update CLAUDE.md** — module table row:

```
| `canvas.ts` | `CanvasMode` — Figma-style canvas: body transform pan/zoom, artboard backdrop, wheel/space/Shift+0/1 bindings, sessionStorage persistence (`'the-forge:canvas'`) |
```

and the gotcha bullet (Gotchas section): "Canvas mode owns the wheel while on — inner scrollable divs and document-level sticky/scroll-triggered UI are inert until it's toggled off; the panel still scrolls itself (composedPath passthrough)."

- [ ] **Step 4: Full gate + commit**

```bash
npm test && ./scripts/check-prod-clean.sh
git add CLAUDE.md docs/
git commit -m "docs: canvas-mode module row + wheel-ownership gotcha; E2E pass recorded"
```

Merge decision belongs to the user (house rule) — present the branch, don't merge.

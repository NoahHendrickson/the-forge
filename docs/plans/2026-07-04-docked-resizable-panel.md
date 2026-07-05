# Docked Resizable Panel + Text-Cutoff Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The properties panel docks to the right edge by default (pushing page content left via an inline `margin-right` on `<html>`), gains a drag-to-resize left edge (280px min, persisted to localStorage), keeps floating mode behind a dock/float toggle, and fixes the known text-cutoff spots.

**Architecture:** New `src/client/dock.ts` owns mode/width prefs, html-margin apply/restore, status-strip re-parenting, and the resize drag. `panel.ts` gains a docked flex-column structure (pinned footer, empty state, mode button, resize handle) and moves its scroll container from the root to a new `.panel-body`. `overlay.ts` gains the dock CSS and exposes `status`. `index.ts` wires `Dock.enter()/exit()` into `DesignMode.setActive`. Spec: `docs/specs/2026-07-04-docked-panel-design.md`.

**Tech Stack:** unchanged — TypeScript strict, vanilla DOM in shadow root, vitest + jsdom. No new dependencies.

## Global Constraints

- No new runtime dependencies. `npm test` (typecheck + full vitest) is the gate; `./scripts/check-prod-clean.sh` must stay green (250KB budget).
- Zero idle overhead: no NEW document/window-level listeners while design mode is off. (Element-scoped listeners on our own shadow DOM, e.g. the resize handle's `pointerdown`, follow the existing toggle-button pattern and are fine.)
- Panel/overlay CSS class names are test hooks — **additions only, nothing renamed**. New classes: `docked`, `panel-body`, `panel-footer`, `panel-empty`, `panel-resize`, `panel-mode`, `dock-open`, `src-dir`, `src-tail`.
- Width clamp: min **280**, max `min(560, 50vw)`; **min wins** on tiny viewports (a usable panel beats visible page). Default 320. Storage key `the-forge:panel`, shape `{ width: number, mode: 'docked' | 'floating' }`.
- Restore any pre-existing inline `margin-right` on `<html>` verbatim — never clobber to `''` unconditionally.
- `unknown` + manual checks at the localStorage boundary — no schema libraries.
- Why-comments are load-bearing — preserve verbatim when moving code.
- jsdom cannot see layout — Task 6's real-browser E2E is mandatory before merge.

---

### Task 1: Prefs module (pure functions in `dock.ts`)

**Files:**
- Create: `packages/vite-plugin/src/client/dock.ts`
- Test: `packages/vite-plugin/tests/client/dock.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces (Task 3 and 4 rely on these exact names):
  - `type PanelMode = 'docked' | 'floating'`
  - `interface PanelPrefs { width: number; mode: PanelMode }`
  - `const MIN_WIDTH = 280`, `MAX_WIDTH = 560`, `DEFAULT_WIDTH = 320`, `STORAGE_KEY = 'the-forge:panel'`
  - `clampWidth(width: number, viewportWidth: number): number`
  - `loadPrefs(): PanelPrefs`
  - `savePrefs(prefs: PanelPrefs): void`

- [ ] **Step 1: Write the failing tests**

`tests/client/dock.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  clampWidth,
  loadPrefs,
  savePrefs,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH,
  STORAGE_KEY,
} from '../../src/client/dock'

beforeEach(() => {
  localStorage.clear()
})

describe('clampWidth', () => {
  it('passes through in-range widths', () => {
    expect(clampWidth(320, 1280)).toBe(320)
  })
  it('clamps below MIN_WIDTH up to 280', () => {
    expect(clampWidth(100, 1280)).toBe(MIN_WIDTH)
  })
  it('clamps above MAX_WIDTH down to 560', () => {
    expect(clampWidth(900, 1280)).toBe(MAX_WIDTH)
  })
  it('caps at 50% of the viewport when that is below MAX_WIDTH', () => {
    expect(clampWidth(560, 800)).toBe(400)
  })
  it('MIN wins over the 50vw cap on tiny viewports (usable panel beats visible page)', () => {
    expect(clampWidth(320, 400)).toBe(MIN_WIDTH)
  })
})

describe('loadPrefs / savePrefs', () => {
  it('defaults to docked / DEFAULT_WIDTH when storage is empty', () => {
    expect(loadPrefs()).toEqual({ width: DEFAULT_WIDTH, mode: 'docked' })
  })
  it('round-trips savePrefs -> loadPrefs', () => {
    savePrefs({ width: 400, mode: 'floating' })
    expect(loadPrefs()).toEqual({ width: 400, mode: 'floating' })
  })
  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadPrefs()).toEqual({ width: DEFAULT_WIDTH, mode: 'docked' })
  })
  it('falls back per-field on wrong types and unknown modes', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: 'wide', mode: 'sideways' }))
    expect(loadPrefs()).toEqual({ width: DEFAULT_WIDTH, mode: 'docked' })
  })
  it('re-clamps a stored width against the current viewport', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: 5000, mode: 'docked' }))
    expect(loadPrefs().width).toBeLessThanOrEqual(MAX_WIDTH)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vite-plugin && npx vitest run tests/client/dock.test.ts`
Expected: FAIL — `Cannot find module '../../src/client/dock'`

- [ ] **Step 3: Implement the prefs module**

`src/client/dock.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vite-plugin && npx vitest run tests/client/dock.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/dock.ts packages/vite-plugin/tests/client/dock.test.ts
git commit -m "Dock prefs: clampWidth + localStorage load/save with corrupt-value fallback"
```

---

### Task 2: Panel structure — flex column, footer, empty state, resize handle, mode button

**Files:**
- Modify: `packages/vite-plugin/src/client/panel.ts` (constructor ~139-186, `show()` ~188-216, `hide()` ~218-224)
- Modify: `packages/vite-plugin/src/client/overlay.ts` (the `CSS` string const)
- Test: `packages/vite-plugin/tests/client/panel.test.ts` (append new describe block)
- Test: `packages/vite-plugin/tests/client/overlay.test.ts` (append new describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 3 wires these):
  - `Panel.footer: HTMLElement` (class `panel-footer`) — Dock re-parents `#status` into it.
  - `Panel.resizeHandle: HTMLElement` (class `panel-resize`) — Dock attaches `pointerdown`.
  - `Panel.modeButton: HTMLButtonElement` (class `panel-mode`) — Dock attaches `click` and sets its glyph/title.
  - `Panel.setDocked(on: boolean): void` — toggles the `docked` class on `Panel.root` and re-applies no-selection visibility (empty state when docked, hidden root when floating).

**Key structural decision (why-comment material):** the scroll container moves from `#panel` to a new `.panel-body` class on the existing `body` div, and `.panel-body` becomes `position: relative` with the popovers re-parented into it (`new ColorPicker(this.body)`). Popovers position via `anchor.offsetTop` and must live in the SAME scrolled coordinate space as their anchor rows — with the root as a flex column and the body scrolling, root-parented popovers would stop tracking their anchors on scroll. All anchor rows are section rows inside `body`, so anchor `offsetTop` (now relative to `body`, the nearest positioned ancestor) and popover `top` stay consistent, and `scrollIntoView({ block: 'nearest' })` scrolls the body. `.color-popover`/`.token-popover` keep `position: absolute; right: 12px` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/panel.test.ts` (match the file's existing imports/setup — it already imports `Panel`, `DraftStore`, and builds tagged elements):

```ts
describe('Docked mode structure (docked-panel spec)', () => {
  function freshPanel() {
    const drafts = new DraftStore()
    const panel = new Panel(drafts, () => {})
    document.body.appendChild(panel.root)
    return panel
  }

  it('creates footer, resize handle, and mode button with their hook classes', () => {
    const panel = freshPanel()
    expect(panel.footer.className).toBe('panel-footer')
    expect(panel.resizeHandle.className).toBe('panel-resize')
    expect(panel.modeButton.className).toBe('panel-mode')
    expect(panel.root.contains(panel.footer)).toBe(true)
    expect(panel.root.contains(panel.resizeHandle)).toBe(true)
    expect(panel.root.contains(panel.modeButton)).toBe(true)
  })

  it('body div carries the panel-body scroll-container class', () => {
    const panel = freshPanel()
    expect(panel.root.querySelector('.panel-body')).not.toBeNull()
  })

  it('setDocked(true) with no selection shows the root with the empty state', () => {
    const panel = freshPanel()
    panel.setDocked(true)
    expect(panel.root.classList.contains('docked')).toBe(true)
    expect(panel.root.hidden).toBe(false)
    const empty = panel.root.querySelector('.panel-empty') as HTMLElement
    expect(empty.hidden).toBe(false)
    expect(empty.textContent).toBe('Click an element to edit')
    expect((panel.root.querySelector('.panel-body') as HTMLElement).hidden).toBe(true)
  })

  it('show() in docked mode hides the empty state and reveals body/actions', () => {
    const panel = freshPanel()
    panel.setDocked(true)
    const el = makeTagged() // use the file's existing tagged-element helper name
    panel.show(el, buildInspectorData(el))
    expect((panel.root.querySelector('.panel-empty') as HTMLElement).hidden).toBe(true)
    expect((panel.root.querySelector('.panel-body') as HTMLElement).hidden).toBe(false)
  })

  it('hide() in docked mode returns to the empty state with "No selection" header', () => {
    const panel = freshPanel()
    panel.setDocked(true)
    const el = makeTagged()
    panel.show(el, buildInspectorData(el))
    panel.hide()
    expect(panel.root.hidden).toBe(false)
    expect((panel.root.querySelector('.panel-empty') as HTMLElement).hidden).toBe(false)
    expect(panel.root.querySelector('.panel-head-tag')!.textContent).toBe('No selection')
  })

  it('setDocked(false) with no selection hides the root (floating behavior)', () => {
    const panel = freshPanel()
    panel.setDocked(true)
    panel.setDocked(false)
    expect(panel.root.classList.contains('docked')).toBe(false)
    expect(panel.root.hidden).toBe(true)
  })

  it('popovers mount inside the panel-body scroll container, not the root', () => {
    const panel = freshPanel()
    const body = panel.root.querySelector('.panel-body') as HTMLElement
    expect(body.querySelector('.color-popover')).not.toBeNull()
    expect(body.querySelector('.token-popover')).not.toBeNull()
  })
})
```

(Adapt `makeTagged()`/`buildInspectorData` to whatever helpers `panel.test.ts` already uses for `panel.show(...)` — reuse them, do not invent new fixtures.)

Append to `tests/client/overlay.test.ts`:

```ts
describe('Dock CSS (docked-panel spec)', () => {
  it('panel width is driven by --forge-dock-w with a 320px default (resize hook)', () => {
    expect(CSS).toContain('width: var(--forge-dock-w, 320px)')
    expect(CSS).not.toContain('width: 280px')
  })
  it('panel is a flex column so the footer can pin and the body can scroll', () => {
    expect(CSS).toMatch(/#panel\s*{[^}]*display:\s*flex;\s*flex-direction:\s*column/s)
  })
  it('scrolling moved from #panel to .panel-body (popover-tracking prerequisite)', () => {
    expect(CSS).toMatch(/\.panel-body\s*{[^}]*overflow-y:\s*auto/s)
    expect(CSS).toMatch(/\.panel-body\s*{[^}]*position:\s*relative/s)
    expect(CSS).toContain('.panel-body::-webkit-scrollbar')
    expect(CSS).not.toContain('#panel::-webkit-scrollbar')
  })
  it('docked modifier pins the panel full-height right with square corners', () => {
    expect(CSS).toMatch(/#panel\.docked\s*{[^}]*top:\s*0;\s*right:\s*0;\s*bottom:\s*0/s)
    expect(CSS).toMatch(/#panel\.docked\s*{[^}]*border-radius:\s*0/s)
    expect(CSS).toMatch(/#panel\.docked\s*{[^}]*max-height:\s*none/s)
  })
  it('status strip restyles to static inside the footer', () => {
    expect(CSS).toMatch(/\.panel-footer\s+#status\s*{[^}]*position:\s*static/s)
    expect(CSS).toMatch(/\.panel-footer\s+#status\s*{[^}]*flex-wrap:\s*wrap/s)
  })
  it('Design toggle shifts left of the dock via the dock-open class', () => {
    expect(CSS).toContain('#toggle.dock-open { right: calc(16px + var(--forge-dock-w, 320px)); }')
  })
  it('resize handle spans the left edge with a col-resize cursor', () => {
    expect(CSS).toMatch(/\.panel-resize\s*{[^}]*left:\s*0;\s*top:\s*0;\s*bottom:\s*0/s)
    expect(CSS).toMatch(/\.panel-resize\s*{[^}]*cursor:\s*col-resize/s)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vite-plugin && npx vitest run tests/client/panel.test.ts tests/client/overlay.test.ts`
Expected: new describes FAIL (`panel.footer` undefined, CSS assertions unmatched); all pre-existing tests still PASS.

- [ ] **Step 3: CSS changes in `overlay.ts`**

Replace the `#panel` rule (lines 64-71) with:

```css
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: var(--forge-dock-w, 320px); max-height: 80vh;
  display: flex; flex-direction: column; overflow: hidden;
  font: 400 12px system-ui, sans-serif; background: #2C2C2C; color: #F5F5F5;
  border: 1px solid rgba(255,255,255,0.09); border-radius: 12px; padding: 0;
  box-shadow: 0 5px 24px rgba(0,0,0,0.35);
  -webkit-font-smoothing: antialiased;
}
/* Docked: full-height right sidebar; page content is pushed left by Dock's html
 * margin-right (the VisBug-style mechanism — see dock.ts). */
#panel.docked {
  top: 0; right: 0; bottom: 0; max-height: none;
  border-radius: 0; border: none; border-left: 1px solid rgba(255,255,255,0.09);
  box-shadow: none;
}
/* The scroll container is the BODY, not the root: the root is a flex column so the
 * footer pins, and popovers live inside the body (position: relative) so they keep
 * tracking their anchor rows when the sections scroll. */
.panel-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; position: relative;
}
#panel .panel-head, #panel .panel-actions { flex: none; }
.panel-empty { padding: 28px 12px; color: #9A9A9A; font: 400 11px system-ui, sans-serif; text-align: center; }
.panel-footer { flex: none; border-top: 1px solid rgba(255,255,255,0.07); padding: 8px 10px; }
.panel-footer:has(> #status[hidden]) { display: none; }
.panel-footer #status { position: static; border-radius: 8px; padding: 5px 8px; flex-wrap: wrap; }
.panel-resize {
  position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
  cursor: col-resize; z-index: 20;
}
.panel-resize:hover, .panel-resize:active { background: rgba(13,153,255,0.4); }
.panel-mode {
  position: absolute; top: 10px; right: 10px;
  width: 22px; height: 20px; padding: 0; line-height: 1;
}
#toggle.dock-open { right: calc(16px + var(--forge-dock-w, 320px)); }
```

Then:
- Change the two scrollbar rules `#panel::-webkit-scrollbar...` (lines 72-73) to `.panel-body::-webkit-scrollbar...`.
- Add `position: relative;` to the existing `#panel .panel-head` rule (line 75) — the mode button anchors to it.

- [ ] **Step 4: Panel changes in `panel.ts`**

Add public fields near `root`/`compareButton` (line ~52):

```ts
footer = document.createElement('div')
resizeHandle = document.createElement('div')
modeButton = document.createElement('button')
```

Add private fields near `head`/`body` (line ~56):

```ts
private emptyEl = document.createElement('div')
/** Dock currently active (NOT the persisted preference — Dock owns that). */
private docked = false
```

In the constructor, replace `this.root.append(this.head, this.actions, this.body)` (line 168) and the two picker constructions (lines 169-170) with:

```ts
this.body.className = 'panel-body'
this.emptyEl.className = 'panel-empty'
this.emptyEl.textContent = 'Click an element to edit'
this.emptyEl.hidden = true
this.footer.className = 'panel-footer'
this.resizeHandle.className = 'panel-resize'
this.modeButton.className = 'panel-mode'
this.modeButton.type = 'button'
this.head.append(this.modeButton)
this.root.append(this.resizeHandle, this.head, this.actions, this.emptyEl, this.body, this.footer)
// Popovers mount in the BODY (the scroll container), not the root — anchor.offsetTop
// and the popover's absolute top must share the body's scrolled coordinate space or
// the popover stops tracking its row the moment the sections scroll (see overlay.ts
// .panel-body comment).
this.colorPicker = new ColorPicker(this.body)
this.tokenPicker = new TokenPicker(this.body)
```

Add after `hide()`:

```ts
/**
 * Dock-active flag (set by Dock, not persisted here). Docked changes what "no
 * selection" looks like: the root stays visible with an empty-state hint instead of
 * hiding, so the dock never collapses mid-session. Re-runs hide() when nothing is
 * selected so the visibility rules of the NEW mode apply immediately.
 */
setDocked(on: boolean): void {
  this.docked = on
  this.root.classList.toggle('docked', on)
  if (!this.el) this.hide()
}
```

Replace `hide()` (lines 218-224) with:

```ts
hide(): void {
  this.el = null
  this.els = []
  this.colorPicker.close()
  this.tokenPicker.close()
  if (this.docked) {
    // Docked empty state: root stays visible (the dock holds its space), header says
    // why the controls are gone, footer (status strip) remains usable.
    this.root.hidden = false
    this.headTag.textContent = 'No selection'
    this.headSrc.remove()
    this.actions.hidden = true
    this.body.hidden = true
    this.emptyEl.hidden = false
  } else {
    this.root.hidden = true
  }
}
```

In `show()`, after `this.root.hidden = false` (line 196), add:

```ts
this.actions.hidden = false
this.body.hidden = false
this.emptyEl.hidden = true
```

- [ ] **Step 5: Run the full client suite**

Run: `cd packages/vite-plugin && npx vitest run tests/client/`
Expected: new tests PASS. If any pre-existing test fails on child order (e.g. it assumed `root.children[0]` is the head), update that test to query by class instead — do NOT reorder the new structure.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck -w @the-forge/vite`
Expected: clean.

```bash
git add packages/vite-plugin/src/client/panel.ts packages/vite-plugin/src/client/overlay.ts packages/vite-plugin/tests/client/panel.test.ts packages/vite-plugin/tests/client/overlay.test.ts
git commit -m "Panel: flex-column structure with panel-body scroll, footer, empty state, resize handle, mode button"
```

---

### Task 3: Dock class — enter/exit, html margin, re-parenting, resize drag

**Files:**
- Modify: `packages/vite-plugin/src/client/dock.ts` (append `Dock` class)
- Modify: `packages/vite-plugin/src/client/overlay.ts` (make `status` public: change `private status = document.createElement('div')` to `status = document.createElement('div')`)
- Test: `packages/vite-plugin/tests/client/dock.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's prefs functions; Task 2's `Panel.footer/resizeHandle/modeButton/setDocked`.
- Produces (Task 4 relies on):
  - `class Dock { constructor(host: HTMLElement, panel: Panel, status: HTMLElement, toggle: HTMLElement); enter(): void; exit(): void; setMode(mode: PanelMode): void; mode(): PanelMode; width(): number }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/dock.test.ts`:

```ts
import { Dock } from '../../src/client/dock'
import { Overlay } from '../../src/client/overlay'
import { Panel } from '../../src/client/panel'
import { DraftStore } from '../../src/client/drafts'

function dockSetup() {
  const overlay = new Overlay()
  overlay.mount()
  const panel = new Panel(new DraftStore(), () => {})
  overlay.attachPanel(panel.root)
  const dock = new Dock(overlay.host, panel, overlay.status, overlay.toggle)
  return { overlay, panel, dock }
}

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.style.marginRight = ''
})

describe('Dock enter/exit', () => {
  it('constructor seeds --forge-dock-w from prefs without touching the page', () => {
    const { overlay } = dockSetup()
    expect(overlay.host.style.getPropertyValue('--forge-dock-w')).toBe('320px')
    expect(document.documentElement.style.marginRight).toBe('')
  })

  it('enter() in docked mode pushes content, re-parents status, offsets toggle', () => {
    const { overlay, panel, dock } = dockSetup()
    dock.enter()
    expect(document.documentElement.style.marginRight).toBe('320px')
    expect(panel.root.classList.contains('docked')).toBe(true)
    expect(panel.footer.contains(overlay.status)).toBe(true)
    expect(overlay.toggle.classList.contains('dock-open')).toBe(true)
  })

  it('exit() restores everything, including a pre-existing inline html margin verbatim', () => {
    document.documentElement.style.marginRight = '7px'
    const { overlay, panel, dock } = dockSetup()
    dock.enter()
    expect(document.documentElement.style.marginRight).toBe('320px')
    dock.exit()
    expect(document.documentElement.style.marginRight).toBe('7px')
    expect(panel.root.classList.contains('docked')).toBe(false)
    expect(panel.footer.contains(overlay.status)).toBe(false)
    expect(overlay.host.shadowRoot!.contains(overlay.status)).toBe(true)
    expect(overlay.toggle.classList.contains('dock-open')).toBe(false)
  })

  it('enter() in floating mode leaves the page margin alone', () => {
    savePrefs({ width: 320, mode: 'floating' })
    const { dock } = dockSetup()
    dock.enter()
    expect(document.documentElement.style.marginRight).toBe('')
    dock.exit()
  })
})

describe('Dock mode switching', () => {
  it('setMode("floating") while active un-docks live and persists; setMode("docked") re-docks', () => {
    const { panel, dock } = dockSetup()
    dock.enter()
    dock.setMode('floating')
    expect(document.documentElement.style.marginRight).toBe('')
    expect(panel.root.classList.contains('docked')).toBe(false)
    expect(loadPrefs().mode).toBe('floating')
    dock.setMode('docked')
    expect(document.documentElement.style.marginRight).toBe('320px')
    expect(loadPrefs().mode).toBe('docked')
    dock.exit()
  })

  it('mode button click toggles the mode', () => {
    const { panel, dock } = dockSetup()
    dock.enter()
    panel.modeButton.dispatchEvent(new MouseEvent('click'))
    expect(dock.mode()).toBe('floating')
    panel.modeButton.dispatchEvent(new MouseEvent('click'))
    expect(dock.mode()).toBe('docked')
    dock.exit()
  })

  it('setMode while inactive only persists — no page mutation until enter()', () => {
    const { dock } = dockSetup()
    dock.setMode('floating')
    expect(document.documentElement.style.marginRight).toBe('')
    expect(loadPrefs().mode).toBe('floating')
  })
})

describe('Dock resize drag', () => {
  function drag(panel: Panel, fromX: number, toX: number) {
    panel.resizeHandle.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: fromX, bubbles: true, cancelable: true })
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: toX }))
    window.dispatchEvent(new MouseEvent('pointerup', {}))
  }

  it('dragging left widens the panel and the html margin follows', () => {
    const { overlay, panel, dock } = dockSetup()
    dock.enter()
    drag(panel, 700, 620) // 80px left => width 400
    expect(overlay.host.style.getPropertyValue('--forge-dock-w')).toBe('400px')
    expect(document.documentElement.style.marginRight).toBe('400px')
    expect(dock.width()).toBe(400)
    dock.exit()
  })

  it('drag result is clamped to MIN_WIDTH and persisted on pointerup', () => {
    const { dock, panel } = dockSetup()
    dock.enter()
    drag(panel, 700, 900) // 200px right => would be 120, clamps to 280
    expect(dock.width()).toBe(MIN_WIDTH)
    expect(loadPrefs().width).toBe(MIN_WIDTH)
    dock.exit()
  })

  it('drag listeners detach on pointerup (no leaked window listeners)', () => {
    const { dock, panel } = dockSetup()
    dock.enter()
    drag(panel, 700, 620)
    const w = dock.width()
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100 }))
    expect(dock.width()).toBe(w)
    dock.exit()
  })
})
```

(jsdom note: dispatch `MouseEvent` with type `'pointerdown'` etc. — jsdom lacks a `PointerEvent` constructor; the handler only reads `clientX`, so no pointer capture APIs are used anywhere.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vite-plugin && npx vitest run tests/client/dock.test.ts`
Expected: FAIL — `Dock` not exported; also `overlay.status` is private (typecheck error) until Step 3.

- [ ] **Step 3: Implement**

In `overlay.ts` change line 290 `private status = document.createElement('div')` → `status = document.createElement('div')`.

Append to `src/client/dock.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vite-plugin && npx vitest run tests/client/dock.test.ts tests/client/overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w @the-forge/vite`
Expected: clean.

```bash
git add packages/vite-plugin/src/client/dock.ts packages/vite-plugin/src/client/overlay.ts packages/vite-plugin/tests/client/dock.test.ts
git commit -m "Dock class: html-margin push, status re-parenting, resize drag, mode toggle"
```

---

### Task 4: Wire Dock into DesignMode

**Files:**
- Modify: `packages/vite-plugin/src/client/index.ts` (constructor ~67-79, `setActive` ~177-216)
- Test: `packages/vite-plugin/tests/client/design-mode.test.ts`

**Interfaces:**
- Consumes: `Dock` from Task 3.
- Produces: `DesignMode` constructor gains an optional 4th param `dock?: Dock`; when omitted, DesignMode constructs its own (production path). `setActive(true)` calls `dock.enter()`; `setActive(false)` calls `dock.exit()`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/design-mode.test.ts` (reuse its existing `fullSetup()`; add `localStorage.clear()` to the file's `beforeEach` and `document.documentElement.style.marginRight = ''` to `afterEach` so dock prefs/margins don't bleed between tests):

```ts
describe('Dock integration (docked-panel spec)', () => {
  it('activating design mode docks by default: html margin set, panel visible with empty state', () => {
    const { mode, panel } = fullSetup()
    mode.setActive(true)
    expect(document.documentElement.style.marginRight).toBe('320px')
    expect(panel.root.hidden).toBe(false)
    expect((panel.root.querySelector('.panel-empty') as HTMLElement).hidden).toBe(false)
  })

  it('deactivating restores the html margin and hides the panel', () => {
    const { mode, panel } = fullSetup()
    mode.setActive(true)
    mode.setActive(false)
    expect(document.documentElement.style.marginRight).toBe('')
    expect(panel.root.hidden).toBe(true)
  })

  it('Escape-out (deselect then deactivate) also restores the margin — single setActive(false) path', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) // no selection -> deactivates
    expect(mode.active).toBe(false)
    expect(document.documentElement.style.marginRight).toBe('')
  })

  it('adds no document-level listeners while inactive (idle-zero preserved with Dock constructed)', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const overlay = new Overlay()
    overlay.mount()
    new DesignMode(overlay)
    expect(addSpy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vite-plugin && npx vitest run tests/client/design-mode.test.ts`
Expected: new describe FAILS (no margin set).

- [ ] **Step 3: Implement**

In `src/client/index.ts`:

```ts
import { Dock } from './dock'
```

Constructor — add the optional param and construct the fallback AFTER `this.panel` is assigned:

```ts
constructor(
  private overlay: Overlay,
  panel?: Panel,
  drafts?: DraftStore,
  dock?: Dock
) {
  // ...existing drafts/panel/verifier setup unchanged...
  this.dock = dock ?? new Dock(overlay.host, this.panel, overlay.status, overlay.toggle)
  // ...existing listener wiring unchanged...
}
```

with a private field alongside the others:

```ts
private dock: Dock
```

In `setActive(on)`, `if (on)` branch — add `this.dock.enter()` immediately after `this.overlay.setActive(on)`. In the `else` branch — add `this.dock.exit()` immediately after `this.panel.hide()` (exit → `panel.setDocked(false)` → re-runs `hide()`, which now hides the root; order is deliberate so the panel ends hidden).

`boot()` needs no change — DesignMode builds its own Dock.

- [ ] **Step 4: Run the design-mode suite and repair behavior-change fallout**

Run: `cd packages/vite-plugin && npx vitest run tests/client/design-mode.test.ts`

Docked-by-default changes one observable behavior: after `setActive(true)`, deselecting no longer hides the panel root (it shows the empty state). For each pre-existing failure, apply exactly this rule: if the test asserted `panel.root.hidden === true` while design mode was still ACTIVE (post-deselect / post-Escape-with-selection), update it to assert the empty state instead (`panel.root.hidden === false` and `.panel-empty` visible); if it asserted hidden after `setActive(false)`, it must still pass unchanged — that would be a real bug. Do not touch the idle-listener tests.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `cd packages/vite-plugin && npx vitest run && npm run typecheck -w @the-forge/vite` (from repo root for the workspace flag)
Expected: all green.

```bash
git add packages/vite-plugin/src/client/index.ts packages/vite-plugin/tests/client/design-mode.test.ts
git commit -m "DesignMode: dock enter/exit wired into setActive — docked by default"
```

---

### Task 5: Text-cutoff fixes (seg ellipsis+title, pill ellipsis, source-path tail preservation)

**Files:**
- Modify: `packages/vite-plugin/src/client/overlay.ts` (CSS: `.seg`, `.nf-pill input`, `.panel-head-src`)
- Modify: `packages/vite-plugin/src/client/layout-controls.ts` (SegmentField button `title`)
- Modify: `packages/vite-plugin/src/client/panel.ts` (`show()` source-path spans, ~lines 202-209)
- Test: `packages/vite-plugin/tests/client/layout-controls.test.ts`, `tests/client/panel.test.ts`, `tests/client/overlay.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's structure (nothing else).
- Produces: `.src-dir` / `.src-tail` spans inside `.panel-head-src` (E2E in Task 6 checks them).

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/layout-controls.test.ts`:

```ts
it('every segment button carries a title so clipped labels are still discoverable', () => {
  const field = new SegmentField({
    label: 'Justify',
    options: [{ value: 'space-between', label: 'Space between' }],
    onInput: () => {},
  })
  const btn = field.root.querySelector('.seg') as HTMLElement
  expect(btn.title).toBe('Space between')
})
```

Append to `tests/client/panel.test.ts` (inside the docked describe or its own):

```ts
it('source path renders as dir + tail spans so the filename:line never gets cut', () => {
  const panel = freshPanel()
  const el = makeTagged() // helper must yield data.source = { file: 'src/components/Button.tsx', line: 42, col: 8 } or similar
  panel.show(el, buildInspectorData(el))
  const src = panel.root.querySelector('.panel-head-src') as HTMLElement
  const dir = src.querySelector('.src-dir') as HTMLElement
  const tail = src.querySelector('.src-tail') as HTMLElement
  expect(dir.textContent).toBe('src/components/')
  expect(tail.textContent).toBe('Button.tsx:42:8')
  expect(src.textContent).toBe('src/components/Button.tsx:42:8') // concatenation unchanged
  expect(src.title).toBe('src/components/Button.tsx:42:8')
})
```

Append to the overlay CSS describe:

```ts
it('seg labels ellipsize instead of hard-clipping', () => {
  expect(CSS).toMatch(/\.seg\s*{[^}]*text-overflow:\s*ellipsis/s)
})
it('token pills ellipsize instead of hard-clipping', () => {
  expect(CSS).toMatch(/\.nf-pill input\s*{[^}]*text-overflow:\s*ellipsis/s)
})
it('head-src is a flex row: dir ellipsizes, tail never shrinks', () => {
  expect(CSS).toMatch(/\.panel-head-src\s*{[^}]*display:\s*flex/s)
  expect(CSS).toMatch(/\.src-dir\s*{[^}]*text-overflow:\s*ellipsis/s)
  expect(CSS).toMatch(/\.src-tail\s*{[^}]*flex:\s*none/s)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vite-plugin && npx vitest run tests/client/layout-controls.test.ts tests/client/panel.test.ts tests/client/overlay.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

`layout-controls.ts` — in the SegmentField option loop (line ~29), after `button.textContent = option.label` add:

```ts
// .seg hard-clips overflow (overflow: hidden; nowrap) — the title is the escape hatch
// for any label that still doesn't fit at the current panel width.
button.title = option.label
```

`overlay.ts` CSS:
- `.seg` rule (line ~140): add `text-overflow: ellipsis;` after `overflow: hidden;`.
- `.nf-pill input` rule (line ~120): add `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`.
- Replace the `.panel-head-src` rule with:

```css
/* Dir + tail spans: the DIRECTORY ellipsizes while the filename:line:col tail keeps
 * flex: none — the useful part of a source path is its end, which plain end-ellipsis
 * used to cut first. (Chosen over a direction:rtl clip trick, which mangles
 * punctuation, and over JS width-measuring truncation, which needs re-running on
 * every resize.) */
#panel .panel-head-src {
  font: 400 10px ui-monospace, monospace; color: #9A9A9A; margin-top: 2px;
  display: flex; min-width: 0;
}
#panel .panel-head-src .src-dir { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; }
#panel .panel-head-src .src-tail { white-space: nowrap; flex: none; }
```

`panel.ts` `show()` — replace the single-select source block (lines 202-206):

```ts
if (data.source) {
  const srcText = `${data.source.file}:${data.source.line}:${data.source.col}`
  const slash = data.source.file.lastIndexOf('/')
  const dirSpan = document.createElement('span')
  dirSpan.className = 'src-dir'
  dirSpan.textContent = slash === -1 ? '' : data.source.file.slice(0, slash + 1)
  const tailSpan = document.createElement('span')
  tailSpan.className = 'src-tail'
  tailSpan.textContent = `${slash === -1 ? data.source.file : data.source.file.slice(slash + 1)}:${data.source.line}:${data.source.col}`
  this.headSrc.replaceChildren(dirSpan, tailSpan)
  this.headSrc.title = srcText
  if (!this.headSrc.isConnected) this.head.append(this.headSrc)
} else {
  this.headSrc.remove()
}
```

- [ ] **Step 4: Run the full client suite**

Run: `cd packages/vite-plugin && npx vitest run tests/client/`
Expected: PASS. (A pre-existing test asserting `headSrc.textContent === srcText` still passes — span concatenation preserves it.)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck -w @the-forge/vite
git add packages/vite-plugin/src/client/overlay.ts packages/vite-plugin/src/client/layout-controls.ts packages/vite-plugin/src/client/panel.ts packages/vite-plugin/tests/client/
git commit -m "Text-cutoff fixes: seg/pill ellipsis + titles, source path keeps filename:line visible"
```

---

### Task 6: Real-browser E2E + clipping audit + full gate

**Files:**
- Modify: whatever the audit turns up (expect small CSS additions in `overlay.ts`)
- No new test files — this is the mandatory real-browser pass (jsdom cannot see layout).

**Interfaces:** consumes everything above; produces the merge-readiness evidence.

- [ ] **Step 1: Build and start the demo app**

```bash
npm run build            # rebuild dist/ so the demo serves the new client bundle
lsof -iTCP:5173          # gotcha: kill any stale dev server first (often binds [::1])
npm run dev -w demo-app
```

- [ ] **Step 2: Dock behavior E2E (Playwright/browser MCP against http://localhost:5173)**

Verify, in order:
1. Click the `Design` toggle (in the shadow root). Assert `document.documentElement.style.marginRight === '320px'`, the panel is a full-height right dock, page content is NOT overlapped (no horizontal scrollbar: `document.documentElement.scrollWidth <= window.innerWidth`), and the toggle button sits left of the dock.
2. Click a demo element → sections render; deselect (click empty space / Escape) → empty state "Click an element to edit", dock still open.
3. Drag the left edge (mousedown on `.panel-resize`, move ±100px, mouseup) → dock and margin resize live; reload the page, re-enter design mode → width persisted.
4. Click the mode button → panel floats (old behavior), margin gone, status strip returns to bottom-right; click again → docks again.
5. Toggle design mode off → margin restored exactly, no layout residue.
6. Open a color popover and the `=` token picker in the dock, scroll the sections → popovers track their anchor rows (this exercises the `.panel-body` re-parenting).

- [ ] **Step 3: Clipping audit at minimum width**

Drag the dock to its 280px minimum, select a flex container in the demo app (Layout + flex-child sections visible), expand all sections, then run in the browser console:

```js
const host = [...document.body.children].find((el) => el.shadowRoot)
const clipped = [...host.shadowRoot.querySelectorAll('#panel *')]
  .filter((el) => el.scrollWidth > el.clientWidth + 1)
  .map((el) => `${el.className || el.tagName}: "${(el.textContent ?? '').slice(0, 40)}"`)
console.log(clipped)
```

Repeat with a text element selected (Typography section) and with multi-select (Selection colors). For every hit that is NOT an intentional ellipsis (`.src-dir`, `.seg`, `.nf-pill input`), fix it in `overlay.ts` following the existing precedents — label-above-track stacking (`[data-align-self]` pattern), a shorter label, or ellipsis+title — and add a CSS assertion test mirroring the `[data-text-align]` test in `overlay.test.ts`.

- [ ] **Step 4: Full gate**

```bash
npm test                        # root gate: typecheck + full vitest suite
./scripts/check-prod-clean.sh   # zero prod traces + 250KB budget
```

Expected: all green.

- [ ] **Step 5: Commit audit fixes**

```bash
git add packages/vite-plugin/src/client/overlay.ts packages/vite-plugin/tests/client/overlay.test.ts
git commit -m "E2E clipping audit fixes at 280px minimum width"
```

---

## Self-review notes

- **Spec coverage:** dock-while-active (T4), push-content mechanism + verbatim margin restore (T3), resize + clamps + persistence (T1/T3), dock/float toggle + persisted mode (T3), status strip → footer + toggle offset (T2/T3), empty state (T2), text-cutoff fixes incl. JS-built tail-preserving source path (T5), real-browser audit + E2E (T6), corrupt-localStorage fallback (T1), popover positioning risk (T2 why-comment + T6 step 2.6). Deviation from spec noted: the source path uses dir/tail spans with CSS ellipsis rather than width-measuring JS middle-truncation — same guarantee (tail never cut), no resize re-measuring; the spans are still built in JS.
- **Type consistency:** `PanelMode`/`PanelPrefs`/`clampWidth`/`loadPrefs`/`savePrefs` (T1) match T3's usage; `footer`/`resizeHandle`/`modeButton`/`setDocked` (T2) match T3/T4; `Dock.enter/exit/setMode/mode/width` (T3) match T4.

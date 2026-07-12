// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  clampWidth,
  loadPrefs,
  savePrefs,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH,
  STORAGE_KEY,
  Dock,
} from '../../src/client/dock'
import { Overlay } from '../../src/client/overlay'
import { Panel } from '../../src/client/panel'
import { DraftStore } from '../../src/client/drafts'
import { DUR_PANEL_MS } from '../../src/client/motion'

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

function dockSetup() {
  const overlay = new Overlay()
  overlay.mount()
  const panel = new Panel(new DraftStore(), () => {})
  overlay.attach(panel.root)
  const dock = new Dock(overlay.host, panel, overlay.status, overlay.toggle)
  return { overlay, panel, dock }
}

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.style.marginRight = ''
  // Flush any in-flight armMarginTransition cleanup deterministically — jsdom never fires
  // transitionend on its own, and removeDocked()'s arm otherwise leaves a live real timer
  // + listener dangling past the test (Task 8 review). jsdom has no TransitionEvent
  // constructor — the Object.assign shape is the idiom; the cleanup handler only reads
  // e.propertyName.
  document.documentElement.dispatchEvent(
    Object.assign(new Event('transitionend'), { propertyName: 'margin-right' })
  )
  // Belt-and-braces: reset the style so a stale value can never leak into the next test's
  // `prev` read even if a future arm shape escapes the flush above.
  document.documentElement.style.transition = ''
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
    dock.exit() // pairs with enter() so its armMarginTransition cleanup chain runs synchronously
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

describe('Dock polish (PR #2 follow-ups)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a transient window shrink re-clamps the APPLIED width but never overwrites the stored width', () => {
    vi.stubGlobal('innerWidth', 1280)
    savePrefs({ width: 560, mode: 'docked' })
    const { overlay, dock } = dockSetup()
    dock.enter()
    expect(document.documentElement.style.marginRight).toBe('560px')
    vi.stubGlobal('innerWidth', 800) // 50vw cap -> 400
    window.dispatchEvent(new Event('resize'))
    expect(overlay.host.style.getPropertyValue('--forge-dock-w')).toBe('400px')
    expect(document.documentElement.style.marginRight).toBe('400px')
    // Storage still holds the user's DESIRED width — a transient shrink must not destroy it.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).width).toBe(560)
    vi.stubGlobal('innerWidth', 1280)
    window.dispatchEvent(new Event('resize'))
    expect(overlay.host.style.getPropertyValue('--forge-dock-w')).toBe('560px')
    expect(document.documentElement.style.marginRight).toBe('560px')
    dock.exit()
  })

  it('non-primary-button pointerdown does not start a resize', () => {
    const { dock, panel } = dockSetup()
    dock.enter()
    panel.resizeHandle.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 700, button: 2, bubbles: true, cancelable: true })
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600 }))
    expect(dock.width()).toBe(DEFAULT_WIDTH)
    dock.exit()
  })

  it('pointercancel tears the drag down like pointerup — no live pointermove listener left behind', () => {
    const { dock, panel } = dockSetup()
    dock.enter()
    panel.resizeHandle.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 700, button: 0, bubbles: true, cancelable: true })
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 660 }))
    expect(dock.width()).toBe(360)
    window.dispatchEvent(new MouseEvent('pointercancel', {}))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }))
    expect(dock.width()).toBe(360)
    dock.exit()
  })

  it('exit() while floating does not re-append #status (only undoes what applyDocked applied)', () => {
    savePrefs({ width: 320, mode: 'floating' })
    const { overlay, dock } = dockSetup()
    // dockSetup's attach() appended the panel root AFTER #status — if exit() re-appends the
    // status, it would become the shadow root's last child. It must not move.
    expect(overlay.host.shadowRoot!.lastElementChild).not.toBe(overlay.status)
    dock.enter()
    dock.exit()
    expect(overlay.host.shadowRoot!.lastElementChild).not.toBe(overlay.status)
  })

  it('loadPrefs clamps the DEFAULT fallback against the viewport too (Bugbot: narrow first run)', () => {
    vi.stubGlobal('innerWidth', 400) // 50vw = 200 < MIN -> MIN wins
    expect(loadPrefs().width).toBe(MIN_WIDTH)
    localStorage.setItem(STORAGE_KEY, '{corrupt')
    expect(loadPrefs().width).toBe(MIN_WIDTH)
  })
})

describe('Dock canvas mode', () => {
  it('setCanvasActive(true) writes the page original margin back while docked; false repaints the push', () => {
    document.documentElement.style.marginRight = '7px' // page's own inline margin
    const { dock } = dockSetup()
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
    const { dock } = dockSetup()
    dock.enter()
    dock.setCanvasActive(true)
    dock.exit()
    expect(document.documentElement.style.marginRight).toBe('')
  })

  it('exit() clears canvasActive — the next enter() pushes the margin, not a stale suspension (2026-07-11 review)', () => {
    document.documentElement.style.marginRight = ''
    const { dock } = dockSetup()
    dock.enter()
    dock.setCanvasActive(true) // suspends the margin push while canvas mode owns the page
    dock.exit() // must not leave canvasActive true for the next enter()
    dock.enter()
    expect(document.documentElement.style.marginRight).toBe(`${dock.width()}px`)
    dock.exit()
  })
})

describe('Dock margin-push motion (Task 8)', () => {
  it('dock/undock animates the html margin push and cleans the transition up', () => {
    vi.useFakeTimers()
    const { dock } = dockSetup()
    dock.enter() // docked mode → applyDocked
    expect(document.documentElement.style.transition).toContain('margin-right')
    vi.advanceTimersByTime(DUR_PANEL_MS + 100)
    expect(document.documentElement.style.transition).toBe('')
    dock.exit()
    vi.useRealTimers()
  })

  it('margin push transition restores a pre-existing inline transition verbatim', () => {
    vi.useFakeTimers()
    document.documentElement.style.transition = 'color 1s'
    const { dock } = dockSetup()
    dock.enter()
    vi.advanceTimersByTime(DUR_PANEL_MS + 100)
    expect(document.documentElement.style.transition).toBe('color 1s')
    document.documentElement.style.transition = ''
    dock.exit()
    vi.useRealTimers()
  })

  it('width drag kills an in-flight margin transition immediately', () => {
    vi.useFakeTimers()
    const { dock, panel } = dockSetup()
    dock.enter()
    expect(document.documentElement.style.transition).toContain('margin-right')
    // jsdom has no PointerEvent constructor — dispatch the way the suite's existing
    // resize-drag tests already do (MouseEvent with type 'pointerdown' carries button/clientX
    // fine, since onResizeStart only reads those two fields).
    panel.resizeHandle.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100 }))
    expect(document.documentElement.style.transition).toBe('')
    window.dispatchEvent(new MouseEvent('pointerup', {}))
    dock.exit()
    vi.useRealTimers()
  })

  it('no margin transition under reduced motion', () => {
    const spy = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const { dock } = dockSetup()
    dock.enter()
    expect(document.documentElement.style.transition).toBe('')
    dock.exit()
    spy.mockRestore()
  })

  // transitionend BUBBLES — a page element finishing its own margin-right transition
  // must not be mistaken for the dock's own (final-review Finding 1).
  it('a bubbled transitionend from a child element does not kill the margin transition early', () => {
    vi.useFakeTimers()
    const { dock } = dockSetup()
    dock.enter()
    expect(document.documentElement.style.transition).toContain('margin-right')
    const child = document.createElement('div')
    document.body.appendChild(child)
    child.dispatchEvent(
      Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'margin-right' })
    )
    // still armed — a bubbled event from an unrelated descendant must not cancel the tween
    expect(document.documentElement.style.transition).toContain('margin-right')
    document.documentElement.dispatchEvent(
      Object.assign(new Event('transitionend'), { propertyName: 'margin-right' })
    )
    expect(document.documentElement.style.transition).toBe('')
    dock.exit()
    vi.useRealTimers()
  })
})

describe('Dock canvas-toggle margin clear (final-review Finding 3)', () => {
  it('setCanvasActive clears an in-flight armed margin transition instantly', () => {
    vi.useFakeTimers()
    const { dock } = dockSetup()
    dock.enter()
    expect(document.documentElement.style.transition).toContain('margin-right')
    dock.setCanvasActive(true)
    expect(document.documentElement.style.transition).toBe('')
    dock.setCanvasActive(false)
    dock.exit()
    vi.useRealTimers()
  })
})

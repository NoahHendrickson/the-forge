// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

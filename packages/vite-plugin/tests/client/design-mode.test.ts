// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Overlay } from '../../src/client/overlay'
import { DesignMode } from '../../src/client/index'
import { DraftStore } from '../../src/client/drafts'
import { Panel } from '../../src/client/panel'

// DesignMode registers capture-phase listeners on `document`/`window`, which
// persist across tests within this file (jsdom's `document` is shared per
// test file, not per test). Track every instance created via setActive so
// afterEach can deactivate it and avoid leaking listeners into later tests.
const liveModes: DesignMode[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
})

afterEach(() => {
  for (const mode of liveModes.splice(0)) mode.setActive(false)
})

function fullSetup() {
  document.body.innerHTML = `<button data-dc-source="src/Button.tsx:42:8" class="btn">go</button>`
  const overlay = new Overlay()
  overlay.mount()
  const drafts = new DraftStore()
  const panel = new Panel(drafts, () => {})
  overlay.attachPanel(panel.root)
  const mode = new DesignMode(overlay, panel, drafts)
  liveModes.push(mode)
  return { overlay, drafts, panel, mode }
}

describe('DesignMode listener lifecycle (spec §10: zero idle listeners)', () => {
  it('adds no document listeners until activated', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const overlay = new Overlay()
    overlay.mount()
    new DesignMode(overlay)
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('adds capture-phase listeners on activate and removes them on deactivate', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const winAddSpy = vi.spyOn(window, 'addEventListener')
    const winRemoveSpy = vi.spyOn(window, 'removeEventListener')
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)

    mode.setActive(true)
    const added = [...addSpy.mock.calls.map((c) => c[0]), ...winAddSpy.mock.calls.map((c) => c[0])].sort()
    expect(added).toEqual(['click', 'keydown', 'mousemove', 'resize', 'scroll'])
    for (const call of addSpy.mock.calls) {
      if (call[0] === 'scroll') expect(call[2]).toEqual({ capture: true, passive: true })
      else expect(call[2]).toBe(true)
    }
    for (const call of winAddSpy.mock.calls) expect(call[2]).toEqual({ passive: true })

    mode.setActive(false)
    const removed = [...removeSpy.mock.calls.map((c) => c[0]), ...winRemoveSpy.mock.calls.map((c) => c[0])].sort()
    expect(removed).toEqual(['click', 'keydown', 'mousemove', 'resize', 'scroll'])
  })

  it('toggle button flips design mode', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.toggle.click()
    expect(mode.active).toBe(true)
    overlay.toggle.click()
    expect(mode.active).toBe(false)
  })

  it('Escape deactivates', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mode.active).toBe(false)
  })

  it('uses the latest mousemove target when events arrive between frames', () => {
    document.body.innerHTML = `<div data-dc-source="src/a.tsx:1:1" id="first"></div><div data-dc-source="src/b.tsx:2:2" id="second"></div>`
    let queued: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued = cb
      return 1
    })
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const first = document.getElementById('first')!
    const second = document.getElementById('second')!
    const firstRect = vi.spyOn(first, 'getBoundingClientRect')
    const secondRect = vi.spyOn(second, 'getBoundingClientRect')

    first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    queued!(0)

    expect(secondRect).toHaveBeenCalled()
    expect(firstRect).not.toHaveBeenCalled()
  })
})

describe('DesignMode selection (M2)', () => {
  it('click selects: retained element, persistent outline, editable panel', () => {
    const { overlay, mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    const appHandler = vi.fn()
    btn.addEventListener('click', appHandler)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(appHandler).not.toHaveBeenCalled()
    expect(mode.selected).toBe(btn)
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(false)
    expect((root.getElementById('panel') as HTMLElement).hidden).toBe(false)
    expect(root.getElementById('panel')!.textContent).toContain('src/Button.tsx:42:8')
  })

  it('clicking an untagged area deselects', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(mode.selected).toBeNull()
  })

  it('Escape deselects first, exits on second press, and stops propagation', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const appEsc = vi.fn()
    // Design mode's Escape listener is on `document` in the capture phase, so it
    // runs during the capture descent toward any deeper target — including
    // document.body. Dispatching on document.body (bubbling) puts body genuinely
    // in the propagation path, so stopPropagation() during capture can actually
    // be observed preventing the bubble-phase listener below from firing.
    document.body.addEventListener('keydown', appEsc)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.selected).toBeNull()
    expect(mode.active).toBe(true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.active).toBe(false)
    expect(appEsc).not.toHaveBeenCalled()
  })

  it('drafts survive deactivation but chrome hides', () => {
    const { mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '20px')
    mode.setActive(false)
    expect(btn.style.getPropertyValue('padding-top')).toBe('20px')
  })

  it('exiting design mode while comparing restores draft previews', () => {
    const { mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '20px')
    drafts.compareAll(true)
    expect(btn.style.getPropertyValue('padding-top')).toBe('')
    mode.setActive(false)
    expect(btn.style.getPropertyValue('padding-top')).toBe('20px')
  })

  it('draft changes drive the status strip and compare-all button', () => {
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'width', '100px')
    const status = overlay.host.shadowRoot!.getElementById('status') as HTMLElement
    expect(status.hidden).toBe(false)
    overlay.compareAllButton.click()
    expect(drafts.isComparingAll()).toBe(true)
    overlay.resetAllButton.click()
    expect(drafts.elementCount()).toBe(0)
    expect(status.hidden).toBe(true)
  })

  it('scroll re-measures the selection even when a hover frame is queued', () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const { overlay, mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new Event('scroll'))
    expect(queue.length).toBe(2) // hover + reflow queued independently (shared-id code dropped the reflow)
    const spy = vi.spyOn(overlay, 'showSelectOutline')
    for (const cb of queue.splice(0)) cb(0)
    expect(spy).toHaveBeenCalled() // the previously-dropped re-measure

    // hover redraws on the next mousemove after a scroll
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    for (const cb of queue.splice(0)) cb(0)
    const outline = overlay.host.shadowRoot!.getElementById('outline') as HTMLElement
    expect(outline.hidden).toBe(true) // hovering the SELECTED element → hover outline stays suppressed
  })
})

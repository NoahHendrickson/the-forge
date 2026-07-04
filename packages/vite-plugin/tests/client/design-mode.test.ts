// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Overlay } from '../../src/client/overlay'
import { DesignMode } from '../../src/client/index'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
})

describe('Overlay', () => {
  it('mounts a shadow-DOM host with toggle, outline, and panel', () => {
    const overlay = new Overlay()
    overlay.mount()
    expect(document.body.contains(overlay.host)).toBe(true)
    const root = overlay.host.shadowRoot!
    expect(root.getElementById('toggle')).toBeTruthy()
    expect(root.getElementById('outline')).toBeTruthy()
    expect(root.getElementById('panel')).toBeTruthy()
  })

  it('hides outline and panel when deactivated', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showOutline(new DOMRect(0, 0, 10, 10))
    overlay.setActive(false)
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('outline') as HTMLElement).hidden).toBe(true)
    expect((root.getElementById('panel') as HTMLElement).hidden).toBe(true)
  })
})

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
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)

    mode.setActive(true)
    const added = addSpy.mock.calls.map((c) => c[0]).sort()
    expect(added).toEqual(['click', 'keydown', 'mousemove'])
    for (const call of addSpy.mock.calls) expect(call[2]).toBe(true)

    mode.setActive(false)
    const removed = removeSpy.mock.calls.map((c) => c[0]).sort()
    expect(removed).toEqual(['click', 'keydown', 'mousemove'])
  })

  it('toggle button flips design mode', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.toggle.click()
    expect(mode.active).toBe(true)
    overlay.toggle.click()
    expect(mode.active).toBe(false)
  })

  it('Escape deactivates', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    mode.setActive(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mode.active).toBe(false)
  })

  it('click selects the nearest tagged element and prevents the app click', () => {
    document.body.innerHTML = `<button data-dc-source="src/Button.tsx:42:8" class="btn">go</button>`
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    mode.setActive(true)

    const btn = document.querySelector('button')!
    const appHandler = vi.fn()
    btn.addEventListener('click', appHandler)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(appHandler).not.toHaveBeenCalled()
    const panel = overlay.host.shadowRoot!.getElementById('panel') as HTMLElement
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('src/Button.tsx:42:8')
    expect(panel.textContent).toContain('btn')
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Overlay } from '../../src/client/overlay'
import { DesignMode } from '../../src/client/index'
import { DraftStore } from '../../src/client/drafts'
import { Panel } from '../../src/client/panel'
import { readTokens, resetTokensCache } from '../../src/client/tokens'
import * as tokensModule from '../../src/client/tokens'

// DesignMode registers capture-phase listeners on `document`/`window`, which
// persist across tests within this file (jsdom's `document` is shared per
// test file, not per test). Track every instance created via setActive so
// afterEach can deactivate it and avoid leaking listeners into later tests.
const liveModes: DesignMode[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
})

afterEach(() => {
  for (const mode of liveModes.splice(0)) mode.setActive(false)
  vi.unstubAllGlobals()
  document.documentElement.style.marginRight = ''
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
    // Two 'resize' listeners now land on `window`: DesignMode's own onReflow (passive)
    // AND the Dock's onWindowResize (docked by default — see dock.ts enter()), which
    // carries no listener-options object at all.
    expect(added).toEqual(['click', 'keydown', 'mousemove', 'resize', 'resize', 'scroll'])
    for (const call of addSpy.mock.calls) {
      if (call[0] === 'scroll') expect(call[2]).toEqual({ capture: true, passive: true })
      else expect(call[2]).toBe(true)
    }
    // DesignMode's own resize listener is passive; Dock's onWindowResize is registered
    // with no options object at all (dock.ts enter()) — assert both shapes are present
    // rather than a uniform check across all window listeners.
    expect(winAddSpy.mock.calls.some((call) => call[2] === undefined)).toBe(true)
    expect(winAddSpy.mock.calls.some((call) => JSON.stringify(call[2]) === JSON.stringify({ passive: true }))).toBe(
      true
    )

    mode.setActive(false)
    const removed = [...removeSpy.mock.calls.map((c) => c[0]), ...winRemoveSpy.mock.calls.map((c) => c[0])].sort()
    expect(removed).toEqual(['click', 'keydown', 'mousemove', 'resize', 'resize', 'scroll'])
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

describe('DesignMode tokens cache invalidation (final review fix #5)', () => {
  afterEach(() => {
    resetTokensCache()
    document.querySelectorAll('style[data-test-dm-tokens]').forEach((el) => el.remove())
    document.documentElement.removeAttribute('style')
  })

  it('activating resets the tokens cache so a theme change since the last activation is picked up', () => {
    document.head.insertAdjacentHTML('beforeend', '<style data-test-dm-tokens>:root { --color-red-500: #fb2c36; }</style>')
    document.documentElement.style.setProperty('--color-red-500', '#fb2c36')

    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)

    mode.setActive(true)
    expect(readTokens().colors.some((c) => c.name === 'red-500')).toBe(true)
    mode.setActive(false)

    // Theme changes while inactive (e.g. author edits CSS, HMR reloads styles) — without
    // invalidation, the stale memoized Tokens would still be returned.
    document.documentElement.style.setProperty('--color-blue-500', '#2b7fff')
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style data-test-dm-tokens>:root { --color-blue-500: #2b7fff; }</style>'
    )

    mode.setActive(true)
    expect(readTokens().colors.some((c) => c.name === 'blue-500')).toBe(true)
  })

  it('calls resetTokensCache on activation (spy-verified)', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    const spy = vi.spyOn(tokensModule, 'resetTokensCache')
    mode.setActive(true)
    expect(spy).toHaveBeenCalled()
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

  it('Escape from inside the overlay host does NOT deselect', () => {
    const { overlay, mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(mode.selected).toBe(btn)
    // Dispatch Escape with the overlay host as the target (shadow retargeting)
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    Object.defineProperty(ev, 'target', { value: overlay.host, configurable: true })
    document.dispatchEvent(ev)
    // Selection should remain
    expect(mode.selected).toBe(btn)
    expect(mode.active).toBe(true)
    // But Escape from document should still deselect
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.selected).toBeNull()
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

  it('copy button writes the rendered change request to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.copyButton.click()
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledTimes(1)
    const md = writeText.mock.calls[0][0] as string
    expect(md).toContain('# Design change request')
    expect(md).toContain('src/Button.tsx:42:8')
    expect(md).toContain('padding-top')
    expect(overlay.copyButton.textContent).toBe('Copied ✓')
  })

  it('copy button reports failure without throwing', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.copyButton.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.copyButton.textContent).toBe('Copy failed')
  })
})

describe('DesignMode multi-select (B6)', () => {
  function multiSetup() {
    document.body.innerHTML = `
      <button data-dc-source="src/Button.tsx:42:8" class="btn" id="a">a</button>
      <button data-dc-source="src/Button2.tsx:1:1" class="btn" id="b">b</button>
      <button data-dc-source="src/Button3.tsx:2:2" class="btn" id="c">c</button>
    `
    const overlay = new Overlay()
    overlay.mount()
    const drafts = new DraftStore()
    const panel = new Panel(drafts, () => {})
    overlay.attachPanel(panel.root)
    const mode = new DesignMode(overlay, panel, drafts)
    liveModes.push(mode)
    return { overlay, drafts, panel, mode }
  }

  function click(el: Element, opts: MouseEventInit = {}): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...opts }))
  }

  it('plain click replaces the selection with just that element', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    expect(mode.selection).toEqual([a])
    click(b)
    expect(mode.selection).toEqual([b])
  })

  it('shift+click on an unselected element adds it to the selection', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    expect(mode.selection).toEqual([a, b])
  })

  it('shift+click on an already-selected element removes it', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    click(a, { shiftKey: true })
    expect(mode.selection).toEqual([b])
  })

  it('shift+click removing the last remaining element deselects entirely', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    click(a)
    click(a, { shiftKey: true })
    expect(mode.selection).toEqual([])
  })

  it('get selected() returns the first selection member (or null) for single-semantics call sites', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    expect(mode.selected).toBeNull()
    click(a)
    expect(mode.selected).toBe(a)
    click(b, { shiftKey: true })
    expect(mode.selected).toBe(a) // first member, unchanged by appending b
  })

  it('Escape clears the entire multi-selection', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mode.selection).toEqual([])
    expect(mode.active).toBe(true) // first Escape only deselects
  })

  it('clicking untagged area deselects the whole multi-selection', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    click(document.body)
    expect(mode.selection).toEqual([])
  })

  it('overlay shows a pooled multi-outline per selected element (single selection keeps using #select-outline)', () => {
    const { overlay, mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    const c = document.getElementById('c')!
    click(a)
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(false)
    expect(root.querySelectorAll('.select-outline-multi').length).toBe(0)

    click(b, { shiftKey: true })
    click(c, { shiftKey: true })
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(true)
    const multi = [...root.querySelectorAll('.select-outline-multi')] as HTMLElement[]
    expect(multi.filter((d) => !d.hidden)).toHaveLength(3)
  })

  it('shrinking back to a single element switches back to #select-outline and hides the multi pool', () => {
    const { overlay, mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    click(b, { shiftKey: true }) // remove b -> back to [a]
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(false)
    expect([...root.querySelectorAll('.select-outline-multi')].every((d: Element) => (d as HTMLElement).hidden)).toBe(
      true
    )
  })

  it('panel.show is called with the full selection array and the first element data in multi-select', () => {
    const { panel, mode } = multiSetup()
    mode.setActive(true)
    const showSpy = vi.spyOn(panel, 'show')
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    expect(showSpy).toHaveBeenLastCalledWith([a, b], expect.objectContaining({ tag: 'button' }))
  })

  it('deselecting shows the docked empty state (design mode still active — docked by default)', () => {
    const { overlay, mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    click(a)
    click(document.body)
    const root = overlay.host.shadowRoot!
    const panelEl = root.getElementById('panel') as HTMLElement
    expect(panelEl.hidden).toBe(false)
    expect((panelEl.querySelector('.panel-empty') as HTMLElement).hidden).toBe(false)
  })
})

describe('DesignMode send-to-agent (M4)', () => {
  /** Flushes enough microtasks for the /queue POST *and* the chained /dispatch POST to settle. */
  async function flushSend(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }

  it('a send where every draft is a no-op does not POST and flashes "No changes"', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    // jsdom's UA stylesheet gives <button> a 2px default border-width — drafting the same
    // value is a genuine no-op (same shape as a user scrubbing a value back to its original).
    drafts.apply(btn, 'border-top-width', '2px')
    overlay.sendButton.click()
    await flushSend()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(overlay.sendButton.textContent).toBe('No changes')
    expect(mode.sent.size()).toBe(0)
  })

  it('Copy for agent with only no-op drafts does not copy and flashes "No changes"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'border-top-width', '2px') // jsdom UA default — a genuine no-op
    overlay.copyButton.click()
    await flushSend()
    expect(writeText).not.toHaveBeenCalled()
    expect(overlay.copyButton.textContent).toBe('No changes')
  })

  it('Copy for agent still works for an in-flight request (no duplicate filter on copy — manual fallback)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await flushSend() // request is now in flight

    overlay.copyButton.click()
    await flushSend()
    expect(writeText).toHaveBeenCalledTimes(1) // copy is the manual escape hatch — never blocked by in-flight state
  })

  it('re-clicking Send with an identical in-flight request does not re-queue and flashes "Already sent"', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await flushSend() // first send settles — drafts stay live until verification

    overlay.sendButton.click() // impatient second click, nothing re-edited
    await flushSend()

    const queueCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')
    expect(queueCalls).toHaveLength(1)
    expect(overlay.sendButton.textContent).toBe('Already sent')
    expect(mode.sent.pendingIds()).toEqual(['q1'])
  })

  it("reverting all drafts while another send is in flight flashes 'No changes', not 'Already sent' (agrees with Copy)", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await flushSend() // q1 in flight

    drafts.apply(btn, 'padding-top', '') // reverted to the original — the builder now produces nothing
    overlay.sendButton.click()
    await flushSend()

    expect(overlay.sendButton.textContent).toBe('No changes')
    expect(fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')).toHaveLength(1)
  })

  it('re-editing an in-flight element to a NEW value sends again (not a duplicate)', async () => {
    let nextId = 1
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: `q${nextId++}` }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await flushSend()

    drafts.apply(btn, 'padding-top', '32px') // user kept editing — new value
    overlay.sendButton.click()
    await flushSend()

    const queueCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')
    expect(queueCalls).toHaveLength(2)
    expect(mode.sent.pendingIds().sort()).toEqual(['q1', 'q2'])
  })

  it('send posts the request and registers pending ids', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'tmux', detail: 'x' }) })
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await flushSend()
    expect(fetchMock).toHaveBeenCalledWith('/__the-forge/queue', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.markdown).toContain('# Design change request')
    expect(mode.sent.pendingIds()).toEqual(['q1'])
    expect(overlay.sendButton.textContent).toBe('Sent — typed /forge-design into your session')
  })

  describe('dispatch chaining after a successful queue POST', () => {
    function stubQueueThenDispatch(dispatchResponse: { rung: string; detail: string }) {
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
        if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => dispatchResponse })
        throw new Error(`unexpected fetch: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('POSTs /dispatch after a successful /queue POST', async () => {
      const fetchMock = stubQueueThenDispatch({ rung: 'tmux', detail: 'x' })
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(fetchMock).toHaveBeenCalledWith('/__the-forge/dispatch', expect.objectContaining({ method: 'POST' }))
    })

    it('surfaces "typed /forge-design into your session" for rung tmux', async () => {
      stubQueueThenDispatch({ rung: 'tmux', detail: 'x' })
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(overlay.sendButton.textContent).toBe('Sent — typed /forge-design into your session')
    })

    it('surfaces "typed /forge-design into your session" for rung applescript', async () => {
      stubQueueThenDispatch({ rung: 'applescript', detail: 'x' })
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(overlay.sendButton.textContent).toBe('Sent — typed /forge-design into your session')
    })

    it('surfaces "opened in Cursor" for rung deeplink', async () => {
      stubQueueThenDispatch({ rung: 'deeplink', detail: 'x' })
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(overlay.sendButton.textContent).toBe('Sent — opened in Cursor')
    })

    it('surfaces "type /forge-design in Claude Code" for rung manual with the default agent', async () => {
      stubQueueThenDispatch({ rung: 'manual', detail: 'x' })
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(overlay.sendButton.textContent).toBe('Sent — type /forge-design in Claude Code')
    })

    it('surfaces the configured agent name for rung manual (cursor)', async () => {
      ;(globalThis as { __THE_FORGE__?: { agent?: string } }).__THE_FORGE__ = { agent: 'cursor' }
      stubQueueThenDispatch({ rung: 'manual', detail: 'x' })
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(overlay.sendButton.textContent).toBe('Sent — type /forge-design in Cursor')
      delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
    })

    it('surfaces the configured agent name for rung manual (codex)', async () => {
      ;(globalThis as { __THE_FORGE__?: { agent?: string } }).__THE_FORGE__ = { agent: 'codex' }
      stubQueueThenDispatch({ rung: 'manual', detail: 'x' })
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(overlay.sendButton.textContent).toBe('Sent — type /forge-design in Codex')
      delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
    })

    it('falls back to the manual label for an unrecognized rung value (defensive default, not the typed-into-session label)', async () => {
      // The client's Rung union is a compile-time-only guarantee — the value actually arrives
      // over the network as untyped JSON, so a server bug/future rung/typo must not silently
      // fall into the "typed /forge-design into your session" bucket (which would misreport that a
      // terminal was actually typed into).
      stubQueueThenDispatch({ rung: 'not-a-real-rung', detail: 'x' })
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(overlay.sendButton.textContent).toBe('Sent — type /forge-design in Claude Code')
    })

    it('still registers the send as successful (pending id tracked) even if /dispatch POST fails', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
        if (url === '/__the-forge/dispatch') return Promise.reject(new Error('dispatch network error'))
        throw new Error(`unexpected fetch: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await flushSend()
      expect(mode.sent.pendingIds()).toEqual(['q1'])
      // Falls back to a manual-style label since dispatch itself couldn't be reached.
      expect(overlay.sendButton.textContent).toBe('Sent — type /forge-design in Claude Code')
    })

    it('re-enables the send button only after both /queue and /dispatch settle', async () => {
      let resolveDispatch!: (v: { ok: boolean; json: () => Promise<{ rung: string; detail: string }> }) => void
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
        if (url === '/__the-forge/dispatch') return new Promise((resolve) => (resolveDispatch = resolve))
        throw new Error(`unexpected fetch: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const { overlay, mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      overlay.sendButton.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(overlay.sendButton.disabled).toBe(true)
      resolveDispatch({ ok: true, json: async () => ({ rung: 'tmux', detail: 'x' }) })
      await flushSend()
      expect(overlay.sendButton.disabled).toBe(false)
    })
  })

  it('send includes X-Forge-Secret header when globalThis.__THE_FORGE__.secret is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'q1' }) })
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 'shh-secret' }
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await Promise.resolve()
    await Promise.resolve()
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-Forge-Secret']).toBe('shh-secret')
    delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
  })

  it('send omits X-Forge-Secret header when no secret is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'q1' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await Promise.resolve()
    await Promise.resolve()
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-Forge-Secret']).toBeUndefined()
  })

  it('send registers the live element mapping keyed by the server-assigned id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'q7' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await Promise.resolve()
    await Promise.resolve()
    const entry = mode.sent.take('q7')!
    expect(entry.elements).toHaveLength(1)
    expect(entry.elements[0].el).toBe(btn)
    expect(entry.elements[0].dcSource).toBe('src/Button.tsx:42:8')
    expect(entry.elements[0].changes[0].property).toBe('padding-top')
    expect(entry.elements[0].draftProps).toEqual(['padding-top'])
  })

  it('send failure flashes "Send failed" and leaves drafts untouched', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.sendButton.textContent).toBe('Send failed')
    expect(mode.sent.size()).toBe(0)
    expect(drafts.hasDrafts(btn)).toBe(true)
    expect(btn.style.getPropertyValue('padding-top')).toBe('24px')
  })

  it('send failure on non-200 response also flashes "Send failed"', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'bad' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.sendButton.textContent).toBe('Send failed')
    expect(mode.sent.size()).toBe(0)
  })

  it('calls onSendComplete after a successful send registers', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q9' }) })
      return Promise.resolve({ ok: true, json: async () => ({ rung: 'tmux', detail: 'x' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    const onSendComplete = vi.fn()
    mode.onSendComplete = onSendComplete
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await flushSend()
    expect(onSendComplete).toHaveBeenCalledTimes(1)
  })

  it('disables the send button while the POST is in flight, and re-enables on success', async () => {
    let resolveFetch!: (v: { ok: boolean; json: () => Promise<{ id: string }> }) => void
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return new Promise((resolve) => (resolveFetch = resolve))
      return Promise.resolve({ ok: true, json: async () => ({ rung: 'tmux', detail: 'x' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')

    overlay.sendButton.click()
    await Promise.resolve()
    expect(overlay.sendButton.disabled).toBe(true)

    resolveFetch({ ok: true, json: async () => ({ id: 'q1' }) })
    await flushSend()
    expect(overlay.sendButton.disabled).toBe(false)
  })

  it('disables the send button while the POST is in flight, and re-enables on failure', async () => {
    let rejectFetch!: (e: Error) => void
    const fetchMock = vi.fn().mockReturnValue(new Promise((_resolve, reject) => (rejectFetch = reject)))
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')

    overlay.sendButton.click()
    await Promise.resolve()
    expect(overlay.sendButton.disabled).toBe(true)

    rejectFetch(new Error('network down'))
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.sendButton.disabled).toBe(false)
  })

  it('two rapid clicks result in exactly one /queue POST (re-entrancy guard)', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      return Promise.resolve({ ok: true, json: async () => ({ rung: 'tmux', detail: 'x' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')

    overlay.sendButton.click()
    overlay.sendButton.click()
    await flushSend()
    const queueCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')
    expect(queueCalls).toHaveLength(1)
  })
})

describe('change list wiring', () => {
  /** Flushes enough microtasks for the /queue POST *and* the chained /dispatch POST to settle —
   * same convention as flushSend() in the send-to-agent describe block above. */
  async function flushSend(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }

  it('mounts the ChangeList inside the panel changes slot', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attachPanel(mode.panelRoot)
    expect(mode.panelRoot.querySelector('.changes-section')).not.toBeNull()
  })

  it('seeds sent rows on a successful send and clears them on deactivate', async () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attachPanel(mode.panelRoot)
    const el = document.createElement('div')
    el.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(el)
    mode.setActive(true)
    mode.select(el as never)
    // draft an edit, then click Send with a stubbed queue/dispatch
    ;(mode as never as { drafts: DraftStore }).drafts.apply(el as never, 'padding-top', '24px')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q9' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    overlay.sendButton.click()
    await flushSend()
    expect(mode.panelRoot.querySelectorAll('.change-row').length).toBeGreaterThan(0)
    expect(mode.panelRoot.querySelector('.chip-sent')).not.toBeNull()
    mode.setActive(false)
    mode.setActive(true)
    expect(mode.panelRoot.querySelectorAll('.change-row')).toHaveLength(0)
  })
})

describe('DesignMode verifier wiring (M4 Task 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the verifier after a successful send and reflects the summary in the status strip', async () => {
    // URL-dispatched mock (not a mockResolvedValueOnce sequence): the WatchStatus poller's
    // `?ids=` probe now interleaves with the verifier's `?ids=q1` polls on the same fake
    // timers, so a consumed-in-order mock queue would misroute responses between the two.
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch')
        return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      if (url === '/__the-forge/status?ids=q1')
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await Promise.resolve()
    await Promise.resolve()

    // the verifier neutralizes draft inline styles before measuring, so "the code
    // adopted the value" must come from somewhere other than the draft itself. Inserted
    // AFTER the send (matching reality — the agent applies post-Send): a stylesheet that
    // already carries the drafted value at build time makes the draft a no-op, which
    // buildChangeRequest now (correctly) drops instead of sending an empty request.
    const style = document.createElement('style')
    style.textContent = '.btn { padding-top: 24px; }'
    document.head.appendChild(style)

    await vi.advanceTimersByTimeAsync(2000)

    const sentLabel = overlay.host.shadowRoot!.getElementById('sent') as HTMLElement
    expect(sentLabel.hidden).toBe(false)
    expect(sentLabel.textContent).toContain('implemented')
    expect(drafts.hasDrafts(btn)).toBe(false)
  })

  it('stops polling on deactivate and resumes on activate while entries remain', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'q1' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.sendButton.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(mode.sent.size()).toBe(1)

    mode.setActive(false)
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(4000)
    expect(fetchMock).not.toHaveBeenCalled() // stopped: no polling while inactive

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    mode.setActive(true) // entries remain pending -> polling resumes
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledWith('/__the-forge/status?ids=q1')
  })

  it('does not start VERIFIER polling on activate when there are no pending sends', () => {
    // The watch-status probe (`?ids=`) legitimately polls while design mode is on — this
    // test guards the VERIFIER staying quiet, so assert no per-id status calls instead of
    // no calls at all.
    const fetchMock = vi.fn((url: string) => {
      void url
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)
    expect(mode.sent.size()).toBe(0)
    return vi.advanceTimersByTimeAsync(4000).then(() => {
      const urls = fetchMock.mock.calls.map((c) => c[0])
      expect(urls.length).toBeGreaterThan(0) // the watch probe DID poll…
      expect(urls.every((u) => u === '/__the-forge/status?ids=')).toBe(true) // …and nothing else did
    })
  })

  it('refreshes the panel and re-measures the selection outline when a verify update arrives', async () => {
    // URL-dispatched mock — see the summary-strip test above for why.
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch')
        return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      if (url === '/__the-forge/status?ids=q1')
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    mode.select(btn) // panel is showing this element, as it might be while awaiting verification

    overlay.sendButton.click()
    await Promise.resolve()
    await Promise.resolve()

    // Inserted after the send — see the summary-strip test above for why.
    const style = document.createElement('style')
    style.textContent = '.btn { padding-top: 24px; }'
    document.head.appendChild(style)

    const refreshSpy = vi.spyOn(panel, 'refresh')

    await vi.advanceTimersByTimeAsync(2000)

    expect(refreshSpy).toHaveBeenCalled()
  })
})

describe('DesignMode layout-ripple wiring (M2b Task 4)', () => {
  function fieldInput(root: HTMLElement, label: string): HTMLInputElement {
    const nf = [...root.querySelectorAll('.nf')].find((n) => n.querySelector('.nf-label')!.textContent === label)
    if (!nf) throw new Error(`no field labeled ${label}`)
    return nf.querySelector('input')!
  }

  function commit(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
    el.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height)
  }

  // Queued rAF (rather than the file-level immediate stub) so the test can mutate
  // rects BETWEEN the pre-edit snapshot and the post-edit diff, simulating real reflow.
  function rippleSetup() {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    document.body.innerHTML = `
      <div data-dc-source="src/Wrap.tsx:1:1" id="scope">
        <div data-dc-source="src/Selected.tsx:2:2" id="selected" style="padding: 8px;"></div>
        <div data-dc-source="src/Sibling.tsx:3:3" id="sibling"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    return { overlay, mode, runRaf: () => queue.splice(0).forEach((cb) => cb(0)) }
  }

  it('editing PY on the selected element ripples the sibling whose rect changed after the edit', () => {
    const { overlay, mode, runRaf } = rippleSetup()
    mode.setActive(true)
    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 })

    mode.select(selected)
    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, 'PY'), '40')
    // post-edit reflow: the sibling moved down (simulating the padding push) before
    // the rAF-scheduled diff runs
    stubRect(sibling, { x: 0, y: 60, width: 100, height: 20 })
    runRaf()

    expect(showRipplesSpy).toHaveBeenCalledWith([sibling.getBoundingClientRect()])
  })

  it('never includes the selected element in ripples', () => {
    const { mode, overlay, runRaf } = rippleSetup()
    mode.setActive(true)
    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 })
    mode.select(selected)

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')
    // the selected element itself also changes rect due to the edit (padding growth) —
    // it must never appear in the ripple set even though it moved.
    commit(fieldInput(mode.panelRoot, 'PY'), '40')
    stubRect(selected, { x: 0, y: 0, width: 100, height: 60 })
    stubRect(sibling, { x: 0, y: 90, width: 100, height: 20 })
    runRaf()

    expect(showRipplesSpy).toHaveBeenCalled()
    const selectedRect = selected.getBoundingClientRect()
    for (const [rects] of showRipplesSpy.mock.calls) {
      for (const r of rects) {
        expect(r.x === selectedRect.x && r.y === selectedRect.y && r.width === selectedRect.width).toBe(false)
      }
    }
  })

  it('deactivating cancels a pending ripple rAF (no stray showRipples after exit)', () => {
    const { mode, overlay, runRaf } = rippleSetup()
    mode.setActive(true)
    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 })
    mode.select(selected)

    commit(fieldInput(mode.panelRoot, 'PY'), '40')
    stubRect(sibling, { x: 0, y: 60, width: 100, height: 20 })

    mode.setActive(false) // exits before the queued rAF runs

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')
    runRaf() // if the stale callback still ran, this would call showRipples
    expect(showRipplesSpy).not.toHaveBeenCalled()
  })
})

describe('DesignMode layout-ripple debounce (M2b Task 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function fieldInput(root: HTMLElement, label: string): HTMLInputElement {
    const nf = [...root.querySelectorAll('.nf')].find((n) => n.querySelector('.nf-label')!.textContent === label)
    if (!nf) throw new Error(`no field labeled ${label}`)
    return nf.querySelector('input')!
  }

  function commit(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
    el.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height)
  }

  it('a rapid burst of edits reuses the first snapshot until 300ms of quiet', () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = () => queue.splice(0).forEach((cb) => cb(0))

    document.body.innerHTML = `
      <div data-dc-source="src/Wrap.tsx:1:1" id="scope">
        <div data-dc-source="src/Selected.tsx:2:2" id="selected" style="padding: 8px;"></div>
        <div data-dc-source="src/Sibling.tsx:3:3" id="sibling"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 })
    mode.select(selected)

    // Burst: 3 edits within 300ms — the FIRST snapshot (sibling at y=30) should be
    // the baseline the final diff is measured against, not a snapshot re-taken mid-burst.
    commit(fieldInput(mode.panelRoot, 'PY'), '10')
    stubRect(sibling, { x: 0, y: 40, width: 100, height: 20 }) // mid-burst noise
    runRaf()
    vi.advanceTimersByTime(100)
    commit(fieldInput(mode.panelRoot, 'PY'), '20')
    stubRect(sibling, { x: 0, y: 50, width: 100, height: 20 }) // mid-burst noise
    runRaf()
    vi.advanceTimersByTime(100)

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')
    commit(fieldInput(mode.panelRoot, 'PY'), '30')
    stubRect(sibling, { x: 0, y: 70, width: 100, height: 20 }) // final settled position
    runRaf()

    expect(showRipplesSpy).toHaveBeenCalledWith([sibling.getBoundingClientRect()])
  })

  it('a slow drag (sub-threshold per-frame, above-threshold cumulative) still ripples on the burst\'s third edit', () => {
    // Discriminating test: each edit moves the sibling +0.4px relative to its PREVIOUS
    // position — below the 0.5px change threshold if re-baselined every frame (the bug:
    // handleEdited's rAF nulled rippleSnapshot, forcing a fresh baseline each edit).
    // Cumulatively across the burst the sibling has moved +1.2px from the DRAG-START
    // baseline, which IS above threshold. This only passes when the snapshot from the
    // first edit in the burst survives to be diffed against on the third edit.
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = () => queue.splice(0).forEach((cb) => cb(0))

    document.body.innerHTML = `
      <div data-dc-source="src/Wrap.tsx:1:1" id="scope">
        <div data-dc-source="src/Selected.tsx:2:2" id="selected" style="padding: 8px;"></div>
        <div data-dc-source="src/Sibling.tsx:3:3" id="sibling"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 }) // drag-start baseline
    mode.select(selected)

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, 'PY'), '10')
    stubRect(sibling, { x: 0, y: 30.4, width: 100, height: 20 }) // +0.4px vs previous — sub-threshold
    runRaf()
    vi.advanceTimersByTime(50) // well within the 300ms quiet window

    commit(fieldInput(mode.panelRoot, 'PY'), '20')
    stubRect(sibling, { x: 0, y: 30.8, width: 100, height: 20 }) // +0.4px vs previous — sub-threshold
    runRaf()
    vi.advanceTimersByTime(50)

    commit(fieldInput(mode.panelRoot, 'PY'), '30')
    stubRect(sibling, { x: 0, y: 31.2, width: 100, height: 20 }) // +0.4px vs previous, +1.2px vs drag-start
    runRaf()

    expect(showRipplesSpy).toHaveBeenCalledWith([sibling.getBoundingClientRect()])
  })

  it('re-snapshots when the selection changes mid-burst', () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = () => queue.splice(0).forEach((cb) => cb(0))

    // Two separate component trees (separate scopes)
    document.body.innerHTML = `
      <div data-dc-source="src/ComponentA.tsx:1:1" id="compA" style="padding: 8px;">
        <div data-dc-source="src/ChildA.tsx:2:2" id="childA"></div>
        <div data-dc-source="src/SiblingA.tsx:3:3" id="siblingA"></div>
      </div>
      <div data-dc-source="src/ComponentB.tsx:4:4" id="compB" style="padding: 8px;">
        <div data-dc-source="src/ChildB.tsx:5:5" id="childB"></div>
        <div data-dc-source="src/SiblingB.tsx:6:6" id="siblingB"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const childA = document.getElementById('childA')! as HTMLElement
    const siblingA = document.getElementById('siblingA')! as HTMLElement
    const childB = document.getElementById('childB')! as HTMLElement
    const siblingB = document.getElementById('siblingB')! as HTMLElement

    // Setup both scopes with distinct positions
    stubRect(childA, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(siblingA, { x: 0, y: 30, width: 100, height: 20 })
    stubRect(childB, { x: 400, y: 0, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 30, width: 100, height: 20 })

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    // STEP 1: Select childA and edit it. This snapshots ComponentA's scope (includes siblingA).
    mode.select(childA)
    commit(fieldInput(mode.panelRoot, 'PY'), '10')
    // The rAF is queued but NOT yet run — snapshot still in memory
    expect(queue).toHaveLength(1)

    // Update positions as if layout reflow happened
    stubRect(siblingA, { x: 0, y: 40, width: 100, height: 20 })

    // STEP 2: Before the ripple rAF runs, switch to childB and edit it within debounce.
    // BUG: The old snapshot (childA's scope with siblingA) is still in mode.rippleSnapshot.
    // handleBeforeEdit(childB) should re-snapshot because the element changed, but the
    // buggy code only checks elapsed time, not which element the snapshot was for.
    mode.select(childB)
    commit(fieldInput(mode.panelRoot, 'PY'), '10')
    // Now we have TWO rAFs queued: one from childA edit, one from childB edit
    expect(queue).toHaveLength(2)

    // Update childB's sibling position
    stubRect(siblingB, { x: 400, y: 40, width: 100, height: 20 })

    // Run BOTH rAFs and check what ripples were shown
    showRipplesSpy.mockClear()
    runRaf()

    // After running both rAFs:
    // - First rAF (from childA) diffs childA's snapshot against current positions
    // - Second rAF (from childB) diffs either childB's snapshot (CORRECT) or childA's (BUG)
    //
    // If the bug exists: childB's rAF diff runs against childA's snapshot, measuring siblingA.
    // Since siblingA moved from y=30→40, and the snapshot has y=30, it would show a ripple at y=40.
    // But we want it to show siblingB moving from y=30→40 at x=400.

    // Correct behavior: at least one call should have rects with x=400 (siblingB), not x=0 (siblingA).
    expect(showRipplesSpy.mock.calls.length).toBeGreaterThan(0)
    let hasCorrectRipple = false
    for (const callArgs of showRipplesSpy.mock.calls) {
      const rects = callArgs[0]
      for (const rect of rects) {
        if (rect.x === 400) {
          hasCorrectRipple = true
          break
        }
      }
    }
    expect(hasCorrectRipple).toBe(true) // Must see siblingB ripple, not just siblingA
  })

})

describe('DesignMode layout-ripple multi-select (B6 follow-up)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function fieldInput(root: HTMLElement, label: string): HTMLInputElement {
    const nf = [...root.querySelectorAll('.nf')].find((n) => n.querySelector('.nf-label')!.textContent === label)
    if (!nf) throw new Error(`no field labeled ${label}`)
    return nf.querySelector('input')!
  }

  function commit(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
    el.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height)
  }

  function click(el: Element, opts: MouseEventInit = {}): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...opts }))
  }

  /** Flattens every rect from every showRipples call into one list. */
  function allRippledRects(spy: ReturnType<typeof vi.spyOn>): DOMRect[] {
    return spy.mock.calls.flatMap((call) => call[0] as DOMRect[])
  }

  // Two separate component trees (separate ripple scopes), each with its own sibling —
  // a multi-select spanning both must ripple around BOTH scopes.
  function twoScopeSetup() {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    document.body.innerHTML = `
      <div data-dc-source="src/ComponentA.tsx:1:1" id="compA" style="padding: 8px;">
        <div data-dc-source="src/ChildA.tsx:2:2" id="childA"></div>
        <div data-dc-source="src/SiblingA.tsx:3:3" id="siblingA"></div>
      </div>
      <div data-dc-source="src/ComponentB.tsx:4:4" id="compB" style="padding: 8px;">
        <div data-dc-source="src/ChildB.tsx:5:5" id="childB"></div>
        <div data-dc-source="src/SiblingB.tsx:6:6" id="siblingB"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const childA = document.getElementById('childA')! as HTMLElement
    const siblingA = document.getElementById('siblingA')! as HTMLElement
    const childB = document.getElementById('childB')! as HTMLElement
    const siblingB = document.getElementById('siblingB')! as HTMLElement
    stubRect(childA, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(siblingA, { x: 0, y: 30, width: 100, height: 20 })
    stubRect(childB, { x: 400, y: 0, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 30, width: 100, height: 20 })

    // Multi-select both children (click + shift-click, the real B6 gesture)
    click(childA)
    click(childB, { shiftKey: true })

    return { overlay, mode, childA, siblingA, childB, siblingB, runRaf: () => queue.splice(0).forEach((cb) => cb(0)) }
  }

  it('a multi-select edit ripples siblings in EVERY selected element\'s scope, not just the last one snapshotted', () => {
    const { overlay, mode, siblingA, siblingB, runRaf } = twoScopeSetup()
    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, 'PY'), '40')
    // post-edit reflow in BOTH scopes before the rAF-scheduled diff runs
    stubRect(siblingA, { x: 0, y: 60, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 60, width: 100, height: 20 })
    runRaf()

    const rects = allRippledRects(showRipplesSpy)
    // BUG (single-slot snapshot): only childB's snapshot survives the per-element
    // onBeforeEdit loop, so only siblingB ripples and siblingA's reflow is missed.
    expect(rects.some((r) => r.x === 0 && r.y === 60)).toBe(true) // siblingA
    expect(rects.some((r) => r.x === 400 && r.y === 60)).toBe(true) // siblingB
  })

  it('multi-select slow drag (sub-threshold per tick, above-threshold cumulative) still ripples — per-element baselines survive alternating onBeforeEdit calls', () => {
    // Each tick moves both siblings +0.4px (below the 0.5px CHANGE_THRESHOLD).
    // Cumulatively they move +1.2px from the drag-start baseline. This only ripples
    // if each element's FIRST snapshot in the burst survives the alternating
    // per-element onBeforeEdit calls of the multi-select commit loop — the old
    // single-slot state re-snapshotted on EVERY call (rippleSnapshotFor !== el),
    // re-baselining every tick and never crossing the threshold.
    const { overlay, mode, siblingA, siblingB, runRaf } = twoScopeSetup()
    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, 'PY'), '10')
    stubRect(siblingA, { x: 0, y: 30.4, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 30.4, width: 100, height: 20 })
    runRaf()
    vi.advanceTimersByTime(50) // well within the 300ms quiet window

    commit(fieldInput(mode.panelRoot, 'PY'), '20')
    stubRect(siblingA, { x: 0, y: 30.8, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 30.8, width: 100, height: 20 })
    runRaf()
    vi.advanceTimersByTime(50)

    showRipplesSpy.mockClear()
    commit(fieldInput(mode.panelRoot, 'PY'), '30')
    stubRect(siblingA, { x: 0, y: 31.2, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 31.2, width: 100, height: 20 })
    runRaf()

    const rects = allRippledRects(showRipplesSpy)
    expect(rects.some((r) => r.x === 0 && r.y === 31.2)).toBe(true) // siblingA
    expect(rects.some((r) => r.x === 400 && r.y === 31.2)).toBe(true) // siblingB
  })

  it('multi-select burst reuses each element\'s first snapshot instead of re-measuring the scope on every tick', () => {
    // Direct churn check: after the burst's first edit, subsequent edits within the
    // debounce window must NOT re-measure the siblings' rects at onBeforeEdit time
    // (only the post-edit rAF diff re-measures). The old single-slot state called
    // snapshotRects() for every element on every tick because the alternating
    // per-element calls always failed the rippleSnapshotFor === el reuse check.
    const { mode, siblingA, siblingB, runRaf } = twoScopeSetup()

    commit(fieldInput(mode.panelRoot, 'PY'), '10')
    runRaf() // flush the first diff (one legitimate re-measure per sibling)
    vi.advanceTimersByTime(50)

    let measuresA = 0
    let measuresB = 0
    const rectA = new DOMRect(0, 30, 100, 20)
    const rectB = new DOMRect(400, 30, 100, 20)
    siblingA.getBoundingClientRect = () => (measuresA++, rectA)
    siblingB.getBoundingClientRect = () => (measuresB++, rectB)

    commit(fieldInput(mode.panelRoot, 'PY'), '20')
    // No rAF flush yet: any measurement so far came from onBeforeEdit re-snapshotting.
    expect(measuresA).toBe(0)
    expect(measuresB).toBe(0)
    runRaf() // the diff itself measures each sibling exactly once
    expect(measuresA).toBe(1)
    expect(measuresB).toBe(1)
  })

  it('co-selected elements never appear in ripples even when they sit in each other\'s snapshot scope', () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = (): void => queue.splice(0).forEach((cb) => cb(0))
    // ONE shared scope: each selected element appears in the OTHER's snapshot
    // (snapshotRects only excludes the element it was taken for).
    document.body.innerHTML = `
      <div data-dc-source="src/Wrap.tsx:1:1" id="scope">
        <div data-dc-source="src/SelA.tsx:2:2" id="selA" style="padding: 8px;"></div>
        <div data-dc-source="src/SelB.tsx:3:3" id="selB" style="padding: 8px;"></div>
        <div data-dc-source="src/Sibling.tsx:4:4" id="sibling"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const selA = document.getElementById('selA')! as HTMLElement
    const selB = document.getElementById('selB')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selA, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(selB, { x: 0, y: 30, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 60, width: 100, height: 20 })

    click(selA)
    click(selB, { shiftKey: true })
    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, 'PY'), '40')
    // BOTH edited elements grow (padding), pushing the sibling down
    stubRect(selA, { x: 0, y: 0, width: 100, height: 60 })
    stubRect(selB, { x: 0, y: 70, width: 100, height: 60 })
    stubRect(sibling, { x: 0, y: 140, width: 100, height: 20 })
    runRaf()

    const rects = allRippledRects(showRipplesSpy)
    expect(rects.some((r) => r.y === 140)).toBe(true) // the true sibling ripples
    // Neither co-selected element may ripple, even though each moved and each sits
    // in the other's snapshot scope.
    expect(rects.some((r) => r.height === 60)).toBe(false)
  })
})

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

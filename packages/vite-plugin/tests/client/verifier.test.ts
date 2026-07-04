// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Verifier, verifyEntry } from '../../src/client/verifier'
import { SentRegistry, type SentEntry } from '../../src/client/sent'
import { DraftStore } from '../../src/client/drafts'

function el(): HTMLElement {
  const d = document.createElement('div')
  document.body.appendChild(d)
  return d
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Represents a "code applied the value" fixture: a stylesheet rule targeting the
// element by id, which survives inline-style neutralization during verification
// (unlike setting el.style directly, which the verifier now zeroes out before measuring).
function styleRule(id: string, prop: string, value: string): void {
  const style = document.createElement('style')
  style.textContent = `#${id} { ${prop}: ${value}; }`
  document.head.appendChild(style)
}

describe('verifyEntry', () => {
  it('reports verified when computed style matches afterCss (live element)', () => {
    const d = el()
    d.id = 't1'
    styleRule('t1', 'padding-top', '24px')
    const entry: SentEntry = {
      id: 'q1',
      elements: [{ el: d, dcSource: 'src/App.tsx:1:1', changes: [{ property: 'padding-top', afterCss: '24px' }] }],
    }
    const result = verifyEntry(entry)
    expect(result.verified).toBe(1)
    expect(result.mismatched).toEqual([])
    expect(result.missing).toBe(0)
  })

  it('trims and exact-matches computed value vs afterCss', () => {
    const d = el()
    d.id = 't2'
    styleRule('t2', 'padding-top', '24px')
    const entry: SentEntry = {
      id: 'q1',
      elements: [{ el: d, dcSource: null, changes: [{ property: 'padding-top', afterCss: '  24px  ' }] }],
    }
    const result = verifyEntry(entry)
    expect(result.verified).toBe(1)
    expect(result.mismatched).toEqual([])
  })

  it('reports a mismatch when computed style differs from afterCss', () => {
    const d = el()
    d.id = 't3'
    styleRule('t3', 'padding-top', '10px')
    const entry: SentEntry = {
      id: 'q1',
      elements: [{ el: d, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }],
    }
    const result = verifyEntry(entry)
    expect(result.verified).toBe(0)
    expect(result.mismatched).toEqual([{ property: 'padding-top', expected: '24px', actual: '10px' }])
    expect(result.missing).toBe(0)
  })

  it('detects mismatch when the underlying code does not provide the drafted value', () => {
    // element whose ONLY source of the value is the draft inline style
    document.body.innerHTML = `<div data-dc-source="src/a.tsx:1:1" id="t"></div>`
    const el = document.getElementById('t')! as HTMLElement
    el.style.setProperty('padding-top', '32px') // the draft preview
    const entry = {
      id: 'q1',
      elements: [{ el, dcSource: 'src/a.tsx:1:1', changes: [{ property: 'padding-top', afterCss: '32px' }] }],
    }
    const result = verifyEntry(entry)
    // with inline neutralized, computed padding-top is '' (jsdom default) ≠ '32px'
    expect(result.mismatched.length).toBeGreaterThan(0)
    expect(el.style.getPropertyValue('padding-top')).toBe('32px') // restored after measurement
  })

  it('re-locates a removed element via data-dc-source and verifies against the new node', () => {
    const d = el()
    d.dataset.dcSource = 'src/App.tsx:5:2'
    d.id = 't5'
    styleRule('t5', 'padding-top', '24px')
    const entry: SentEntry = {
      id: 'q1',
      elements: [{ el: d, dcSource: 'src/App.tsx:5:2', changes: [{ property: 'padding-top', afterCss: '24px' }] }],
    }
    d.remove() // el.isConnected is now false

    const replacement = document.createElement('div')
    replacement.dataset.dcSource = 'src/App.tsx:5:2'
    replacement.id = 't5b'
    styleRule('t5b', 'padding-top', '24px')
    document.body.appendChild(replacement)

    const result = verifyEntry(entry, document)
    expect(result.verified).toBe(1)
    expect(result.missing).toBe(0)
  })

  it('counts as missing when neither the live ref nor a dc-source match is found', () => {
    const d = el()
    d.dataset.dcSource = 'src/App.tsx:9:9'
    const entry: SentEntry = {
      id: 'q1',
      elements: [{ el: d, dcSource: 'src/App.tsx:9:9', changes: [{ property: 'padding-top', afterCss: '24px' }] }],
    }
    d.remove()
    const result = verifyEntry(entry, document)
    expect(result.missing).toBe(1)
    expect(result.verified).toBe(0)
    expect(result.mismatched).toEqual([])
  })
})

function makeEntry(elements: SentEntry['elements']): SentEntry['elements'] {
  return elements
}

describe('Verifier polling lifecycle', () => {
  it('polls only while the registry has pending entries, and stops when it empties', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    btn.style.setProperty('padding-top', '24px')
    drafts.apply(btn, 'padding-top', '24px')
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledWith('/__the-forge/status?ids=q1')
    expect(sent.size()).toBe(0)

    // registry now empty -> interval should have cleared itself; no more fetches
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(4000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('start() is idempotent — does not create a second interval', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const btn = el()
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, changes: [] }]))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, vi.fn())
    verifier.start()
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('on applied status with matching computed styles: commits drafts and reports implemented', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    btn.id = 'implemented-btn'
    styleRule('implemented-btn', 'padding-top', '24px') // code now provides the drafted value
    drafts.apply(btn, 'padding-top', '24px') // sets inline style to 24px (neutralized during verification)
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    const commitSpy = vi.spyOn(drafts, 'commit')

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(commitSpy).toHaveBeenCalledWith(btn, ['padding-top'])
    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary).toContain('implemented')
  })

  it('on applied status with mismatched computed styles: does not commit and reports mismatch', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    drafts.apply(btn, 'padding-top', '10px') // draft applied a DIFFERENT value than what was "sent"
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    const commitSpy = vi.spyOn(drafts, 'commit')

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(commitSpy).not.toHaveBeenCalled()
    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary).toContain('mismatch')
  })

  it('on failed status: takes the entry and reports failed', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'failed', note: 'could not apply' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(sent.size()).toBe(0)
    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary).toContain('failed')
  })

  it('missing elements are reported as applied (unverified), not mismatches', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    btn.dataset.dcSource = 'src/Gone.tsx:1:1'
    sent.add('q1', makeEntry([{ el: btn, dcSource: 'src/Gone.tsx:1:1', changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    btn.remove() // no replacement exists anywhere

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary).toContain('unverified')
    expect(lastSummary).not.toContain('mismatch')
  })

  it('prepends a pending "applying…" segment while entries remain in the sent registry', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn1 = el()
    btn1.id = 'pending-btn1'
    styleRule('pending-btn1', 'padding-top', '24px')
    drafts.apply(btn1, 'padding-top', '24px')
    sent.add('q1', makeEntry([{ el: btn1, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    // q2 stays pending — server has not marked it yet
    sent.add('q2', makeEntry([{ el: el(), dcSource: null, changes: [{ property: 'padding-top', afterCss: '10px' }] }]))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(sent.size()).toBe(1) // q2 still pending
    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary.startsWith('1 applying…')).toBe(true)
    expect(lastSummary).toContain('implemented')
  })

  it('summary counts are cumulative across multiple poll cycles', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn1 = el()
    btn1.id = 'cumulative-btn1'
    styleRule('cumulative-btn1', 'padding-top', '24px')
    drafts.apply(btn1, 'padding-top', '24px')
    sent.add('q1', makeEntry([{ el: btn1, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }) })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(onUpdate.mock.calls.at(-1)![0]).toContain('1 implemented')

    // second batch sent + applied
    const btn2 = el()
    btn2.id = 'cumulative-btn2'
    styleRule('cumulative-btn2', 'padding-top', '24px')
    drafts.apply(btn2, 'padding-top', '24px')
    sent.add('q2', makeEntry([{ el: btn2, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'q2', status: 'applied', note: null }] }) })
    verifier.start() // idempotent restart, e.g. after reactivation
    await vi.advanceTimersByTimeAsync(2000)
    expect(onUpdate.mock.calls.at(-1)![0]).toContain('2 implemented')
  })

  it('stop() clears the interval so no further fetches occur', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const btn = el()
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, changes: [] }]))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, vi.fn())
    verifier.start()
    verifier.stop()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

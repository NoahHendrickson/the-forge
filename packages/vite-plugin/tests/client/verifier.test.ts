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
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('verifyEntry', () => {
  it('reports verified when computed style matches afterCss (live element)', () => {
    const d = el()
    d.style.setProperty('padding-top', '24px')
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
    d.style.setProperty('padding-top', '24px')
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
    d.style.setProperty('padding-top', '10px')
    const entry: SentEntry = {
      id: 'q1',
      elements: [{ el: d, dcSource: null, changes: [{ property: 'padding-top', afterCss: '24px' }] }],
    }
    const result = verifyEntry(entry)
    expect(result.verified).toBe(0)
    expect(result.mismatched).toEqual([{ property: 'padding-top', expected: '24px', actual: '10px' }])
    expect(result.missing).toBe(0)
  })

  it('re-locates a removed element via data-dc-source and verifies against the new node', () => {
    const d = el()
    d.dataset.dcSource = 'src/App.tsx:5:2'
    d.style.setProperty('padding-top', '24px')
    const entry: SentEntry = {
      id: 'q1',
      elements: [{ el: d, dcSource: 'src/App.tsx:5:2', changes: [{ property: 'padding-top', afterCss: '24px' }] }],
    }
    d.remove() // el.isConnected is now false

    const replacement = document.createElement('div')
    replacement.dataset.dcSource = 'src/App.tsx:5:2'
    replacement.style.setProperty('padding-top', '24px')
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
    drafts.apply(btn, 'padding-top', '24px') // sets inline style to 24px
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

    expect(commitSpy).toHaveBeenCalledWith(btn)
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

  it('summary counts are cumulative across multiple poll cycles', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn1 = el()
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

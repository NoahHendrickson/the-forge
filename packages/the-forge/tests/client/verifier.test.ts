// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Verifier, verifyEntry, PAUSE_AFTER_FAILURES, MAX_POLL_MS, type StageEvent } from '../../src/client/verifier'
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
      elements: [{ el: d, dcSource: 'src/App.tsx:1:1', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }],
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
      elements: [{ el: d, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '  24px  ' }] }],
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
      elements: [{ el: d, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }],
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
      elements: [{ el, dcSource: 'src/a.tsx:1:1', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '32px' }] }],
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
      elements: [{ el: d, dcSource: 'src/App.tsx:5:2', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }],
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

  // R1: verifier.locate() is now a thin delegate to lifecycle-store's canonical resolveElement
  // — proves it honors elements[].index (default 0 for legacy callers) rather than always
  // taking the first DOM match for a shared dcSource.
  it('re-locates a disconnected element to the SECOND list instance when elements[].index is 1', () => {
    const placeholder = document.createElement('li')
    placeholder.dataset.dcSource = 'src/List.tsx:4:4' // never appended — disconnected
    document.body.innerHTML = `
      <li data-dc-source="src/List.tsx:4:4" id="first"></li>
      <li data-dc-source="src/List.tsx:4:4" id="second"></li>`
    document.getElementById('second')!.id = 'second'
    styleRule('second', 'padding-top', '24px')
    const entry: SentEntry = {
      id: 'q1',
      elements: [
        {
          el: placeholder,
          dcSource: 'src/List.tsx:4:4',
          index: 1,
          draftProps: ['padding-top'],
          changes: [{ property: 'padding-top', afterCss: '24px' }],
        },
      ],
    }
    const result = verifyEntry(entry, document)
    expect(result.verified).toBe(1)
    expect(result.missing).toBe(0)
  })

  it('counts as missing when neither the live ref nor a dc-source match is found', () => {
    const d = el()
    d.dataset.dcSource = 'src/App.tsx:9:9'
    const entry: SentEntry = {
      id: 'q1',
      elements: [{ el: d, dcSource: 'src/App.tsx:9:9', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }],
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
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

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
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: [], changes: [] }]))
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
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
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

  it('commits longhand drafts when the sent change used a collapsed property', async () => {
    // The change-request builder collapses padding-top+padding-bottom into padding-block
    // for the markdown/diff shown to the agent, but the DraftStore's keys are still the
    // longhands. SentEntry now carries draftProps (the store's real keys) separately from
    // changes (the collapsed property list used for verification) — commit must use
    // draftProps, or the un-collapsed longhand ('padding-bottom' here) never gets cleared.
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    btn.id = 'collapsed-btn'
    styleRule('collapsed-btn', 'padding-top', '24px') // code now provides the drafted value for padding-top
    drafts.apply(btn, 'padding-top', '24px')
    drafts.apply(btn, 'padding-bottom', '24px')
    sent.add(
      'q1',
      makeEntry([
        {
          el: btn,
          dcSource: null,
          draftProps: ['padding-top', 'padding-bottom'],
          // verification vector uses a LONGHAND (padding-block is unsupported by
          // getComputedStyle in jsdom — it always resolves to '', which would report a
          // mismatch and never reach the commit call at all, masking the real bug).
          // Using padding-top here lets verification pass while still proving commit
          // must draw its property list from draftProps, not from `changes`.
          changes: [{ property: 'padding-top', afterCss: '24px' }],
        },
      ])
    )

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary).toContain('implemented')
    expect(drafts.hasDrafts(btn)).toBe(false)
    expect(btn.style.getPropertyValue('padding-top')).toBe('')
    expect(btn.style.getPropertyValue('padding-bottom')).toBe('')
  })

  it('on applied status with mismatched computed styles: does not commit and reports mismatch', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    drafts.apply(btn, 'padding-top', '10px') // draft applied a DIFFERENT value than what was "sent"
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
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
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

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

  it("surfaces the agent's failure note in the summary — the note field's only user-facing surface", async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: 'q1', status: 'failed', note: 'needs confirmation: shared Button component' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary).toContain('failed ✗ — needs confirmation: shared Button component')
  })

  it('aggregates distinct notes across multiple failures instead of latest-wins', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const a = el()
    const b = el()
    sent.add('q1', makeEntry([{ el: a, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    sent.add('q2', makeEntry([{ el: b, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '32px' }] }]))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: 'q1', status: 'failed', note: 'reason one' },
          { id: 'q2', status: 'failed', note: 'reason two' },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary).toContain('2 failed ✗ — reason one; reason two')
  })

  it('collapses whitespace and bounds the length of a failure note headed for the one-line summary', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

    const longNote = 'line one\nline two   with   gaps ' + 'x'.repeat(300)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'failed', note: longNote }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary).toContain('line one line two with gaps')
    expect(lastSummary).not.toContain('\n')
    // note portion is bounded at 120 chars
    const notePart = lastSummary.split('failed ✗ — ')[1]
    expect(notePart.length).toBeLessThanOrEqual(120)
  })

  it('missing elements are reported as applied (unverified), not mismatches', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn = el()
    btn.dataset.dcSource = 'src/Gone.tsx:1:1'
    sent.add('q1', makeEntry([{ el: btn, dcSource: 'src/Gone.tsx:1:1', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
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

  it('prepends a pending "applying…" segment for CLAIMED entries remaining in the sent registry', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn1 = el()
    btn1.id = 'pending-btn1'
    styleRule('pending-btn1', 'padding-top', '24px')
    drafts.apply(btn1, 'padding-top', '24px')
    sent.add('q1', makeEntry([{ el: btn1, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    // q2 is claimed — the agent has started working on it, but the server hasn't marked it done yet
    sent.add('q2', makeEntry([{ el: el(), dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '10px' }] }]))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: 'q1', status: 'applied', note: null },
          { id: 'q2', status: 'claimed', note: null },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, onUpdate)
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(sent.size()).toBe(1) // q2 still pending removal (claimed, not yet terminal)
    const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
    expect(lastSummary.startsWith('1 applying…')).toBe(true)
    expect(lastSummary).toContain('implemented')
  })

  describe('manual rung: pending (unclaimed) items show the instruction, not "applying…"', () => {
    it('renders "N queued — type /forge-design in {agent}" while a sent item is still server-side pending', async () => {
      const sent = new SentRegistry()
      const drafts = new DraftStore()
      const onUpdate = vi.fn()
      const btn = el()
      sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }),
      })
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('__THE_FORGE__', { agent: 'claude-code' })

      const verifier = new Verifier(sent, drafts, onUpdate)
      verifier.start()
      await vi.advanceTimersByTimeAsync(2000)

      expect(sent.size()).toBe(1) // still pending — not taken
      const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
      expect(lastSummary).toBe('1 queued — type /forge-design in Claude Code')
    })

    it('does NOT render "applying…" for a pending item even though sent.size() > 0', async () => {
      const sent = new SentRegistry()
      const drafts = new DraftStore()
      const onUpdate = vi.fn()
      sent.add('q1', makeEntry([{ el: el(), dcSource: null, draftProps: [], changes: [] }]))

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const verifier = new Verifier(sent, drafts, onUpdate)
      verifier.start()
      await vi.advanceTimersByTimeAsync(2000)

      const lastSummary = onUpdate.mock.calls.at(-1)![0] as string
      expect(lastSummary).not.toContain('applying…')
    })

    it('flips from the manual instruction to "1 applying…" once the item transitions to claimed', async () => {
      const sent = new SentRegistry()
      const drafts = new DraftStore()
      const onUpdate = vi.fn()
      sent.add('q1', makeEntry([{ el: el(), dcSource: null, draftProps: [], changes: [] }]))

      const fetchMock = vi.fn()
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }) })
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('__THE_FORGE__', { agent: 'cursor' })

      const verifier = new Verifier(sent, drafts, onUpdate)
      verifier.start()
      await vi.advanceTimersByTimeAsync(2000)
      expect(onUpdate.mock.calls.at(-1)![0]).toBe('1 queued — type /forge-design in Cursor')

      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'claimed', note: null }] }) })
      await vi.advanceTimersByTimeAsync(2000)
      expect(onUpdate.mock.calls.at(-1)![0].startsWith('1 applying…')).toBe(true)
    })

    it('defaults the agent display name to Claude Code when __THE_FORGE__.agent is unset', async () => {
      const sent = new SentRegistry()
      const drafts = new DraftStore()
      const onUpdate = vi.fn()
      sent.add('q1', makeEntry([{ el: el(), dcSource: null, draftProps: [], changes: [] }]))

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const verifier = new Verifier(sent, drafts, onUpdate)
      verifier.start()
      await vi.advanceTimersByTimeAsync(2000)

      expect(onUpdate.mock.calls.at(-1)![0]).toBe('1 queued — type /forge-design in Claude Code')
    })

    it('maps codex agent to the "Codex" display name in the instruction', async () => {
      const sent = new SentRegistry()
      const drafts = new DraftStore()
      const onUpdate = vi.fn()
      sent.add('q1', makeEntry([{ el: el(), dcSource: null, draftProps: [], changes: [] }]))

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }),
      })
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('__THE_FORGE__', { agent: 'codex' })

      const verifier = new Verifier(sent, drafts, onUpdate)
      verifier.start()
      await vi.advanceTimersByTimeAsync(2000)

      expect(onUpdate.mock.calls.at(-1)![0]).toBe('1 queued — type /forge-design in Codex')
    })
  })

  describe('watcher-aware pending copy (watch mode)', () => {
    function pendingVerifier(watcher: unknown) {
      const sent = new SentRegistry()
      const drafts = new DraftStore()
      const onUpdate = vi.fn()
      sent.add('q1', makeEntry([{ el: el(), dcSource: null, draftProps: [], changes: [] }]))
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }], watcher }),
      })
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('__THE_FORGE__', { agent: 'claude-code' })
      const verifier = new Verifier(sent, drafts, onUpdate)
      verifier.start()
      return onUpdate
    }

    it('live watcher: pending items read as delivering, never an instruction to type anything', async () => {
      const onUpdate = pendingVerifier('live')
      await vi.advanceTimersByTimeAsync(2000)
      expect(onUpdate.mock.calls.at(-1)![0]).toBe('1 queued — delivering to your Claude Code session…')
    })

    it('asleep watcher: pending items read as the wake instruction (/forge-watch, not /forge-design)', async () => {
      const onUpdate = pendingVerifier('asleep')
      await vi.advanceTimersByTimeAsync(2000)
      expect(onUpdate.mock.calls.at(-1)![0]).toBe('1 queued — watcher asleep, type /forge-watch in Claude Code to wake it')
    })

    it('no watcher field (older server) or unrecognized value: pre-watch-mode copy verbatim', async () => {
      const onUpdate = pendingVerifier(undefined)
      await vi.advanceTimersByTimeAsync(2000)
      expect(onUpdate.mock.calls.at(-1)![0]).toBe('1 queued — type /forge-design in Claude Code')

      const onUpdate2 = pendingVerifier('something-new')
      await vi.advanceTimersByTimeAsync(2000)
      expect(onUpdate2.mock.calls.at(-1)![0]).toBe('1 queued — type /forge-design in Claude Code')
    })
  })

  it('summary counts are cumulative across multiple poll cycles', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const onUpdate = vi.fn()
    const btn1 = el()
    btn1.id = 'cumulative-btn1'
    styleRule('cumulative-btn1', 'padding-top', '24px')
    drafts.apply(btn1, 'padding-top', '24px')
    sent.add('q1', makeEntry([{ el: btn1, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))

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
    sent.add('q2', makeEntry([{ el: btn2, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'q2', status: 'applied', note: null }] }) })
    verifier.start() // idempotent restart, e.g. after reactivation
    await vi.advanceTimersByTimeAsync(2000)
    expect(onUpdate.mock.calls.at(-1)![0]).toContain('2 implemented')
  })

  it('stop() clears the interval so no further fetches occur', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const btn = el()
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: [], changes: [] }]))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, vi.fn())
    verifier.start()
    verifier.stop()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('backs off after 5 consecutive failed polls and surfaces a paused message', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const updates: string[] = []
    const d = el()
    sent.add('q1', makeEntry([{ el: d, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const verifier = new Verifier(sent, drafts, (s) => updates.push(s))
    verifier.start()

    // failures 1-4: silent retries at the base 2s cadence, no paused message
    await vi.advanceTimersByTimeAsync(8000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(updates).toEqual([])

    // failure 5: paused message surfaces, delay doubles to 4s
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(updates).toEqual(['verification paused — dev server unreachable'])

    // only 2s later: nothing (backoff in effect) …
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    // … but at 4s the next (6th) poll fires and the delay doubles again to 8s
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('stop() then start() while a poll is in flight does not double-schedule', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const btn = el()
    sent.add('q1', makeEntry([{ el: btn, dcSource: null, draftProps: [], changes: [] }]))

    let resolveFetch!: (v: unknown) => void
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const verifier = new Verifier(sent, drafts, vi.fn())
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000) // first poll fires; its fetch is still in flight
    expect(fetchMock).toHaveBeenCalledTimes(1)

    verifier.stop()
    verifier.start() // schedules a fresh chain while the old poll's fetch is still pending

    // settle the stale poll's fetch — its .finally must NOT chain a second timer
    resolveFetch({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }) })
    await vi.advanceTimersByTimeAsync(0) // flush microtasks

    // one base interval later exactly ONE poll fires (a double-schedule would give two)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a successful poll resets the failure counter and restores the 2s cadence', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const updates: string[] = []
    const d = el()
    sent.add(
      'q1',
      makeEntry([{ el: d, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }])
    )
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('down'))
      .mockRejectedValueOnce(new TypeError('down'))
      .mockRejectedValueOnce(new TypeError('down'))
      .mockRejectedValueOnce(new TypeError('down'))
      .mockRejectedValueOnce(new TypeError('down'))
      .mockResolvedValue({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }) })
    vi.stubGlobal('fetch', fetchMock)
    const verifier = new Verifier(sent, drafts, (s) => updates.push(s))
    verifier.start()

    await vi.advanceTimersByTimeAsync(10_000) // 5 failures → paused, delay 4s
    expect(updates).toContain('verification paused — dev server unreachable')
    await vi.advanceTimersByTimeAsync(4000) // 6th poll succeeds → reset
    const afterSuccess = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000) // base cadence restored
    expect(fetchMock.mock.calls.length).toBe(afterSuccess + 1)
  })

  it('counts non-ok HTTP responses toward the backoff (server responding but erroring)', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const updates: string[] = []
    const d = el()
    sent.add('q1', makeEntry([{ el: d, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)
    const verifier = new Verifier(sent, drafts, (s) => updates.push(s))
    verifier.start()

    // failures 1-4: silent — an erroring server must not keep re-rendering a fresh summary
    await vi.advanceTimersByTimeAsync(2000 * (PAUSE_AFTER_FAILURES - 1))
    expect(fetchMock).toHaveBeenCalledTimes(PAUSE_AFTER_FAILURES - 1)
    expect(updates).toEqual([])

    // failure 5: the not-responding message (the server IS reachable, so not "unreachable")
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(PAUSE_AFTER_FAILURES)
    expect(updates).toEqual(['verification paused — dev server not responding'])

    // backoff engaged: 2s later nothing, 4s later the next poll
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(PAUSE_AFTER_FAILURES)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(PAUSE_AFTER_FAILURES + 1)
  })

  it('the backoff delay doubles only up to the MAX_POLL_MS ceiling', async () => {
    const sent = new SentRegistry()
    const drafts = new DraftStore()
    const d = el()
    sent.add('q1', makeEntry([{ el: d, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }]))
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const verifier = new Verifier(sent, drafts, vi.fn())
    verifier.start()

    // failures 1-5 at the base cadence, then the delay doubles: 4s, 8s, 16s…
    await vi.advanceTimersByTimeAsync(2000 * PAUSE_AFTER_FAILURES)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(4000)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(8000)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    // failure 8 would double 16s → 32s without the cap; with it, poll 9 fires at exactly MAX_POLL_MS
    await vi.advanceTimersByTimeAsync(MAX_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(9)
    // and stays saturated at the ceiling thereafter
    await vi.advanceTimersByTimeAsync(MAX_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(10)
  })
})

describe('stage events', () => {
  function twoElEntry(sent: SentRegistry): { a: HTMLElement; b: HTMLElement } {
    const a = el()
    a.id = 'ev-a'
    const b = el()
    b.id = 'ev-b'
    sent.add('q1', [
      { el: a, dcSource: 'a.tsx:1:1', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] },
      { el: b, dcSource: 'b.tsx:2:2', draftProps: ['margin-top'], changes: [{ property: 'margin-top', afterCss: '8px' }] },
    ])
    return { a, b }
  }

  it('emits sent/applying per element from the poll', async () => {
    const sent = new SentRegistry()
    twoElEntry(sent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'claimed', note: null }] }),
    }))
    const verifier = new Verifier(sent, new DraftStore(), vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events).toEqual([
      { requestId: 'q1', elIndex: 0, dcSource: 'a.tsx:1:1', stage: 'applying' },
      { requestId: 'q1', elIndex: 1, dcSource: 'b.tsx:2:2', stage: 'applying' },
    ])
    verifier.stop()
  })

  it('emits pending items as sent, not applying', async () => {
    const sent = new SentRegistry()
    twoElEntry(sent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }),
    }))
    const verifier = new Verifier(sent, new DraftStore(), vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events.map((e) => e.stage)).toEqual(['sent', 'sent'])
    verifier.stop()
  })

  it('emits done and mismatch per element on applied', async () => {
    const sent = new SentRegistry()
    const { a } = twoElEntry(sent)
    styleRule('ev-a', 'padding-top', '24px') // a verifies; b (no rule) mismatches
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    }))
    const drafts = new DraftStore()
    const verifier = new Verifier(sent, drafts, vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    const byIndex = new Map(events.map((e) => [e.elIndex, e]))
    expect(byIndex.get(0)?.stage).toBe('done')
    expect(byIndex.get(1)?.stage).toBe('mismatch')
    expect(byIndex.get(1)?.mismatches).toEqual([{ property: 'margin-top', expected: '8px', actual: '' }])
    expect(a.isConnected).toBe(true)
    verifier.stop()
  })

  it('emits unverified for an element that cannot be located', async () => {
    const sent = new SentRegistry()
    const gone = document.createElement('div') // never attached, no matching dcSource in DOM
    sent.add('q1', [{ el: gone, dcSource: 'gone.tsx:9:9', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    }))
    const verifier = new Verifier(sent, new DraftStore(), vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events).toEqual([{ requestId: 'q1', elIndex: 0, dcSource: 'gone.tsx:9:9', stage: 'unverified' }])
    verifier.stop()
  })

  it('emits failed with the cleaned note for every element', async () => {
    const sent = new SentRegistry()
    twoElEntry(sent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'failed', note: '  needs   confirmation: shared\ncomponent  ' }] }),
    }))
    const verifier = new Verifier(sent, new DraftStore(), vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events.map((e) => e.stage)).toEqual(['failed', 'failed'])
    expect(events[0].note).toBe('needs confirmation: shared component')
    verifier.stop()
  })
})

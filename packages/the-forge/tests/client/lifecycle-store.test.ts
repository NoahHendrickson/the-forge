// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  LIFECYCLE_KEY,
  saveLifecycle,
  loadLifecycle,
  sourceIndex,
  locateBySource,
  resolveElement,
  type PersistedLifecycle,
} from '../../src/client/lifecycle-store'
import type { TaggedElement } from '../../src/client/source'

function state(overrides: Partial<PersistedLifecycle> = {}): PersistedLifecycle {
  return { v: 1, designModeOn: true, selection: [], drafts: [], sent: [], ...overrides }
}

beforeEach(() => {
  sessionStorage.clear()
  document.body.innerHTML = ''
})

describe('save/load round-trip', () => {
  it('round-trips a full state', () => {
    const s = state({
      selection: [{ dcSource: 'a.tsx:1:1', index: 0 }],
      drafts: [{ dcSource: 'a.tsx:1:1', index: 0, props: [['padding-top', '24px']] }],
      sent: [
        {
          id: 'q1',
          elements: [
            {
              dcSource: 'a.tsx:1:1',
              index: 0,
              tag: 'div',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: {
                tag: 'div',
                source: { file: 'a.tsx', line: 1, col: 1 },
                className: 'p-2',
                text: '',
                selector: 'div',
                changes: [
                  { property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: 'pt-2', afterUtility: 'pt-6', tokenExact: true },
                ],
              },
            },
          ],
        },
      ],
    })
    saveLifecycle(s)
    expect(loadLifecycle()).toEqual(s)
  })

  it('returns null when nothing is stored', () => {
    expect(loadLifecycle()).toBeNull()
  })

  it('returns null on corrupt JSON without throwing', () => {
    sessionStorage.setItem(LIFECYCLE_KEY, '{not json')
    expect(loadLifecycle()).toBeNull()
  })

  it('returns null on a wrong version or shape', () => {
    sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify({ v: 99, designModeOn: true }))
    expect(loadLifecycle()).toBeNull()
    sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify({ v: 1, designModeOn: 'yes' }))
    expect(loadLifecycle()).toBeNull()
    sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify({ v: 1, designModeOn: true, selection: 'nope', drafts: [], sent: [] }))
    expect(loadLifecycle()).toBeNull()
  })

  it('save never throws when storage is unavailable', () => {
    const broken = { setItem: () => { throw new Error('quota') } } as unknown as Storage
    expect(() => saveLifecycle(state(), broken)).not.toThrow()
  })
})

describe('sourceIndex / locateBySource', () => {
  it('disambiguates list items sharing one dcSource by DOM order', () => {
    document.body.innerHTML = `
      <li data-dc-source="li.tsx:5:5" id="first"></li>
      <li data-dc-source="li.tsx:5:5" id="second"></li>`
    const second = document.getElementById('second')!
    expect(sourceIndex(second, 'li.tsx:5:5')).toBe(1)
    expect(locateBySource('li.tsx:5:5', 1)?.id).toBe('second')
    expect(locateBySource('li.tsx:5:5', 0)?.id).toBe('first')
  })

  it('falls back to the first match when the saved index no longer exists', () => {
    document.body.innerHTML = `<li data-dc-source="li.tsx:5:5" id="only"></li>`
    expect(locateBySource('li.tsx:5:5', 7)?.id).toBe('only')
  })

  it('returns null when no element carries the source', () => {
    expect(locateBySource('gone.tsx:1:1', 0)).toBeNull()
  })
})

describe('resolveElement — THE canonical resolver', () => {
  it('a connected el wins, even when dcSource/index would resolve elsewhere', () => {
    document.body.innerHTML = `<li data-dc-source="li.tsx:5:5" id="first"></li>`
    const connected = document.getElementById('first') as unknown as TaggedElement
    expect(resolveElement(connected, 'li.tsx:5:5', 0)).toBe(connected)
  })

  it('falls back to locateBySource(dcSource, index) when el is null', () => {
    document.body.innerHTML = `
      <li data-dc-source="li.tsx:5:5" id="first"></li>
      <li data-dc-source="li.tsx:5:5" id="second"></li>`
    const resolved = resolveElement(null, 'li.tsx:5:5', 1)
    expect(resolved?.id).toBe('second')
  })

  it('falls back to locateBySource when el is disconnected', () => {
    document.body.innerHTML = `<li data-dc-source="li.tsx:5:5" id="only"></li>`
    const detached = document.createElement('li') as unknown as TaggedElement // never appended
    expect(resolveElement(detached, 'li.tsx:5:5', 0)?.id).toBe('only')
  })

  it('locateBySource falls back to the first match when index is out of range', () => {
    document.body.innerHTML = `<li data-dc-source="li.tsx:5:5" id="only"></li>`
    const detached = document.createElement('li') as unknown as TaggedElement
    expect(resolveElement(detached, 'li.tsx:5:5', 7)?.id).toBe('only')
  })

  it('returns null when el is disconnected/null and dcSource is null', () => {
    const detached = document.createElement('li') as unknown as TaggedElement
    expect(resolveElement(detached, null, 0)).toBeNull()
    expect(resolveElement(null, null, 0)).toBeNull()
  })

  it('returns null when el is disconnected and dcSource matches nothing in the doc', () => {
    const detached = document.createElement('li') as unknown as TaggedElement
    expect(resolveElement(detached, 'gone.tsx:1:1', 0)).toBeNull()
  })
})

describe('loadLifecycle — per-item boundary validation', () => {
  function validSentElement() {
    return {
      dcSource: 'a.tsx:1:1',
      index: 0,
      tag: 'div',
      draftProps: ['padding-top'],
      changes: [{ property: 'padding-top', afterCss: '24px' }],
      change: {
        tag: 'div',
        source: { file: 'a.tsx', line: 1, col: 1 },
        className: 'p-2',
        text: '',
        selector: 'div',
        changes: [
          { property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: 'pt-2', afterUtility: 'pt-6', tokenExact: true },
        ],
      },
    }
  }

  it('drops a corrupt sent[0] but keeps a valid sent[1] and valid drafts', () => {
    const corruptSentEntry = { id: 'q0', elements: [{ dcSource: 'a.tsx:1:1' /* missing index/tag/etc */ }] }
    const validSentEntry = { id: 'q1', elements: [validSentElement()] }
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({
        v: 1,
        designModeOn: true,
        selection: [{ dcSource: 'a.tsx:1:1', index: 0 }],
        drafts: [{ dcSource: 'a.tsx:1:1', index: 0, props: [['padding-top', '24px']] }],
        sent: [corruptSentEntry, validSentEntry],
      })
    )
    const loaded = loadLifecycle()
    expect(loaded).not.toBeNull()
    expect(loaded!.sent).toHaveLength(1)
    expect(loaded!.sent[0].id).toBe('q1')
    expect(loaded!.drafts).toHaveLength(1)
  })

  it('drops an invalid drafts entry (wrong prop types) while keeping a valid one', () => {
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({
        v: 1,
        designModeOn: true,
        selection: [],
        drafts: [
          { dcSource: 'bad.tsx:1:1', index: 'not-a-number', props: [] },
          { dcSource: 'good.tsx:1:1', index: 0, props: [['padding-top', '24px']] },
        ],
        sent: [],
      })
    )
    const loaded = loadLifecycle()
    expect(loaded!.drafts).toEqual([{ dcSource: 'good.tsx:1:1', index: 0, props: [['padding-top', '24px']] }])
  })

  it('drops an invalid selection entry while keeping a valid one', () => {
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({
        v: 1,
        designModeOn: true,
        selection: [{ dcSource: 123, index: 0 }, { dcSource: 'good.tsx:1:1', index: 0 }],
        drafts: [],
        sent: [],
      })
    )
    const loaded = loadLifecycle()
    expect(loaded!.selection).toEqual([{ dcSource: 'good.tsx:1:1', index: 0 }])
  })

  it('drops a sent element whose change.ops carries a malformed or unknown op (PR #44 review)', () => {
    // ops fields are METHOD-CALLED on restore (summarizeOp's op.after.replace, the verifier's
    // op.after.slice) — a truncated op crashed the whole restored session before validation.
    const missingAfter = { ...validSentElement(), change: { ...validSentElement().change, ops: [{ kind: 'text' }] } }
    const unknownKind = { ...validSentElement(), change: { ...validSentElement().change, ops: [{ kind: 'move', toIndex: 2 }] } }
    const validOps = { ...validSentElement(), change: { ...validSentElement().change, ops: [{ kind: 'text', before: 'Old', after: 'New' }] } }
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({
        v: 1,
        designModeOn: true,
        selection: [],
        drafts: [],
        sent: [{ id: 'q1', elements: [missingAfter, unknownKind, validOps] }],
      })
    )
    const loaded = loadLifecycle()
    expect(loaded!.sent).toHaveLength(1)
    expect(loaded!.sent[0].elements).toHaveLength(1)
    expect(loaded!.sent[0].elements[0].change.ops).toEqual([{ kind: 'text', before: 'Old', after: 'New' }])
  })

  it('keeps a sent element with no ops field at all (pre-P1 persisted state)', () => {
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({ v: 1, designModeOn: true, selection: [], drafts: [], sent: [{ id: 'q1', elements: [validSentElement()] }] })
    )
    expect(loadLifecycle()!.sent[0].elements).toHaveLength(1)
  })

  it('drops a sent element with a change missing its changes array', () => {
    const badElement = { ...validSentElement(), change: { ...validSentElement().change, changes: 'nope' } }
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({
        v: 1,
        designModeOn: true,
        selection: [],
        drafts: [],
        sent: [{ id: 'q1', elements: [badElement, validSentElement()] }],
      })
    )
    const loaded = loadLifecycle()
    expect(loaded!.sent).toHaveLength(1)
    expect(loaded!.sent[0].elements).toHaveLength(1)
  })

  it('drops a whole sent entry only when it has zero valid elements left', () => {
    const badElement = { dcSource: 'a.tsx:1:1' }
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({
        v: 1,
        designModeOn: true,
        selection: [],
        drafts: [],
        sent: [{ id: 'q0', elements: [badElement] }],
      })
    )
    const loaded = loadLifecycle()
    expect(loaded!.sent).toHaveLength(0)
  })

  it('keeps a sent element for an untagged element (source: null, dcSource: null)', () => {
    // Elements with no data-dc-source tag persist ElementChange.source as null (request.ts's
    // ElementChange.source is SourceLocation | null, and renderMarkdown already handles the null
    // case by falling back to selector/text) — the restore validator must accept that shape
    // rather than silently dropping the whole entry.
    const untagged = {
      ...validSentElement(),
      dcSource: null,
      change: { ...validSentElement().change, source: null },
    }
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({
        v: 1,
        designModeOn: true,
        selection: [],
        drafts: [],
        sent: [{ id: 'q1', elements: [untagged] }],
      })
    )
    const loaded = loadLifecycle()
    expect(loaded).not.toBeNull()
    expect(loaded!.sent).toHaveLength(1)
    expect(loaded!.sent[0].elements).toHaveLength(1)
    expect(loaded!.sent[0].elements[0].dcSource).toBeNull()
    expect(loaded!.sent[0].elements[0].change.source).toBeNull()
  })

  it('drops retired prompt-send elements (pre-consolidation persisted state) without touching the rest', () => {
    // kind:'prompt' sends died with the composer consolidation — a persisted element carrying
    // `prompt` must be dropped at the load boundary (not restored as a blank no-op row), while
    // sibling draft-send entries in the same snapshot survive.
    const base = validSentElement()
    sessionStorage.setItem(
      LIFECYCLE_KEY,
      JSON.stringify({
        v: 1,
        designModeOn: true,
        selection: [],
        drafts: [],
        sent: [
          { id: 'legacy-prompt', elements: [{ ...base, prompt: 'hi' }] },
          { id: 'still-good', elements: [base] },
        ],
      })
    )
    const loaded = loadLifecycle()!
    expect(loaded.sent).toHaveLength(1)
    expect(loaded.sent[0].id).toBe('still-good')
  })
})

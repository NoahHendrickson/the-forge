// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { LifecycleSession, type SentSeed } from '../../src/client/lifecycle'
import type { ElementChange } from '../../src/client/request'
import { locateBySource } from '../../src/client/lifecycle-store'

function el(tag = 'div'): HTMLElement {
  const d = document.createElement(tag)
  document.body.appendChild(d)
  return d
}

function elementChange(overrides: Partial<ElementChange> = {}): ElementChange {
  return {
    tag: 'div',
    source: { file: 'src/App.tsx', line: 1, col: 1 },
    className: '',
    text: '',
    selector: 'div',
    changes: [{ property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: null, afterUtility: 'pt-6', tokenExact: true }],
    ...overrides,
  }
}

function seed(target: HTMLElement, overrides: Partial<SentSeed> = {}): SentSeed {
  return {
    el: target as never,
    dcSource: target.dataset.dcSource ?? null,
    index: 0,
    draftProps: ['padding-top'],
    change: elementChange(),
    ...overrides,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('LifecycleSession: register/pendingIds/take/size round-trip', () => {
  it('register -> rows/pendingIds/persisted projection agree from ONE mutation', () => {
    const session = new LifecycleSession()
    expect(session.size()).toBe(0)
    const btn = el('button')
    btn.dataset.dcSource = 'src/App.tsx:7:9'
    const s = seed(btn, { dcSource: 'src/App.tsx:7:9' })
    session.register('q1', [s])

    expect(session.size()).toBe(1)
    expect(session.pendingIds()).toEqual(['q1'])
    expect(session.records()).toHaveLength(1)
    expect(session.records()[0].stage).toBe('sent')
    expect(session.records()[0].seed).toBe(s)

    const persisted = session.toPersistedSent()
    expect(persisted).toEqual([
      {
        id: 'q1',
        elements: [
          {
            dcSource: 'src/App.tsx:7:9',
            index: 0,
            tag: 'div',
            draftProps: ['padding-top'],
            changes: [{ property: 'padding-top', afterCss: '24px' }],
            change: s.change,
          },
        ],
      },
    ])
  })

  it('take on an unknown id returns undefined', () => {
    const session = new LifecycleSession()
    expect(session.take('missing')).toBeUndefined()
  })

  it('tracks multiple pending ids independently', () => {
    const session = new LifecycleSession()
    session.register('a', [])
    session.register('b', [])
    expect(session.size()).toBe(2)
    expect(session.pendingIds().sort()).toEqual(['a', 'b'])
    session.take('a')
    expect(session.pendingIds()).toEqual(['b'])
  })

  it('records dcSource as null when the element has no data-dc-source', () => {
    const session = new LifecycleSession()
    const plain = el()
    session.register('q2', [seed(plain, { dcSource: null })])
    const entry = session.take('q2')!
    expect(entry.elements[0].dcSource).toBeNull()
  })

  describe('get', () => {
    it('returns the entry without removing it', () => {
      const session = new LifecycleSession()
      const btn = el()
      session.register('q1', [seed(btn, { dcSource: 'a.tsx:1:1' })])
      expect(session.get('q1')?.id).toBe('q1')
      expect(session.size()).toBe(1)
      expect(session.get('missing')).toBeUndefined()
    })
  })
})

describe('LifecycleSession: take() removes from all views atomically', () => {
  it('take() clears pendingIds, records(), and get() together', () => {
    const session = new LifecycleSession()
    const btn = el()
    session.register('q1', [seed(btn)])
    expect(session.records()).toHaveLength(1)

    const entry = session.take('q1')
    expect(entry).toBeDefined()
    expect(session.size()).toBe(0)
    expect(session.pendingIds()).toEqual([])
    expect(session.records()).toHaveLength(0)
    expect(session.get('q1')).toBeUndefined()
    expect(session.take('q1')).toBeUndefined()
  })
})

describe('LifecycleSession: applyStage', () => {
  it('flips stage exactly once (idempotent) and the projection reflects it', () => {
    const session = new LifecycleSession()
    const btn = el()
    session.register('q1', [seed(btn, { dcSource: 'src/App.tsx:7:9' })])

    expect(session.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:7:9', stage: 'applying' })).toBe(true)
    expect(session.records()[0].stage).toBe('applying')

    // poll re-emission of the SAME stage is a no-op
    expect(session.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:7:9', stage: 'applying' })).toBe(false)
    expect(session.records()[0].stage).toBe('applying')
  })

  it('is guarded once terminal — a late poll event cannot regress it', () => {
    const session = new LifecycleSession()
    const btn = el()
    session.register('q1', [seed(btn)])
    expect(session.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'done' })).toBe(true)
    expect(session.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'sent' })).toBe(false)
    expect(session.records()[0].stage).toBe('done')
  })

  it('ignores events for unknown rows', () => {
    const session = new LifecycleSession()
    expect(session.applyStage({ requestId: 'zzz', elIndex: 3, dcSource: null, stage: 'done' })).toBe(false)
  })

  it('carries note and mismatches into the record', () => {
    const session = new LifecycleSession()
    const btn = el()
    session.register('q1', [seed(btn)])
    session.applyStage({
      requestId: 'q1',
      elIndex: 0,
      dcSource: null,
      stage: 'mismatch',
      mismatches: [{ property: 'padding-top', expected: '24px', actual: '10px' }],
    })
    expect(session.records()[0].mismatches).toEqual([{ property: 'padding-top', expected: '24px', actual: '10px' }])
  })
})

describe('LifecycleSession: clearResolved / removeSeed / clear', () => {
  it('clearResolved removes done/unverified rows, keeps failed/mismatch', () => {
    const session = new LifecycleSession()
    session.register('q1', [seed(el('a')), seed(el('b')), seed(el('c')), seed(el('d'))])
    session.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'done' })
    session.applyStage({ requestId: 'q1', elIndex: 1, dcSource: null, stage: 'unverified' })
    session.applyStage({ requestId: 'q1', elIndex: 2, dcSource: null, stage: 'failed' })
    session.applyStage({ requestId: 'q1', elIndex: 3, dcSource: null, stage: 'mismatch' })
    session.clearResolved()
    const stages = session.records().map((r) => r.stage)
    expect(stages.sort()).toEqual(['failed', 'mismatch'])
  })

  it('removeSeed removes exactly the matching seed by identity', () => {
    const session = new LifecycleSession()
    const s1 = seed(el())
    const s2 = seed(el())
    session.register('q1', [s1, s2])
    session.removeSeed(s1)
    const remaining = session.records().map((r) => r.seed)
    expect(remaining).toEqual([s2])
  })

  it('clear() empties everything', () => {
    const session = new LifecycleSession()
    session.register('q1', [seed(el())])
    session.register('q2', [seed(el())])
    session.clear()
    expect(session.size()).toBe(0)
    expect(session.records()).toHaveLength(0)
    expect(session.pendingIds()).toEqual([])
  })
})

describe('LifecycleSession: restore round-trip incl. placeholder + heal', () => {
  it('restoreSent rebuilds entries and toPersistedSent round-trips them', () => {
    document.body.innerHTML = `<div data-dc-source="src/App.tsx:3:3" id="target"></div>`
    const session = new LifecycleSession()
    session.restoreSent(
      [
        {
          id: 'q1',
          elements: [
            {
              dcSource: 'src/App.tsx:3:3',
              index: 0,
              tag: 'div',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: elementChange({ source: { file: 'src/App.tsx', line: 3, col: 3 } }),
            },
          ],
        },
      ],
      locateBySource
    )
    expect(session.size()).toBe(1)
    const target = document.getElementById('target')!
    expect(session.records()[0].seed.el).toBe(target) // located, not a placeholder

    const persisted = session.toPersistedSent()
    expect(persisted[0].elements[0].dcSource).toBe('src/App.tsx:3:3')
    expect(persisted[0].elements[0].index).toBe(0)
  })

  it('gives an unlocatable element a detached placeholder, not a crash', () => {
    const session = new LifecycleSession()
    session.restoreSent(
      [
        {
          id: 'q1',
          elements: [
            {
              dcSource: 'gone.tsx:1:1',
              index: 0,
              tag: 'span',
              draftProps: [],
              changes: [{ property: 'color', afterCss: 'rgb(0, 0, 0)' }],
              change: elementChange({ tag: 'span', source: { file: 'gone.tsx', line: 1, col: 1 } }),
            },
          ],
        },
      ],
      locateBySource
    )
    const placeholderEl = session.records()[0].seed.el
    expect(placeholderEl.isConnected).toBe(false)
    expect(placeholderEl.tagName.toLowerCase()).toBe('span')
  })

  it('healPlaceholders heals a detached placeholder to the real element once it renders', () => {
    const dcSource = 'src/App.tsx:9:1'
    const session = new LifecycleSession()
    session.restoreSent(
      [
        {
          id: 'q1',
          elements: [
            {
              dcSource,
              index: 0,
              tag: 'h1',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: elementChange({ tag: 'h1', source: { file: 'src/App.tsx', line: 9, col: 1 } }),
            },
          ],
        },
      ],
      locateBySource
    )
    const placeholderEl = session.records()[0].seed.el
    expect(placeholderEl.isConnected).toBe(false)

    // The framework mounts the real, tagged element after the fact.
    const real = document.createElement('h1')
    real.dataset.dcSource = dcSource
    document.body.appendChild(real)

    session.healPlaceholders()
    expect(session.records()[0].seed.el).toBe(real)
  })

  it('heals to the SECOND list instance when the seed carries index: 1', () => {
    const dcSource = 'src/List.tsx:4:4'
    const session = new LifecycleSession()
    session.restoreSent(
      [
        {
          id: 'q1',
          elements: [
            {
              dcSource,
              index: 1,
              tag: 'li',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: elementChange({ tag: 'li', source: { file: 'src/List.tsx', line: 4, col: 4 } }),
            },
          ],
        },
      ],
      locateBySource
    )
    document.body.innerHTML = `
      <li data-dc-source="${dcSource}" id="first"></li>
      <li data-dc-source="${dcSource}" id="second"></li>`
    session.healPlaceholders()
    expect((session.records()[0].seed.el as unknown as HTMLElement).id).toBe('second')
  })
})

// Ported verbatim from the deleted tests/client/sent.test.ts — SentRegistry.isDuplicate moved
// to LifecycleSession.isDuplicate with identical semantics, including the dcSource-fallback for
// disconnected (restored placeholder) entries.
describe('LifecycleSession: isDuplicate (double-Send guard, ported from sent.test.ts)', () => {
  const CHANGES = [{ property: 'padding-top', afterCss: '24px' }]

  function addInFlight(session: LifecycleSession, element: HTMLElement, changes = CHANGES): void {
    session.register('q1', [
      {
        el: element as never,
        dcSource: null,
        index: 0,
        draftProps: ['padding-top'],
        change: elementChange({ changes: changes.map((c) => ({ ...c, beforeCss: '', beforeUtility: null, afterUtility: null, tokenExact: false })) }),
      },
    ])
  }

  it('true for the same element with an identical change set', () => {
    const session = new LifecycleSession()
    const btn = el()
    addInFlight(session, btn)
    expect(session.isDuplicate(btn as never, [{ property: 'padding-top', afterCss: '24px' }])).toBe(true)
  })

  it('false once the entry has been taken (verified/failed) — a re-send is legitimate again', () => {
    const session = new LifecycleSession()
    const btn = el()
    addInFlight(session, btn)
    session.take('q1')
    expect(session.isDuplicate(btn as never, CHANGES)).toBe(false)
  })

  it('false when the element was re-edited to a different value — that is a new request', () => {
    const session = new LifecycleSession()
    const btn = el()
    addInFlight(session, btn)
    expect(session.isDuplicate(btn as never, [{ property: 'padding-top', afterCss: '32px' }])).toBe(false)
  })

  it('false when the new change set has extra or fewer properties', () => {
    const session = new LifecycleSession()
    const btn = el()
    addInFlight(session, btn)
    expect(
      session.isDuplicate(btn as never, [
        { property: 'padding-top', afterCss: '24px' },
        { property: 'padding-bottom', afterCss: '24px' },
      ])
    ).toBe(false)
    expect(session.isDuplicate(btn as never, [])).toBe(false)
  })

  it('false for a different element with the same change set', () => {
    const session = new LifecycleSession()
    const btn = el()
    const other = el()
    addInFlight(session, btn)
    expect(session.isDuplicate(other as never, CHANGES)).toBe(false)
  })

  it('true for a detached placeholder entry when the re-mounted real element shares its dcSource and change set', () => {
    const session = new LifecycleSession()
    const placeholder = document.createElement('div')
    placeholder.dataset.dcSource = 'a.tsx:1:1'
    // NOT appended to document.body — mirrors restoreLifecycle's detached placeholder.
    session.register('q1', [
      {
        el: placeholder as never,
        dcSource: 'a.tsx:1:1',
        index: 0,
        draftProps: ['padding-top'],
        change: elementChange({
          changes: [{ property: 'padding-top', beforeCss: '', afterCss: '24px', beforeUtility: null, afterUtility: null, tokenExact: false }],
        }),
      },
    ])
    const real = el()
    real.dataset.dcSource = 'a.tsx:1:1'
    expect(session.isDuplicate(real as never, CHANGES)).toBe(true)
  })

  it('false for a detached placeholder entry when the re-mounted real element has a different change set', () => {
    const session = new LifecycleSession()
    const placeholder = document.createElement('div')
    placeholder.dataset.dcSource = 'a.tsx:1:1'
    session.register('q1', [
      {
        el: placeholder as never,
        dcSource: 'a.tsx:1:1',
        index: 0,
        draftProps: ['padding-top'],
        change: elementChange({
          changes: [{ property: 'padding-top', beforeCss: '', afterCss: '24px', beforeUtility: null, afterUtility: null, tokenExact: false }],
        }),
      },
    ])
    const real = el()
    real.dataset.dcSource = 'a.tsx:1:1'
    expect(session.isDuplicate(real as never, [{ property: 'padding-top', afterCss: '32px' }])).toBe(false)
  })

  it('false when the registry element shares dcSource but IS connected (two live list items sharing a source)', () => {
    const session = new LifecycleSession()
    const first = el()
    first.dataset.dcSource = 'a.tsx:1:1'
    session.register('q1', [
      {
        el: first as never,
        dcSource: 'a.tsx:1:1',
        index: 0,
        draftProps: ['padding-top'],
        change: elementChange({
          changes: [{ property: 'padding-top', beforeCss: '', afterCss: '24px', beforeUtility: null, afterUtility: null, tokenExact: false }],
        }),
      },
    ])
    const second = el()
    second.dataset.dcSource = 'a.tsx:1:1'
    expect(session.isDuplicate(second as never, CHANGES)).toBe(false)
  })
})

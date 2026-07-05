// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  LIFECYCLE_KEY,
  saveLifecycle,
  loadLifecycle,
  sourceIndex,
  locateBySource,
  type PersistedLifecycle,
} from '../../src/client/lifecycle-store'

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

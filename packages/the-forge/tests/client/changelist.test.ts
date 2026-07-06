// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChangeList, type SentSeed } from '../../src/client/changelist'
import { LifecycleSession } from '../../src/client/lifecycle'
import { DraftStore } from '../../src/client/drafts'
import type { ElementChange } from '../../src/client/request'

function tagged(dcSource = 'src/App.tsx:8:11'): HTMLElement {
  const el = document.createElement('h1')
  el.setAttribute('data-dc-source', dcSource)
  document.body.appendChild(el)
  return el
}

function elementChange(overrides: Partial<ElementChange> = {}): ElementChange {
  return {
    tag: 'h1',
    source: { file: 'src/App.tsx', line: 8, col: 11 },
    className: 'pt-2',
    text: 'Vitality',
    selector: 'h1',
    changes: [
      { property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: 'pt-2', afterUtility: 'pt-6', tokenExact: true },
    ],
    ...overrides,
  }
}

function seed(el: HTMLElement, change = elementChange(), index = 0): SentSeed {
  return { el: el as never, dcSource: el.getAttribute('data-dc-source'), index, draftProps: ['padding-top'], change }
}

const noop = { onHover: vi.fn(), onSelect: vi.fn(), onResend: vi.fn() }

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('empty state', () => {
  it('is hidden with no rows', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    expect(list.root.hidden).toBe(true)
    expect(list.root.className).toBe('changes-section')
  })
})

describe('draft rows', () => {
  it('shows a draft row per drafted element after syncDrafts', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, new LifecycleSession(), noop)
    drafts.apply(el as never, 'padding-top', '24px')
    list.syncDrafts()
    expect(list.root.hidden).toBe(false)
    const rows = list.root.querySelectorAll('.change-row')
    expect(rows.length).toBe(1)
    expect(rows[0].querySelector('.chip')!.className).toContain('chip-draft')
    expect(rows[0].querySelector('.change-el')!.textContent).toContain('h1')
    expect(rows[0].querySelector('.change-summary')!.textContent).toContain('padding-top')
    expect(rows[0].querySelector('.change-summary')!.textContent).toContain('24px')
  })

  it('removes the draft row when the draft is discarded', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, new LifecycleSession(), noop)
    drafts.apply(el as never, 'padding-top', '24px')
    list.syncDrafts()
    drafts.discard(el as never)
    list.syncDrafts()
    expect(list.root.hidden).toBe(true)
  })

  it('excludes props covered by an in-flight sent row for the same element', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, new LifecycleSession(), noop)
    drafts.apply(el as never, 'padding-top', '24px')
    list.addSent('q1', [seed(el)])
    list.syncDrafts()
    // padding-top is in flight — only the sent row shows
    const chips = [...list.root.querySelectorAll('.chip')].map((c) => c.className)
    expect(chips.filter((c) => c.includes('chip-draft'))).toHaveLength(0)
    expect(chips.filter((c) => c.includes('chip-sent'))).toHaveLength(1)
    // a second, un-sent prop on the same element gets its own draft row
    drafts.apply(el as never, 'margin-top', '8px')
    list.syncDrafts()
    const draftRow = [...list.root.querySelectorAll('.change-row')].find((r) => r.querySelector('.chip-draft'))
    expect(draftRow?.querySelector('.change-summary')?.textContent).toContain('margin-top')
    expect(draftRow?.querySelector('.change-summary')?.textContent).not.toContain('padding-top')
  })

  // R2 minor: draft rows and sent rows each formatted "+N more" independently — extracted to one
  // shared helper. This proves a multi-prop draft row uses the SAME "+N more" shape as the
  // multi-change sent row test above ('summarizes multi-change elements with +N more').
  it('summarizes a multi-prop draft row with +N more, same shape as sent rows', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, new LifecycleSession(), noop)
    drafts.apply(el as never, 'padding-top', '24px')
    drafts.apply(el as never, 'margin-top', '8px')
    list.syncDrafts()
    const summary = list.root.querySelector('.change-summary')!
    expect(summary.textContent).toBe('padding-top → 24px +1 more')
  })
})

describe('sent rows and stages', () => {
  it('renders sent rows with token-vocabulary summaries', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [seed(tagged())])
    const row = list.root.querySelector('.change-row')!
    expect(row.querySelector('.chip')!.className).toContain('chip-sent')
    expect(row.querySelector('.change-summary')!.textContent).toBe('pt-2 → pt-6')
    expect(row.querySelector('.change-el')!.textContent).toBe('h1 · App.tsx:8')
  })

  it('summarizes multi-change elements with +N more', () => {
    const change = elementChange({
      changes: [
        { property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: 'pt-2', afterUtility: 'pt-6', tokenExact: true },
        { property: 'margin-top', beforeCss: '0px', afterCss: '8px', beforeUtility: null, afterUtility: 'mt-2', tokenExact: true },
      ],
    })
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [seed(tagged(), change)])
    expect(list.root.querySelector('.change-summary')!.textContent).toBe('pt-2 → pt-6 +1 more')
  })

  it('renders a prompt seed row with the prompt text as summary, truncated at 80 chars', () => {
    const long = 'p'.repeat(100)
    const change = elementChange({ changes: [] })
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [{ ...seed(tagged(), change), draftProps: [], prompt: long }])
    const summary = list.root.querySelector('.change-summary')!
    expect(summary.textContent).toBe('p'.repeat(80) + '…')
    expect(summary.getAttribute('title')).toBe(long)
  })

  it('advances stages idempotently and allows applying → sent regression', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [seed(tagged())])
    const chip = () => list.root.querySelector('.chip')!.className
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'applying' })
    expect(chip()).toContain('chip-applying')
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'applying' })
    expect(list.root.querySelectorAll('.change-row')).toHaveLength(1)
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'sent' })
    expect(chip()).toContain('chip-sent')
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'done' })
    expect(chip()).toContain('chip-done')
  })

  it('a terminal row no longer regresses on late poll events', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [seed(tagged())])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'done' })
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'sent' })
    expect(list.root.querySelector('.chip')!.className).toContain('chip-done')
  })

  it('renders the failed note', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [seed(tagged())])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'failed', note: 'needs confirmation: shared component' })
    expect(list.root.querySelector('.chip')!.className).toContain('chip-failed')
    expect(list.root.querySelector('.change-note')!.textContent).toBe('needs confirmation: shared component')
  })

  it('ignores events for unknown rows', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    expect(() => list.applyStage({ requestId: 'zzz', elIndex: 3, dcSource: null, stage: 'done' })).not.toThrow()
    expect(list.root.hidden).toBe(true)
  })

  it('clear() drops everything', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, new LifecycleSession(), noop)
    drafts.apply(el as never, 'padding-top', '24px')
    list.syncDrafts()
    list.addSent('q1', [seed(tagged('src/B.tsx:1:1'))])
    list.clear()
    expect(list.root.hidden).toBe(true)
    expect(list.root.querySelectorAll('.change-row')).toHaveLength(0)
  })
})

describe('interactions', () => {
  it('hover reports the element, mouseleave reports null', () => {
    const onHover = vi.fn()
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), { ...noop, onHover })
    const el = tagged()
    list.addSent('q1', [seed(el)])
    const row = list.root.querySelector('.change-row')!
    row.dispatchEvent(new MouseEvent('mouseenter'))
    expect(onHover).toHaveBeenLastCalledWith(el)
    row.dispatchEvent(new MouseEvent('mouseleave'))
    expect(onHover).toHaveBeenLastCalledWith(null)
  })

  it('click selects a connected element', () => {
    const onSelect = vi.fn()
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), { ...noop, onSelect })
    const el = tagged()
    list.addSent('q1', [seed(el)])
    list.root.querySelector('.change-row')!.dispatchEvent(new MouseEvent('click'))
    expect(onSelect).toHaveBeenCalledWith(el)
  })

  it('a disconnected element greys the row and never selects', () => {
    const onSelect = vi.fn()
    const onHover = vi.fn()
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), { ...noop, onSelect, onHover })
    const el = tagged()
    const s = seed(el)
    el.remove()
    list.addSent('q1', [s])
    const row = list.root.querySelector('.change-row')!
    expect(row.className).toContain('row-gone')
    row.dispatchEvent(new MouseEvent('click'))
    expect(onSelect).not.toHaveBeenCalled()
    row.dispatchEvent(new MouseEvent('mouseenter'))
    expect(onHover).toHaveBeenLastCalledWith(null)
  })

  it('Dismiss removes a failed row', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [seed(tagged())])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'failed', note: 'nope' })
    ;(list.root.querySelector('.change-dismiss') as HTMLElement).click()
    expect(list.root.hidden).toBe(true)
  })

  // Final-review F5: Re-send used to dismiss the row immediately on click, before the re-queue
  // POST resolved — a failed /queue POST then left the user with nothing but a button flash and
  // no record of the still-failed change. Row removal now moves to the resend success path
  // (index.ts's resend() calls session.removeSeed() directly right before addSent — R2 minor:
  // ChangeList no longer wraps this in its own removeRow(), since removeRow() was just a thin,
  // unused-in-production pass-through to the session method every real call site already used
  // directly); Re-send's click handler only forwards the seed and no longer dismisses.
  it('Re-send forwards the seed and keeps the row until the host confirms success', () => {
    const onResend = vi.fn()
    const session = new LifecycleSession()
    const list = new ChangeList(new DraftStore(), session, { ...noop, onResend })
    const el = tagged()
    const s = seed(el)
    list.addSent('q1', [s])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'failed' })
    ;(list.root.querySelector('.change-resend') as HTMLElement).click()
    expect(onResend).toHaveBeenCalledWith(s)
    // Row still present — removal is the HOST's job, on resend success.
    expect(list.root.hidden).toBe(false)
    expect(list.root.querySelector('.change-row')).not.toBeNull()

    // Host confirms success: it calls session.removeSeed directly right before addSent(newId, [seed]).
    session.removeSeed(s)
    expect(list.root.hidden).toBe(true)
  })

  it('a failed re-queue POST leaves the row present with its note (host never calls removeSeed)', () => {
    const onResend = vi.fn()
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), { ...noop, onResend })
    const el = tagged()
    const s = seed(el)
    list.addSent('q1', [s])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'failed', note: 'network down' })
    ;(list.root.querySelector('.change-resend') as HTMLElement).click()
    expect(onResend).toHaveBeenCalledWith(s)
    // Simulates a resend() whose /queue POST failed — the host does NOT call removeSeed.
    const row = list.root.querySelector('.change-row')!
    expect(row.querySelector('.chip')!.className).toContain('chip-failed')
    expect(row.querySelector('.change-note')!.textContent).toBe('network down')
    expect(list.root.hidden).toBe(false)
  })

  // Final-review F2: restored placeholder seeds (from restoreLifecycle, a locate() miss on
  // boot) carry a detached `document.createElement(tag)` element forever — nothing ever
  // re-locates them, so the row stays greyed even after the framework mounts the real element,
  // and inFlightProps (which dedupes by `seed.el` identity) misses because the draft's `el` and
  // the placeholder are different objects.
  it('a placeholder seed heals to the real element once it renders, un-greying the row', () => {
    const dcSource = 'src/App.tsx:9:1'
    const placeholder = document.createElement('h1') as unknown as never // detached — never appended
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    const placeholderSeed: SentSeed = {
      el: placeholder,
      dcSource,
      index: 0,
      draftProps: ['padding-top'],
      change: elementChange({ source: { file: 'src/App.tsx', line: 9, col: 1 } }),
    }
    list.addSent('q1', [placeholderSeed])
    let row = list.root.querySelector('.change-row')!
    expect(row.className).toContain('row-gone')

    // The framework mounts the real, tagged element after the fact.
    const real = tagged(dcSource)
    list.syncDrafts() // a render trigger, same as any other state change

    row = list.root.querySelector('.change-row')!
    expect(row.className).not.toContain('row-gone')
    row.dispatchEvent(new MouseEvent('click'))
    expect(placeholderSeed.el).toBe(real) // healed in place — shared by inFlightProps/persist too
  })

  // R1: seeds now carry their own instance index (no more index-0 trade-off) — healing must
  // attach the SECOND list instance, not always the first match, when the seed says index: 1.
  it('a placeholder seed heals to the SECOND list instance when its seed carries index: 1', () => {
    const dcSource = 'src/List.tsx:4:4'
    const placeholder = document.createElement('li') as unknown as never // detached
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    const placeholderSeed: SentSeed = {
      el: placeholder,
      dcSource,
      index: 1,
      draftProps: ['padding-top'],
      change: elementChange({ tag: 'li', source: { file: 'src/List.tsx', line: 4, col: 4 } }),
    }
    list.addSent('q1', [placeholderSeed])

    // Two live instances share dcSource — the SECOND (DOM order) is the one this seed refers to.
    document.body.innerHTML = `
      <li data-dc-source="${dcSource}" id="first"></li>
      <li data-dc-source="${dcSource}" id="second"></li>`
    list.syncDrafts()

    expect((placeholderSeed.el as unknown as HTMLElement).id).toBe('second')
  })

  it('healing a placeholder seed excludes the draft row for the same now-located element (no duplicate)', () => {
    const dcSource = 'src/App.tsx:9:1'
    const placeholder = document.createElement('h1') as unknown as never
    const drafts = new DraftStore()
    const list = new ChangeList(drafts, new LifecycleSession(), noop)
    const placeholderSeed: SentSeed = {
      el: placeholder,
      dcSource,
      index: 0,
      draftProps: ['padding-top'],
      change: elementChange({ source: { file: 'src/App.tsx', line: 9, col: 1 } }),
    }
    list.addSent('q1', [placeholderSeed])
    const real = tagged(dcSource)
    drafts.apply(real as never, 'padding-top', '24px')
    list.syncDrafts()

    // Healed: the sent row now shares `real`, so inFlightProps(real) should cover padding-top —
    // the draft row for the same prop on the same element must not also render.
    const chips = [...list.root.querySelectorAll('.chip')].map((c) => c.className)
    expect(chips.filter((c) => c.includes('chip-draft'))).toHaveLength(0)
    expect(chips.filter((c) => c.includes('chip-sent'))).toHaveLength(1)
  })

  it('Clear done removes done and unverified rows, keeps failed and mismatch', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [seed(tagged('a.tsx:1:1')), seed(tagged('b.tsx:2:2')), seed(tagged('c.tsx:3:3')), seed(tagged('d.tsx:4:4'))])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'done' })
    list.applyStage({ requestId: 'q1', elIndex: 1, dcSource: null, stage: 'unverified' })
    list.applyStage({ requestId: 'q1', elIndex: 2, dcSource: null, stage: 'failed' })
    list.applyStage({ requestId: 'q1', elIndex: 3, dcSource: null, stage: 'mismatch' })
    ;(list.root.querySelector('.changes-clear') as HTMLElement).click()
    const stages = [...list.root.querySelectorAll('.change-row')].map((r) => (r as HTMLElement).dataset.stage)
    expect(stages.sort()).toEqual(['failed', 'mismatch'])
  })

  // Regression for the resolve-in-place bug: Verifier.handleApplied/handleFailed call
  // session.take(id) FIRST, then synchronously emit the terminal StageEvent for the same id —
  // if take() deleted the record, this applyStage() would find nothing and the row would vanish
  // instead of showing its terminal chip.
  it('a row survives session.take() so a subsequent applyStage(done) still renders chip-done', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    const session = (list as unknown as { session: LifecycleSession }).session
    list.addSent('q1', [seed(tagged())])
    session.take('q1')
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'done' })

    const row = list.root.querySelector('.change-row')!
    expect(row).not.toBeNull()
    expect(row.querySelector('.chip')!.className).toContain('chip-done')

    // Clear done removes it once resolved+terminal.
    ;(list.root.querySelector('.changes-clear') as HTMLElement).click()
    expect(list.root.hidden).toBe(true)
  })

  it('the Clear done button is hidden while nothing is clearable', () => {
    const list = new ChangeList(new DraftStore(), new LifecycleSession(), noop)
    list.addSent('q1', [seed(tagged())])
    expect((list.root.querySelector('.changes-clear') as HTMLElement).hidden).toBe(true)
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'done' })
    expect((list.root.querySelector('.changes-clear') as HTMLElement).hidden).toBe(false)
  })
})

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { draftToOps, opsIdentical, TEXT_BEFORE_CAP } from '../../src/client/ops'
import type { StructuralOp } from '../../src/client/request'

describe('draftToOps — the one StructuralDraft → StructuralOp projection', () => {
  it('projects a delete draft to a bare delete op', () => {
    expect(draftToOps({ kind: 'delete', priorInlineDisplay: 'flex' })).toEqual([{ kind: 'delete' }])
  })

  it('projects a text draft with the before capped and the after exact', () => {
    const long = 'x'.repeat(TEXT_BEFORE_CAP + 50)
    expect(draftToOps({ kind: 'text', original: long, value: 'New' })).toEqual([
      { kind: 'text', before: 'x'.repeat(TEXT_BEFORE_CAP), after: 'New' },
    ])
  })
})

describe('opsIdentical — the one structural-op identity rule', () => {
  const text = (after: string, before = 'Old'): StructuralOp => ({ kind: 'text', before, after })

  it('text keys on after; before is locate-context and never affects identity', () => {
    expect(opsIdentical([text('New')], [text('New', 'Different')])).toBe(true)
    expect(opsIdentical([text('New')], [text('Newer')])).toBe(false)
  })

  it('delete matches by kind (no payload)', () => {
    expect(opsIdentical([{ kind: 'delete' }], [{ kind: 'delete' }])).toBe(true)
    expect(opsIdentical([{ kind: 'delete' }], [text('New')])).toBe(false)
  })

  it('length and undefined handling', () => {
    expect(opsIdentical(undefined, undefined)).toBe(true)
    expect(opsIdentical(undefined, [])).toBe(true)
    expect(opsIdentical([{ kind: 'delete' }], undefined)).toBe(false)
  })

  it('fails CLOSED for future payload-carrying kinds — same kind alone is never identical (PR #44 review)', () => {
    const moveTo = (toIndex: number): StructuralOp => ({ kind: 'move', toIndex }) as never
    expect(opsIdentical([moveTo(2)], [moveTo(2)])).toBe(true)
    // a re-move to a DIFFERENT index is a genuinely new request — must not be deduped
    expect(opsIdentical([moveTo(2)], [moveTo(4)])).toBe(false)
  })
})

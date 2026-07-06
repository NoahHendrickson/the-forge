// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { marginSectionVisible, minMaxRowVisible, normalizeAlign } from '../../src/client/panel-readers'
import { DraftStore } from '../../src/client/drafts'
import type { TaggedElement } from '../../src/client/source'

function el(css: string): TaggedElement {
  const d = document.createElement('div')
  d.setAttribute('style', css)
  document.body.append(d)
  return d as unknown as TaggedElement
}

describe('marginSectionVisible', () => {
  it('false for a margin-less element', () => {
    expect(marginSectionVisible(el(''))).toBe(false)
  })
  it('true when any side is non-zero', () => {
    expect(marginSectionVisible(el('margin-top: 12px'))).toBe(true)
  })
  it('true for auto margins (mx-auto is margin usage)', () => {
    expect(marginSectionVisible(el('margin-left: auto; margin-right: auto'))).toBe(true)
  })
  it('true for negative margins', () => {
    expect(marginSectionVisible(el('margin-top: -8px'))).toBe(true)
  })
  it('a live margin draft keeps it true even when the drafted value is 0', () => {
    const e = el('margin-top: 16px')
    const drafts = new DraftStore()
    drafts.apply(e, 'margin-top', '0px')
    expect(marginSectionVisible(e, drafts)).toBe(true)
  })
})

describe('minMaxRowVisible', () => {
  it('true when explicitly opened, regardless of computed value', () => {
    expect(minMaxRowVisible('min-width', '0px', false, true)).toBe(true)
  })
  it('true when a draft is live, regardless of computed value', () => {
    expect(minMaxRowVisible('max-width', 'none', true, false)).toBe(true)
  })
  it('false for min-* default set (empty/0px/auto) when not opened and no draft', () => {
    expect(minMaxRowVisible('min-width', '', false, false)).toBe(false)
    expect(minMaxRowVisible('min-height', '0px', false, false)).toBe(false)
    expect(minMaxRowVisible('min-width', 'auto', false, false)).toBe(false)
  })
  it('false for max-* default set (empty/none) when not opened and no draft', () => {
    expect(minMaxRowVisible('max-width', '', false, false)).toBe(false)
    expect(minMaxRowVisible('max-height', 'none', false, false)).toBe(false)
  })
  it('true for a non-default 120px value, both min and max kinds', () => {
    expect(minMaxRowVisible('min-width', '120px', false, false)).toBe(true)
    expect(minMaxRowVisible('max-height', '120px', false, false)).toBe(true)
  })
  it('KNOWN LIMIT: an authored min-width: 0 is indistinguishable from the true default (both compute to 0px) — cannot auto-disclose by design', () => {
    expect(minMaxRowVisible('min-width', '0px', false, false)).toBe(false)
  })
})

describe('normalizeAlign', () => {
  it('normalizeAlign passes baseline through untouched (baseline is a real matrix-less state)', () => {
    expect(normalizeAlign('baseline')).toBe('baseline')
  })
})

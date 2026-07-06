// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { marginSectionVisible, normalizeAlign } from '../../src/client/panel-readers'
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

describe('normalizeAlign', () => {
  it('normalizeAlign passes baseline through untouched (baseline is a real matrix-less state)', () => {
    expect(normalizeAlign('baseline')).toBe('baseline')
  })
})

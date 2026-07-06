import { describe, expect, it } from 'vitest'
import { cssHintFor, GAP_SPEC } from '../../src/client/panel-specs'

describe('cssHintFor', () => {
  it('maps single-prop rows to their Tailwind prefix', () => {
    expect(cssHintFor({ props: ['padding-top'] })).toBe('padding-top → pt-*')
  })
  it('maps multi-prop synthetic rows (padding-inline → px)', () => {
    expect(cssHintFor({ props: ['padding-left', 'padding-right'] })).toBe('padding-left, padding-right → px-*')
  })
  it('falls back to bare CSS prop names when no utility prefix exists', () => {
    expect(
      cssHintFor({ props: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'] })
    ).toBe('border-top-width, border-right-width, border-bottom-width, border-left-width')
  })
  it('covers the gap spec', () => {
    expect(cssHintFor(GAP_SPEC)).toBe('gap → gap-*')
  })
})

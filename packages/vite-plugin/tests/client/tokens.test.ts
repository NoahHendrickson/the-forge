// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { readTheme, suggestUtility, findExistingUtility, type Theme } from '../../src/client/tokens'

const TW: Theme = { rootFontPx: 16, spacingBasePx: 4, radiusScale: { sm: 4, md: 6, lg: 8, xl: 12 } }
const PLAIN: Theme = { rootFontPx: 16, spacingBasePx: null, radiusScale: {} }

beforeEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('readTheme', () => {
  it('reads spacing base and radius names from :root custom properties', () => {
    const root = document.documentElement
    root.style.setProperty('--spacing', '0.25rem')
    root.style.setProperty('--radius-lg', '0.5rem')
    root.style.setProperty('--radius-sm', '4px')
    const theme = readTheme(root)
    expect(theme.spacingBasePx).toBe(4)
    expect(theme.radiusScale.lg).toBe(8)
    expect(theme.radiusScale.sm).toBe(4)
  })

  it('returns spacingBasePx null when --spacing is absent (non-Tailwind project)', () => {
    expect(readTheme(document.documentElement).spacingBasePx).toBeNull()
  })
})

describe('suggestUtility', () => {
  it('maps spacing props to scale utilities, including half steps', () => {
    expect(suggestUtility('padding-top', '24px', TW)).toEqual({ utility: 'pt-6', tokenExact: true })
    expect(suggestUtility('padding-top', '10px', TW)).toEqual({ utility: 'pt-2.5', tokenExact: true })
    expect(suggestUtility('margin-left', '-8px', TW)).toEqual({ utility: '-ml-2', tokenExact: true })
  })

  it('falls back to arbitrary values off the scale', () => {
    expect(suggestUtility('padding-top', '13px', TW)).toEqual({ utility: 'pt-[13px]', tokenExact: false })
  })

  it('maps synthetic collapsed props py/px and rounded', () => {
    expect(suggestUtility('padding-block', '24px', TW)).toEqual({ utility: 'py-6', tokenExact: true })
    expect(suggestUtility('padding-inline', '16px', TW)).toEqual({ utility: 'px-4', tokenExact: true })
    expect(suggestUtility('border-radius', '8px', TW)).toEqual({ utility: 'rounded-lg', tokenExact: true })
  })

  it('maps radius to nearest named token, full for pills, arbitrary otherwise', () => {
    expect(suggestUtility('border-top-left-radius', '12px', TW)).toEqual({ utility: 'rounded-tl-xl', tokenExact: true })
    expect(suggestUtility('border-radius', '999px', TW)).toEqual({ utility: 'rounded-full', tokenExact: true })
    expect(suggestUtility('border-radius', '9px', TW)).toEqual({ utility: 'rounded-[9px]', tokenExact: false })
  })

  it('maps size and opacity', () => {
    expect(suggestUtility('width', '200px', TW)).toEqual({ utility: 'w-50', tokenExact: true })
    expect(suggestUtility('opacity', '0.5', TW)).toEqual({ utility: 'opacity-50', tokenExact: true })
    expect(suggestUtility('opacity', '0.505', TW)).toEqual({ utility: 'opacity-[0.505]', tokenExact: false })
  })

  it('maps gap to scale utilities', () => {
    expect(suggestUtility('gap', '24px', TW)).toEqual({ utility: 'gap-6', tokenExact: true })
  })

  it('maps width/height auto keyword to w-auto/h-auto', () => {
    expect(suggestUtility('width', 'auto', TW)).toEqual({ utility: 'w-auto', tokenExact: true })
    expect(suggestUtility('height', 'auto', TW)).toEqual({ utility: 'h-auto', tokenExact: true })
  })

  it('returns null for non-Tailwind themes and unmapped props', () => {
    expect(suggestUtility('padding-top', '24px', PLAIN)).toBeNull()
    expect(suggestUtility('color', 'red', TW)).toBeNull()
  })
})

describe('findExistingUtility', () => {
  const cls = 'mt-4 rounded-lg bg-blue-600 px-4 py-2.5 text-sm text-white'
  it('finds the bare utility for a prop', () => {
    expect(findExistingUtility(cls, 'padding-block')).toBe('py-2.5')
    expect(findExistingUtility(cls, 'padding-inline')).toBe('px-4')
    expect(findExistingUtility(cls, 'margin-top')).toBe('mt-4')
    expect(findExistingUtility(cls, 'border-radius')).toBe('rounded-lg')
  })

  it('does not confuse rounded with per-corner utilities', () => {
    expect(findExistingUtility('rounded-tl-xl p-2', 'border-radius')).toBeNull()
    expect(findExistingUtility('rounded-tl-xl p-2', 'border-top-left-radius')).toBe('rounded-tl-xl')
  })

  it('ignores variant-prefixed utilities and returns null when absent', () => {
    expect(findExistingUtility('md:pt-8 text-sm', 'padding-top')).toBeNull()
  })

  it('detects the bare rounded class', () => {
    expect(findExistingUtility('rounded p-2', 'border-radius')).toBe('rounded')
  })
})

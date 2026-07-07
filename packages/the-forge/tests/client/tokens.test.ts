// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  readTheme,
  suggestUtility,
  findExistingUtility,
  readTokens,
  resetTokensCache,
  parseColor,
  nearestColorToken,
  contrastRatio,
  rgbToHex,
  type Theme,
  type Tokens,
  type ColorToken,
} from '../../src/client/tokens'

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
    expect(suggestUtility('made-up-prop', 'red', TW)).toBeNull()
  })

  it('maps border-width to the fixed Tailwind border scale (0/1/2/4/8), arbitrary otherwise', () => {
    expect(suggestUtility('border-width', '1px', TW)).toEqual({ utility: 'border', tokenExact: true })
    expect(suggestUtility('border-width', '0px', TW)).toEqual({ utility: 'border-0', tokenExact: true })
    expect(suggestUtility('border-width', '2px', TW)).toEqual({ utility: 'border-2', tokenExact: true })
    expect(suggestUtility('border-width', '4px', TW)).toEqual({ utility: 'border-4', tokenExact: true })
    expect(suggestUtility('border-width', '8px', TW)).toEqual({ utility: 'border-8', tokenExact: true })
    expect(suggestUtility('border-width', '3px', TW)).toEqual({ utility: 'border-[3px]', tokenExact: false })
  })

  it('maps border-style keywords to the border-<style> utility family (collapsed + longhands)', () => {
    expect(suggestUtility('border-style', 'none', TW)).toEqual({ utility: 'border-none', tokenExact: true })
    expect(suggestUtility('border-style', 'solid', TW)).toEqual({ utility: 'border-solid', tokenExact: true })
    expect(suggestUtility('border-style', 'dashed', TW)).toEqual({ utility: 'border-dashed', tokenExact: true })
    expect(suggestUtility('border-style', 'dotted', TW)).toEqual({ utility: 'border-dotted', tokenExact: true })
    // longhands (unequal sides, so request.ts's collapse() leaves them separate) map the same way
    expect(suggestUtility('border-top-style', 'none', TW)).toEqual({ utility: 'border-none', tokenExact: true })
    // an unrecognized keyword (not one of Tailwind's four) has no utility mapping
    expect(suggestUtility('border-style', 'groove', TW)).toBeNull()
  })

  it('maps font-size to the nearest text-* token by exact px match, arbitrary otherwise', () => {
    const tokens: Tokens = {
      colors: [],
      textScale: [
        { name: 'sm', px: 14 },
        { name: 'base', px: 16 },
        { name: 'lg', px: 18 },
        { name: 'xl', px: 20 },
      ],
    }
    expect(suggestUtility('font-size', '18px', TW, tokens)).toEqual({ utility: 'text-lg', tokenExact: true })
    expect(suggestUtility('font-size', '20px', TW, tokens)).toEqual({ utility: 'text-xl', tokenExact: true })
    expect(suggestUtility('font-size', '19px', TW, tokens)).toEqual({ utility: 'text-[19px]', tokenExact: false })
  })

  it('font-size with no matching text scale falls back to arbitrary', () => {
    expect(suggestUtility('font-size', '18px', TW)).toEqual({ utility: 'text-[18px]', tokenExact: false })
  })

  it('maps font-weight to the 9 named-weight utilities, arbitrary otherwise', () => {
    expect(suggestUtility('font-weight', '100', TW)).toEqual({ utility: 'font-thin', tokenExact: true })
    expect(suggestUtility('font-weight', '200', TW)).toEqual({ utility: 'font-extralight', tokenExact: true })
    expect(suggestUtility('font-weight', '300', TW)).toEqual({ utility: 'font-light', tokenExact: true })
    expect(suggestUtility('font-weight', '400', TW)).toEqual({ utility: 'font-normal', tokenExact: true })
    expect(suggestUtility('font-weight', '500', TW)).toEqual({ utility: 'font-medium', tokenExact: true })
    expect(suggestUtility('font-weight', '600', TW)).toEqual({ utility: 'font-semibold', tokenExact: true })
    expect(suggestUtility('font-weight', '700', TW)).toEqual({ utility: 'font-bold', tokenExact: true })
    expect(suggestUtility('font-weight', '800', TW)).toEqual({ utility: 'font-extrabold', tokenExact: true })
    expect(suggestUtility('font-weight', '900', TW)).toEqual({ utility: 'font-black', tokenExact: true })
    expect(suggestUtility('font-weight', '450', TW)).toEqual({ utility: 'font-[450]', tokenExact: false })
  })
})

describe('min/max sizing utilities (M-D)', () => {
  it('suggestUtility emits min-w-*/max-h-* from the spacing scale', () => {
    // spacingBasePx 4 in TW: 16px -> step 4
    expect(suggestUtility('min-width', '16px', TW)).toEqual({ utility: 'min-w-4', tokenExact: true })
    expect(suggestUtility('max-height', '16px', TW)).toEqual({ utility: 'max-h-4', tokenExact: true })
  })

  it('clearing keywords resolve to the real static Tailwind utility, not a NaN arbitrary value', () => {
    // min-width/min-height's CSS initial value is 'auto'; max-width/max-height's is 'none'.
    // Without a dedicated special case (mirroring w-auto/h-auto above), these fall through to
    // Number.parseFloat('auto'|'none') -> NaN -> a bogus `${prefix}-[NaNpx]`.
    expect(suggestUtility('min-width', 'auto', TW)).toEqual({ utility: 'min-w-auto', tokenExact: true })
    expect(suggestUtility('min-height', 'auto', TW)).toEqual({ utility: 'min-h-auto', tokenExact: true })
    expect(suggestUtility('max-width', 'none', TW)).toEqual({ utility: 'max-w-none', tokenExact: true })
    expect(suggestUtility('max-height', 'none', TW)).toEqual({ utility: 'max-h-none', tokenExact: true })
  })

  it('does not cross-match w-* and min-w-* class prefixes', () => {
    // guards the substring hazard both directions: an existing `min-w-4` class must not be
    // read as a width utility, and `w-4` must not be read as a min-width utility.
    expect(findExistingUtility('min-w-4 p-2', 'width')).toBeNull()
    expect(findExistingUtility('w-4 p-2', 'min-width')).toBeNull()
    expect(findExistingUtility('min-w-4 p-2', 'min-width')).toBe('min-w-4')
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

  it('finds bg-*/text-*/border-* color utilities', () => {
    const cls = 'mt-4 bg-blue-600 px-4 text-white border-red-500'
    expect(findExistingUtility(cls, 'background-color')).toBe('bg-blue-600')
    expect(findExistingUtility(cls, 'color')).toBe('text-white')
    expect(findExistingUtility(cls, 'border-color')).toBe('border-red-500')
  })

  it('skips numeric and side border utilities for border-color', () => {
    expect(findExistingUtility('border-2 p-2', 'border-color')).toBeNull()
    expect(findExistingUtility('border-t p-2', 'border-color')).toBeNull()
    expect(findExistingUtility('border-t-2 p-2', 'border-color')).toBeNull()
    expect(findExistingUtility('border-r border-b border-l', 'border-color')).toBeNull()
    expect(findExistingUtility('border-slate-400', 'border-color')).toBe('border-slate-400')
  })

  it('finds border-width utilities, including the bare `border` (1px default) class', () => {
    expect(findExistingUtility('border p-2', 'border-width')).toBe('border')
    expect(findExistingUtility('border-2 p-2', 'border-width')).toBe('border-2')
  })

  it('skips color utilities when looking for border-width', () => {
    expect(findExistingUtility('border-slate-400', 'border-width')).toBeNull()
  })

  it('finds a color utility among non-color size/utility siblings by requiring a color-shaped suffix', () => {
    // "text-lg" (a font-size utility) must not be mistaken for the color utility just
    // because it shares the "text-" prefix — only "text-neutral-900" (family-shade shaped)
    // is a color suffix.
    expect(findExistingUtility('text-lg text-neutral-900', 'color')).toBe('text-neutral-900')
  })

  it('does not match a non-color-shaped bg-* utility for background-color', () => {
    expect(findExistingUtility('bg-gradient-to-r p-2', 'background-color')).toBeNull()
    expect(findExistingUtility('bg-cover p-2', 'background-color')).toBeNull()
  })

  it('border-t-red-500 is not matched for border-width (side-prefixed but color-shaped, not width-shaped)', () => {
    expect(findExistingUtility('border-t-red-500', 'border-width')).toBeNull()
  })

  it('still finds arbitrary and keyword color suffixes (hex/rgb/named keywords)', () => {
    expect(findExistingUtility('bg-[#ff0000] p-2', 'background-color')).toBe('bg-[#ff0000]')
    expect(findExistingUtility('bg-white p-2', 'background-color')).toBe('bg-white')
    expect(findExistingUtility('bg-transparent p-2', 'background-color')).toBe('bg-transparent')
  })

  it('finds font-size utilities via size-shaped text-* suffixes, symmetric with color-shape guarding', () => {
    expect(findExistingUtility('text-lg font-medium text-neutral-900', 'font-size')).toBe('text-lg')
    expect(findExistingUtility('text-[20px] font-medium', 'font-size')).toBe('text-[20px]')
    // a color-shaped text-* utility must not be mistaken for font-size
    expect(findExistingUtility('text-neutral-900', 'font-size')).toBeNull()
  })

  it('finds font-weight only among the 9 named weight utilities, never font-sans/serif/mono', () => {
    expect(findExistingUtility('text-lg font-semibold text-neutral-900', 'font-weight')).toBe('font-semibold')
    expect(findExistingUtility('font-sans text-lg', 'font-weight')).toBeNull()
    expect(findExistingUtility('font-serif', 'font-weight')).toBeNull()
    expect(findExistingUtility('font-mono', 'font-weight')).toBeNull()
  })
})

describe('readTokens', () => {
  afterEach(() => {
    resetTokensCache()
    document.querySelectorAll('style[data-test-tokens]').forEach((el) => el.remove())
    document.documentElement.removeAttribute('style')
  })

  function addStyle(css: string): HTMLStyleElement {
    const style = document.createElement('style')
    style.setAttribute('data-test-tokens', '1')
    style.textContent = css
    document.head.appendChild(style)
    return style
  }

  it('reads --color-* and --text-* custom properties from nested rules', () => {
    addStyle(`
      :root {
        --color-red-500: #fb2c36;
        --color-white: #fff;
      }
      @media (min-width: 1px) {
        :root {
          --text-sm: 0.875rem;
          --text-sm--line-height: 1.25rem;
        }
      }
    `)
    document.documentElement.style.setProperty('--color-red-500', '#fb2c36')
    document.documentElement.style.setProperty('--color-white', '#fff')
    document.documentElement.style.setProperty('--text-sm', '0.875rem')

    const tokens = readTokens(document)
    const byName = Object.fromEntries(tokens.colors.map((c) => [c.name, c.value]))
    expect(byName['red-500']).toBe('#fb2c36')
    expect(byName['white']).toBe('#fff')
    expect(tokens.textScale.find((t) => t.name === 'sm')).toEqual({ name: 'sm', px: 14 })
    // --text-sm--line-height must be excluded (name contains '--')
    expect(tokens.textScale.find((t) => t.name === 'sm--line-height')).toBeUndefined()
  })

  it('resolves color values via getComputedStyle rather than echoing the raw rule text (var() chains resolve in real browsers; jsdom itself does not compute var() — this pins us to the spec-correct source, getPropertyValue, not the CSSOM rule text)', () => {
    addStyle(`:root { --color-red-500: #fb2c36; --color-brand: var(--color-red-500); }`)
    document.documentElement.style.setProperty('--color-red-500', '#fb2c36')
    // Simulate what a real browser's getComputedStyle would report for a resolved var() chain —
    // jsdom has no CSS cascade engine, so we set the resolved value directly on the inline style
    // to prove readTokens reads through getComputedStyle(root).getPropertyValue, not rule.style.
    document.documentElement.style.setProperty('--color-brand', '#fb2c36')
    const tokens = readTokens(document)
    const byName = Object.fromEntries(tokens.colors.map((c) => [c.name, c.value]))
    expect(byName['brand']).toBe('#fb2c36')
  })

  it('skips cross-origin stylesheets whose cssRules access throws', () => {
    addStyle(`:root { --color-safe: #112233; }`)
    document.documentElement.style.setProperty('--color-safe', '#112233')
    const throwing = {
      get cssRules(): CSSRuleList {
        throw new DOMException('cross-origin', 'SecurityError')
      },
    } as unknown as CSSStyleSheet
    Object.defineProperty(document, 'styleSheets', {
      configurable: true,
      get: () => {
        const real = Array.from(document.head.querySelectorAll('style')).map((s) => s.sheet)
        return [throwing, ...real] as unknown as StyleSheetList
      },
    })
    try {
      expect(() => readTokens(document)).not.toThrow()
      const tokens = readTokens(document)
      expect(tokens.colors.some((c) => c.name === 'safe')).toBe(true)
    } finally {
      Object.defineProperty(document, 'styleSheets', {
        configurable: true,
        value: document.styleSheets,
      })
      // restore original descriptor by deleting our override so jsdom's own getter returns
      delete (document as any).styleSheets
    }
  })

  it('dedupes by name, later sheet wins', () => {
    addStyle(`:root { --color-red-500: #111111; }`)
    addStyle(`:root { --color-red-500: #fb2c36; }`)
    document.documentElement.style.setProperty('--color-red-500', '#fb2c36')
    const tokens = readTokens(document)
    const matches = tokens.colors.filter((c) => c.name === 'red-500')
    expect(matches).toHaveLength(1)
    expect(matches[0].value).toBe('#fb2c36')
  })

  it('sorts colors by family/shade ascending, shadeless names last', () => {
    addStyle(`
      :root {
        --color-red-500: #fb2c36;
        --color-red-200: #ffc9c9;
        --color-blue-500: #2b7fff;
        --color-white: #fff;
        --color-black: #000;
      }
    `)
    document.documentElement.style.setProperty('--color-red-500', '#fb2c36')
    document.documentElement.style.setProperty('--color-red-200', '#ffc9c9')
    document.documentElement.style.setProperty('--color-blue-500', '#2b7fff')
    document.documentElement.style.setProperty('--color-white', '#fff')
    document.documentElement.style.setProperty('--color-black', '#000')

    const tokens = readTokens(document)
    const names = tokens.colors.map((c) => c.name)
    expect(names.indexOf('red-200')).toBeLessThan(names.indexOf('red-500'))
    expect(names.indexOf('blue-500')).toBeLessThan(names.indexOf('white'))
    expect(names.indexOf('red-500')).toBeLessThan(names.indexOf('white'))
    expect(names.indexOf('white')).toBeGreaterThan(-1)
    expect(names.indexOf('black')).toBeGreaterThan(-1)
  })

  it('sorts textScale by px ascending', () => {
    addStyle(`:root { --text-lg: 1.125rem; --text-xs: 0.75rem; --text-sm: 0.875rem; }`)
    document.documentElement.style.setProperty('--text-lg', '1.125rem')
    document.documentElement.style.setProperty('--text-xs', '0.75rem')
    document.documentElement.style.setProperty('--text-sm', '0.875rem')
    const tokens = readTokens(document)
    const pxs = tokens.textScale.map((t) => t.px)
    expect(pxs).toEqual([...pxs].sort((a, b) => a - b))
  })

  it('recurses into grouping rules using duck-typed .cssRules (tested via @media since jsdom lacks @layer)', () => {
    addStyle(`
      @media (min-width: 1px) {
        :root { --color-nested: #654321; }
      }
    `)
    document.documentElement.style.setProperty('--color-nested', '#654321')
    const tokens = readTokens(document)
    expect(tokens.colors.some((c) => c.name === 'nested')).toBe(true)
  })

  it('is memoized (resettable) and does not run at import time', () => {
    // No fixture set up yet at this point in the test — readTokens must not have been
    // called eagerly at module load, or this assertion would be meaningless (see below).
    addStyle(`:root { --color-memo: #010203; }`)
    document.documentElement.style.setProperty('--color-memo', '#010203')
    const first = readTokens(document)
    expect(first.colors.some((c) => c.name === 'memo')).toBe(true)

    // Mutate the DOM without calling resetTokensCache — memoized result must NOT change.
    addStyle(`:root { --color-memo2: #030201; }`)
    document.documentElement.style.setProperty('--color-memo2', '#030201')
    const second = readTokens(document)
    expect(second.colors.some((c) => c.name === 'memo2')).toBe(false)

    resetTokensCache()
    const third = readTokens(document)
    expect(third.colors.some((c) => c.name === 'memo2')).toBe(true)
  })
})

describe('parseColor', () => {
  it('parses hex forms', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('#f00a')).toEqual({ r: 255, g: 0, b: 0, a: expect.closeTo(0.667, 2) })
    expect(parseColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: expect.closeTo(0.502, 2) })
  })

  it('parses rgb/rgba functional and v4 space-separated forms', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
    expect(parseColor('rgb(255 0 0 / 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 })
  })

  it('parses named colors and transparent', () => {
    expect(parseColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('black')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('parses oklch, matching precomputed Tailwind v4 palette pairs within tolerance', () => {
    // Tailwind v4: --color-red-500: oklch(63.7% 0.237 25.331) -> #fb2c36
    const red500 = parseColor('oklch(63.7% 0.237 25.331)')!
    expect(red500.r).toBeGreaterThanOrEqual(251 - 2)
    expect(red500.r).toBeLessThanOrEqual(251 + 2)
    expect(red500.g).toBeGreaterThanOrEqual(44 - 2)
    expect(red500.g).toBeLessThanOrEqual(44 + 2)
    expect(red500.b).toBeGreaterThanOrEqual(54 - 2)
    expect(red500.b).toBeLessThanOrEqual(54 + 2)

    // --color-blue-500: oklch(62.3% 0.214 259.815) -> #2b7fff
    const blue500 = parseColor('oklch(62.3% 0.214 259.815)')!
    expect(blue500.r).toBeGreaterThanOrEqual(43 - 2)
    expect(blue500.r).toBeLessThanOrEqual(43 + 2)
    expect(blue500.g).toBeGreaterThanOrEqual(127 - 2)
    expect(blue500.g).toBeLessThanOrEqual(127 + 2)
    expect(blue500.b).toBeGreaterThanOrEqual(255 - 2)
    expect(blue500.b).toBeLessThanOrEqual(255 + 2)

    // --color-gray-200: oklch(92.8% 0.006 264.531) -> #e5e7eb
    const gray200 = parseColor('oklch(92.8% 0.006 264.531)')!
    expect(gray200.r).toBeGreaterThanOrEqual(229 - 2)
    expect(gray200.r).toBeLessThanOrEqual(229 + 2)
    expect(gray200.g).toBeGreaterThanOrEqual(231 - 2)
    expect(gray200.g).toBeLessThanOrEqual(231 + 2)
    expect(gray200.b).toBeGreaterThanOrEqual(235 - 2)
    expect(gray200.b).toBeLessThanOrEqual(235 + 2)
  })

  it('parses oklch with alpha and 0-1 L values', () => {
    const withAlpha = parseColor('oklch(0.637 0.237 25.331 / 0.5)')!
    expect(withAlpha.a).toBe(0.5)
    expect(withAlpha.r).toBeGreaterThanOrEqual(249)
  })

  it('returns null for unparseable input', () => {
    expect(parseColor('inherit')).toBeNull()
    expect(parseColor('currentColor')).toBeNull()
    expect(parseColor('')).toBeNull()
    expect(parseColor('not-a-color')).toBeNull()
    expect(parseColor('var(--foo)')).toBeNull()
  })
})

describe('rgbToHex', () => {
  it('formats and zero-pads each channel to 2 hex digits', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000')
    expect(rgbToHex(0, 8, 0)).toBe('#000800')
  })

  it('clamps out-of-range and rounds fractional channel values', () => {
    expect(rgbToHex(-10, 300, 127.6)).toBe('#00ff80')
  })

  it('appends a 2-digit alpha channel when alpha is provided and less than 1', () => {
    expect(rgbToHex(255, 0, 0, 0.5)).toBe('#ff000080')
  })

  it('omits the alpha channel when alpha is 1 or omitted', () => {
    expect(rgbToHex(0, 255, 0, 1)).toBe('#00ff00')
    expect(rgbToHex(0, 255, 0)).toBe('#00ff00')
  })
})

describe('nearestColorToken', () => {
  const tokens: ColorToken[] = [
    { name: 'red-500', value: '#fb2c36' },
    { name: 'blue-500', value: '#2b7fff' },
    { name: 'white', value: '#ffffff' },
  ]

  it('picks the expected nearest neighbor', () => {
    const result = nearestColorToken({ r: 250, g: 40, b: 50, a: 1 }, tokens)
    expect(result?.token.name).toBe('red-500')
  })

  it('skips unparseable token values', () => {
    const withBad: ColorToken[] = [{ name: 'broken', value: 'not-a-color' }, ...tokens]
    const result = nearestColorToken({ r: 250, g: 40, b: 50, a: 1 }, withBad)
    expect(result?.token.name).toBe('red-500')
  })

  it('returns null when tokens is empty', () => {
    expect(nearestColorToken({ r: 0, g: 0, b: 0, a: 1 }, [])).toBeNull()
  })
})

describe('contrastRatio', () => {
  it('black on white is 21', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBe(21)
  })

  it('identical colors is 1', () => {
    expect(contrastRatio({ r: 100, g: 150, b: 200, a: 1 }, { r: 100, g: 150, b: 200, a: 1 })).toBe(1)
  })

  it('#767676 on white is approximately 4.54 (WCAG AA boundary example)', () => {
    const ratio = contrastRatio({ r: 0x76, g: 0x76, b: 0x76, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })
    expect(ratio).toBeGreaterThanOrEqual(4.49)
    expect(ratio).toBeLessThanOrEqual(4.59)
  })

  it('alpha-composites the foreground over the background before computing luminance', () => {
    // 50%-alpha black over white == solid gray(127.5) over white
    const withAlpha = contrastRatio({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 })
    const solidGray = contrastRatio({ r: 128, g: 128, b: 128, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })
    expect(Math.abs(withAlpha - solidGray)).toBeLessThan(0.1)
    expect(withAlpha).toBeLessThan(21)
    expect(withAlpha).toBeGreaterThan(1)
  })
})

describe('suggestUtility — color support', () => {
  const tokens: Tokens = {
    colors: [
      { name: 'red-500', value: '#fb2c36' },
      { name: 'blue-500', value: '#2b7fff' },
    ],
    textScale: [],
  }

  it('exact token match returns the token utility with tokenExact true', () => {
    expect(suggestUtility('background-color', 'rgb(251, 44, 54)', TW, tokens)).toEqual({
      utility: 'bg-red-500',
      tokenExact: true,
    })
    expect(suggestUtility('color', 'rgb(251, 44, 54)', TW, tokens)).toEqual({
      utility: 'text-red-500',
      tokenExact: true,
    })
    expect(suggestUtility('border-color', 'rgb(43, 127, 255)', TW, tokens)).toEqual({
      utility: 'border-blue-500',
      tokenExact: true,
    })
  })

  it('off-token color falls back to arbitrary value with spaces stripped, tokenExact false', () => {
    expect(suggestUtility('background-color', 'rgb(18, 52, 86)', TW, tokens)).toEqual({
      utility: 'bg-[rgb(18,52,86)]',
      tokenExact: false,
    })
  })

  it('transparent is a special case: tokenExact true even without a matching token', () => {
    expect(suggestUtility('background-color', 'transparent', TW, tokens)).toEqual({
      utility: 'bg-transparent',
      tokenExact: true,
    })
    expect(suggestUtility('color', 'transparent', TW, tokens)).toEqual({
      utility: 'text-transparent',
      tokenExact: true,
    })
  })

  it('works with no tokens argument (falls back to arbitrary values)', () => {
    expect(suggestUtility('color', 'red', TW)).toEqual({ utility: 'text-[red]', tokenExact: false })
  })

  it('a measured fully-transparent rgba maps to bg-transparent (not a token guess), even with a matching alpha-0 token', () => {
    // "rgba(0, 0, 0, 0)" must resolve via the a===0 special case, not fall through to the
    // token loop and claim bg-black (r/g/b all match black, but alpha is 0 — a completely
    // different color in practice).
    expect(suggestUtility('background-color', 'rgba(0, 0, 0, 0)', TW, tokens)).toEqual({
      utility: 'bg-transparent',
      tokenExact: true,
    })
  })

  it('a semi-transparent color matching an opaque token by rgb still returns arbitrary, not the token', () => {
    // rgba(251, 44, 54, 0.5) has the same rgb as the red-500 token (opaque) but the alpha
    // differs — must NOT claim tokenExact against a token whose own color is fully opaque.
    expect(suggestUtility('background-color', 'rgba(251, 44, 54, 0.5)', TW, tokens)).toEqual({
      utility: 'bg-[rgba(251,44,54,0.5)]',
      tokenExact: false,
    })
  })
})

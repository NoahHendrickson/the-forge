export interface Theme {
  rootFontPx: number
  spacingBasePx: number | null
  radiusScale: Record<string, number>
}

const RADIUS_NAMES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl']

function toPx(value: string, rootFontPx: number): number {
  const n = Number.parseFloat(value)
  return value.trim().endsWith('rem') ? n * rootFontPx : n
}

export function readTheme(root: Element = document.documentElement): Theme {
  const cs = getComputedStyle(root)
  const rootFontPx = Number.parseFloat(cs.fontSize) || 16
  const spacing = cs.getPropertyValue('--spacing').trim()
  const spacingBasePx = spacing ? toPx(spacing, rootFontPx) : null
  const radiusScale: Record<string, number> = {}
  for (const name of RADIUS_NAMES) {
    const v = cs.getPropertyValue(`--radius-${name}`).trim()
    if (v) radiusScale[name] = toPx(v, rootFontPx)
  }
  return { rootFontPx, spacingBasePx, radiusScale }
}

// css prop (incl. synthetic collapsed props) → utility prefix
export const UTILITY_PREFIXES: Record<string, string> = {
  'padding-top': 'pt',
  'padding-right': 'pr',
  'padding-bottom': 'pb',
  'padding-left': 'pl',
  'padding-block': 'py',
  'padding-inline': 'px',
  'margin-top': 'mt',
  'margin-right': 'mr',
  'margin-bottom': 'mb',
  'margin-left': 'ml',
  'margin-block': 'my',
  'margin-inline': 'mx',
  width: 'w',
  height: 'h',
  'border-radius': 'rounded',
  'border-top-left-radius': 'rounded-tl',
  'border-top-right-radius': 'rounded-tr',
  'border-bottom-right-radius': 'rounded-br',
  'border-bottom-left-radius': 'rounded-bl',
  opacity: 'opacity',
}

const RADIUS_PROPS = new Set(
  Object.keys(UTILITY_PREFIXES).filter((p) => p.includes('radius'))
)

export function suggestUtility(
  prop: string,
  css: string,
  theme: Theme
): { utility: string; tokenExact: boolean } | null {
  const prefix = UTILITY_PREFIXES[prop]
  if (!prefix || theme.spacingBasePx === null) return null

  if (prop === 'opacity') {
    const pct = Number.parseFloat(css) * 100
    const rounded = Math.round(pct)
    if (Math.abs(pct - rounded) < 0.001) {
      return { utility: `opacity-${rounded}`, tokenExact: true }
    }
    return { utility: `opacity-[${css}]`, tokenExact: false }
  }

  const px = Number.parseFloat(css)

  if (RADIUS_PROPS.has(prop)) {
    if (px >= 999) return { utility: `${prefix}-full`, tokenExact: true }
    for (const [name, value] of Object.entries(theme.radiusScale)) {
      if (Math.abs(value - px) < 0.5) return { utility: `${prefix}-${name}`, tokenExact: true }
    }
    return { utility: `${prefix}-[${px}px]`, tokenExact: false }
  }

  const steps = px / theme.spacingBasePx
  const half = Math.round(steps * 2) / 2
  if (Math.abs(steps - half) < 0.01 && half !== 0) {
    const abs = Math.abs(half)
    const sign = half < 0 ? '-' : ''
    return { utility: `${sign}${prefix}-${abs}`, tokenExact: true }
  }
  if (px === 0) return { utility: `${prefix}-0`, tokenExact: true }
  return { utility: `${prefix}-[${px}px]`, tokenExact: false }
}

export function findExistingUtility(className: string, prop: string): string | null {
  const prefix = UTILITY_PREFIXES[prop]
  if (!prefix) return null
  for (const cls of className.split(/\s+/)) {
    if (cls.includes(':')) continue // variant-prefixed — out of scope for detection
    const bare = cls.startsWith('-') ? cls.slice(1) : cls
    if (prefix === 'rounded' && bare === 'rounded') return cls
    if (!bare.startsWith(`${prefix}-`)) continue
    const suffix = bare.slice(prefix.length + 1)
    // guard: 'rounded-' must not match 'rounded-tl-…' (a longer registered prefix)
    const corner = /^(tl|tr|br|bl)(-|$)/.test(suffix)
    if (prefix === 'rounded' && corner) continue
    return cls
  }
  return null
}

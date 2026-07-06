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

// ---------------------------------------------------------------------------
// Token enumeration (B2)
// ---------------------------------------------------------------------------

export interface ColorToken {
  name: string
  value: string
}

export interface ScaleToken {
  name: string
  px: number
}

export interface Tokens {
  colors: ColorToken[]
  textScale: ScaleToken[]
}

function familyAndShade(name: string): { family: string; shade: number | null } {
  const m = /^(.*)-(\d+)$/.exec(name)
  if (!m) return { family: name, shade: null }
  return { family: m[1], shade: Number.parseInt(m[2], 10) }
}

function sortColors(colors: ColorToken[]): ColorToken[] {
  return [...colors].sort((a, b) => {
    const fa = familyAndShade(a.name)
    const fb = familyAndShade(b.name)
    // shadeless (e.g. white/black) sort after numbered families
    if (fa.shade === null && fb.shade !== null) return 1
    if (fa.shade !== null && fb.shade === null) return -1
    if (fa.family !== fb.family) return fa.family < fb.family ? -1 : 1
    if (fa.shade !== null && fb.shade !== null) return fa.shade - fb.shade
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

function collectRules(sheet: CSSStyleSheet, out: CSSRule[]): void {
  let rules: CSSRuleList
  try {
    rules = sheet.cssRules
  } catch {
    return // cross-origin SecurityError — skip silently
  }
  collectRuleList(rules, out)
}

function collectRuleList(rules: CSSRuleList, out: CSSRule[]): void {
  for (const rule of Array.from(rules)) {
    if ((rule as CSSStyleRule).style) out.push(rule)
    const grouping = rule as unknown as { cssRules?: CSSRuleList }
    if (grouping.cssRules) collectRuleList(grouping.cssRules, out)
  }
}

let tokensCache: Tokens | null = null

export function resetTokensCache(): void {
  tokensCache = null
}

export function readTokens(doc: Document = document): Tokens {
  if (tokensCache) return tokensCache

  const styleRules: CSSRule[] = []
  for (const sheet of Array.from(doc.styleSheets)) {
    collectRules(sheet as CSSStyleSheet, styleRules)
  }

  const cs = getComputedStyle(doc.documentElement)
  const rootFontPx = Number.parseFloat(cs.fontSize) || 16

  const colorsByName = new Map<string, ColorToken>()
  const textByName = new Map<string, ScaleToken>()

  for (const rule of styleRules) {
    const style = (rule as CSSStyleRule).style
    for (const prop of Array.from(style)) {
      if (prop.startsWith('--color-')) {
        const name = prop.slice('--color-'.length)
        const value = cs.getPropertyValue(prop).trim()
        if (!value) continue
        colorsByName.set(name, { name, value })
      } else if (prop.startsWith('--text-')) {
        const name = prop.slice('--text-'.length)
        if (name.includes('--')) continue // e.g. --text-sm--line-height
        const raw = cs.getPropertyValue(prop).trim()
        if (!raw) continue
        if (!/^-?[\d.]+(px|rem)$/.test(raw)) continue
        const px = toPx(raw, rootFontPx)
        if (Number.isNaN(px)) continue
        textByName.set(name, { name, px })
      }
    }
  }

  const colors = sortColors([...colorsByName.values()])
  const textScale = [...textByName.values()].sort((a, b) => a.px - b.px)

  tokensCache = { colors, textScale }
  return tokensCache
}

// ---------------------------------------------------------------------------
// Color math (B2)
// ---------------------------------------------------------------------------

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  aqua: [0, 255, 255],
  black: [0, 0, 0],
  blue: [0, 0, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  olive: [128, 128, 0],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  silver: [192, 192, 192],
  teal: [0, 128, 128],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
}

function clamp255(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)))
}

/** Shared rgb(+alpha) -> hex formatter — clamps/rounds each channel, zero-pads to 2 digits,
 *  and appends a 2-digit alpha channel only when alpha is provided and < 1. Single source of
 *  truth for the toHex/clampByte logic previously duplicated in panel.ts and colorpicker.ts. */
export function rgbToHex(r: number, g: number, b: number, a = 1): string {
  const toHex = (n: number) => clamp255(n).toString(16).padStart(2, '0')
  let hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`
  if (a < 1) hex += toHex(Math.round(a * 255))
  return hex
}

function parsePercentOrNumber(raw: string, scale: number): number {
  const s = raw.trim()
  if (s.endsWith('%')) return (Number.parseFloat(s) / 100) * scale
  return Number.parseFloat(s)
}

function oklchToRgb(L: number, C: number, Hdeg: number): [number, number, number] {
  const h = (Hdeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

  const toSrgb = (c: number): number => {
    const clamped = Math.min(1, Math.max(0, c))
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
  }

  return [clamp255(toSrgb(rLin) * 255), clamp255(toSrgb(gLin) * 255), clamp255(toSrgb(bLin) * 255)]
}

export function parseColor(css: string): RGBA | null {
  const s = css.trim()
  if (!s) return null
  const lower = s.toLowerCase()

  if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (lower in NAMED_COLORS) {
    const [r, g, b] = NAMED_COLORS[lower]
    return { r, g, b, a: 1 }
  }

  // hex forms: #rgb #rgba #rrggbb #rrggbbaa
  const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (hexMatch) {
    const hex = hexMatch[1]
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16)
      const g = Number.parseInt(hex[1] + hex[1], 16)
      const b = Number.parseInt(hex[2] + hex[2], 16)
      const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1
      return { r, g, b, a }
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16)
      const g = Number.parseInt(hex.slice(2, 4), 16)
      const b = Number.parseInt(hex.slice(4, 6), 16)
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
      return { r, g, b, a }
    }
    return null
  }

  // rgb()/rgba(): comma or space separated, optional slash alpha
  const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (rgbMatch) {
    const body = rgbMatch[1]
    const [channelsPart, alphaPart] = body.split('/')
    const parts = channelsPart.trim().split(/[\s,]+/).filter(Boolean)
    if (parts.length < 3) return null
    const r = parsePercentOrNumber(parts[0], 255)
    const g = parsePercentOrNumber(parts[1], 255)
    const b = parsePercentOrNumber(parts[2], 255)
    let a = 1
    const alphaRaw = alphaPart !== undefined ? alphaPart.trim() : parts[3]
    if (alphaRaw !== undefined) a = parsePercentOrNumber(alphaRaw, 1)
    if ([r, g, b, a].some((n) => Number.isNaN(n))) return null
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a }
  }

  // oklch(): L C H or L C H / A ; L may be % or 0-1 number
  const oklchMatch = /^oklch\(([^)]+)\)$/i.exec(s)
  if (oklchMatch) {
    const body = oklchMatch[1]
    const [channelsPart, alphaPart] = body.split('/')
    const parts = channelsPart.trim().split(/\s+/).filter(Boolean)
    if (parts.length < 3) return null
    const L = parsePercentOrNumber(parts[0], 1)
    const C = Number.parseFloat(parts[1])
    const H = Number.parseFloat(parts[2])
    if ([L, C, H].some((n) => Number.isNaN(n))) return null
    let a = 1
    const alphaRaw = alphaPart !== undefined ? alphaPart.trim() : undefined
    if (alphaRaw !== undefined) a = parsePercentOrNumber(alphaRaw, 1)
    const [r, g, b] = oklchToRgb(L, C, H)
    return { r, g, b, a }
  }

  return null
}

export function nearestColorToken(
  rgba: RGBA,
  tokens: ColorToken[]
): { token: ColorToken; distance: number } | null {
  let best: { token: ColorToken; distance: number } | null = null
  for (const token of tokens) {
    const parsed = parseColor(token.value)
    if (!parsed) continue
    const dr = rgba.r - parsed.r
    const dg = rgba.g - parsed.g
    const db = rgba.b - parsed.b
    const distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db
    if (!best || distance < best.distance) best = { token, distance }
  }
  return best
}

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(rgba: RGBA): number {
  const r = srgbToLinear(rgba.r)
  const g = srgbToLinear(rgba.g)
  const b = srgbToLinear(rgba.b)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const composited: RGBA = {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  }
  const L1 = relativeLuminance(composited)
  const L2 = relativeLuminance(bg)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  const ratio = (hi + 0.05) / (lo + 0.05)
  return Math.round(ratio * 100) / 100
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
  // M-D min/max sizing — Tailwind v4 sizes these off the same numeric spacing scale as w/h.
  // Named container widths (max-w-md …) are deliberately out of the picker's first pass
  // (spec M-D); nearest-token resolves numerically.
  'min-width': 'min-w',
  'max-width': 'max-w',
  'min-height': 'min-h',
  'max-height': 'max-h',
  'border-radius': 'rounded',
  'border-top-left-radius': 'rounded-tl',
  'border-top-right-radius': 'rounded-tr',
  'border-bottom-right-radius': 'rounded-br',
  'border-bottom-left-radius': 'rounded-bl',
  opacity: 'opacity',
  gap: 'gap',
  'border-width': 'border',
}

// Tailwind's border-width scale is a small fixed set (0, 2, 4, 8px), plus a bare `border`
// utility standing in for the 1px default — not a linear multiple of the spacing scale like
// padding/margin, so it gets its own lookup table rather than routing through the generic
// steps-of-spacingBasePx math below.
const BORDER_WIDTH_SCALE: Record<number, string> = {
  0: 'border-0',
  1: 'border',
  2: 'border-2',
  4: 'border-4',
  8: 'border-8',
}

// color-bearing props → utility prefix (kept separate from UTILITY_PREFIXES so
// findExistingUtility can apply prop-specific suffix-shape guards for border-color)
const COLOR_PREFIXES: Record<string, string> = {
  'background-color': 'bg',
  color: 'text',
  'border-color': 'border',
}

const RADIUS_PROPS = new Set(
  Object.keys(UTILITY_PREFIXES).filter((p) => p.includes('radius'))
)

function suggestColorUtility(
  prefix: string,
  css: string,
  tokens: Tokens | undefined
): { utility: string; tokenExact: boolean } | null {
  const parsed = parseColor(css)
  if (!parsed) return null

  // Fully-transparent (alpha 0) always maps to `-transparent` regardless of the r/g/b
  // channels — a measured "rgba(0, 0, 0, 0)" must not be mistaken for opaque black just
  // because its channels happen to match a black token.
  if (parsed.a === 0) {
    return { utility: `${prefix}-transparent`, tokenExact: true }
  }

  const colorTokens = tokens?.colors ?? []
  for (const token of colorTokens) {
    const tokenParsed = parseColor(token.value)
    if (!tokenParsed) continue
    // Only claim an exact token match when the token itself is (essentially) opaque —
    // a semi-transparent measured color must never claim an opaque token's utility name,
    // even when its r/g/b channels coincide with that token's.
    if (tokenParsed.a <= 0.996) continue
    if (
      Math.abs(tokenParsed.r - parsed.r) <= 1 &&
      Math.abs(tokenParsed.g - parsed.g) <= 1 &&
      Math.abs(tokenParsed.b - parsed.b) <= 1 &&
      parsed.a > 0.996
    ) {
      return { utility: `${prefix}-${token.name}`, tokenExact: true }
    }
  }

  const arbitrary = css.trim().replace(/\s+/g, '')
  return { utility: `${prefix}-[${arbitrary}]`, tokenExact: false }
}

// Tailwind's 9 named font-weight utilities — the only font-weight utilities recognized by
// findExistingUtility (font-sans/serif/mono share the `font-` prefix but are FAMILY utilities,
// not weight, and must never be mistaken for one).
const FONT_WEIGHT_UTILITIES: Record<string, string> = {
  100: 'font-thin',
  200: 'font-extralight',
  300: 'font-light',
  400: 'font-normal',
  500: 'font-medium',
  600: 'font-semibold',
  700: 'font-bold',
  800: 'font-extrabold',
  900: 'font-black',
}
const FONT_WEIGHT_SUFFIXES = new Set(Object.values(FONT_WEIGHT_UTILITIES).map((u) => u.slice('font-'.length)))

function suggestFontSizeUtility(
  css: string,
  tokens: Tokens | undefined
): { utility: string; tokenExact: boolean } {
  const px = Number.parseFloat(css)
  for (const token of tokens?.textScale ?? []) {
    if (Math.abs(token.px - px) < 0.5) return { utility: `text-${token.name}`, tokenExact: true }
  }
  return { utility: `text-[${px}px]`, tokenExact: false }
}

function suggestFontWeightUtility(css: string): { utility: string; tokenExact: boolean } {
  const n = Number.parseFloat(css)
  const named = FONT_WEIGHT_UTILITIES[n]
  if (named) return { utility: named, tokenExact: true }
  return { utility: `font-[${css.trim()}]`, tokenExact: false }
}

export function suggestUtility(
  prop: string,
  css: string,
  theme: Theme,
  tokens?: Tokens
): { utility: string; tokenExact: boolean } | null {
  const colorPrefix = COLOR_PREFIXES[prop]
  if (colorPrefix) {
    if (theme.spacingBasePx === null) return null
    return suggestColorUtility(colorPrefix, css, tokens)
  }

  if (prop === 'font-size') {
    if (theme.spacingBasePx === null) return null
    return suggestFontSizeUtility(css, tokens)
  }
  if (prop === 'font-weight') {
    if (theme.spacingBasePx === null) return null
    return suggestFontWeightUtility(css)
  }

  const prefix = UTILITY_PREFIXES[prop]
  if (!prefix || theme.spacingBasePx === null) return null

  // Keyword drafts (Hug's auto, min/max clearing) map to real static utilities, not px math —
  // without this, the numeric path below would emit `${prefix}-[NaNpx]` (E2E-caught in M-D).
  // width/height's 'auto' is Hug mode; min-width/min-height's CSS initial value is 'auto' and
  // max-width/max-height's is 'none' (both real static Tailwind utilities: min-w-auto,
  // max-w-none, ...) — Number.parseFloat('auto'/'none') would otherwise fall through to NaN.
  const CLEAR_KEYWORDS: Record<string, string[]> = {
    auto: ['width', 'height', 'min-width', 'min-height'],
    none: ['max-width', 'max-height'],
  }
  if (CLEAR_KEYWORDS[css]?.includes(prop)) return { utility: `${prefix}-${css}`, tokenExact: true }

  if (prop === 'opacity') {
    const pct = Number.parseFloat(css) * 100
    const rounded = Math.round(pct)
    if (Math.abs(pct - rounded) < 0.001) {
      return { utility: `opacity-${rounded}`, tokenExact: true }
    }
    return { utility: `opacity-[${css}]`, tokenExact: false }
  }

  const px = Number.parseFloat(css)

  if (prop === 'border-width') {
    const scaled = BORDER_WIDTH_SCALE[px]
    if (scaled) return { utility: scaled, tokenExact: true }
    return { utility: `border-[${px}px]`, tokenExact: false }
  }

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

// single-letter side/axis suffixes that make a border-<x> class a WIDTH utility
// (border-t, border-r, border-b, border-l), optionally followed by a numeric width
// (border-t-2) — NOT a color utility. Tightened to require the suffix be EXACTLY the side
// letter (optionally `-<digits>`), so a color utility like `border-t-red-500` (side letter
// followed by a color family-shade, not a number) no longer misreads as a width utility.
const BORDER_SIDE_SUFFIX = /^[trblxy](-\d+)?$/

// A suffix is "color-shaped" — the shape findExistingUtility requires before treating a
// bg-*/text-*/border-* class as a COLOR utility, not some other same-prefixed utility
// (text-lg is a font-size, bg-cover/bg-gradient-to-r are background shorthand utilities).
// Three shapes: a family-shade pair (red-500, neutral-900, ...), one of the bare color
// keywords Tailwind ships (white/black/transparent/current/inherit), or an arbitrary value
// containing an actual color notation (#hex, rgb(), hsl(), oklch(), or a --color-* var()).
const COLOR_KEYWORD_SUFFIXES = new Set(['white', 'black', 'transparent', 'current', 'inherit'])
const FAMILY_SHADE_SUFFIX = /^[a-z]+-\d{2,3}$/

function isColorShapedSuffix(suffix: string): boolean {
  if (FAMILY_SHADE_SUFFIX.test(suffix)) return true
  if (COLOR_KEYWORD_SUFFIXES.has(suffix)) return true
  if (suffix.startsWith('[') && suffix.endsWith(']')) {
    const inner = suffix.slice(1, -1)
    return /#|rgb|hsl|oklch|var\(--color/i.test(inner)
  }
  return false
}

// A suffix is "size-shaped" — the shape findExistingUtility requires for a text-* class to
// be read as a FONT-SIZE utility (text-lg, text-[20px]) rather than a color (text-neutral-900).
// Symmetric with isColorShapedSuffix: a bare scale name (letters/digits, no embedded '-<digits>'
// family-shade pattern) or an arbitrary px/rem value.
function isSizeShapedSuffix(suffix: string): boolean {
  if (FAMILY_SHADE_SUFFIX.test(suffix)) return false // that shape is a color, not a size
  if (suffix.startsWith('[') && suffix.endsWith(']')) {
    const inner = suffix.slice(1, -1)
    return /^[\d.]+(px|rem)$/.test(inner)
  }
  return /^[a-z0-9]+$/i.test(suffix)
}

export function findExistingUtility(className: string, prop: string): string | null {
  if (prop === 'font-weight') return findFontWeightUtility(className)

  const colorPrefix = COLOR_PREFIXES[prop]
  const prefix = prop === 'font-size' ? 'text' : (colorPrefix ?? UTILITY_PREFIXES[prop])
  if (!prefix) return null
  for (const cls of className.split(/\s+/)) {
    if (cls.includes(':')) continue // variant-prefixed — out of scope for detection
    const bare = cls.startsWith('-') ? cls.slice(1) : cls
    if (prefix === 'rounded' && bare === 'rounded') return cls
    // bare `border` (no suffix) is the 1px-default WIDTH utility, not a color
    if (prop === 'border-width' && bare === 'border') return cls
    if (!bare.startsWith(`${prefix}-`)) continue
    const suffix = bare.slice(prefix.length + 1)
    // guard: 'rounded-' must not match 'rounded-tl-…' (a longer registered prefix)
    const corner = /^(tl|tr|br|bl)(-|$)/.test(suffix)
    if (prefix === 'rounded' && corner) continue
    if (colorPrefix) {
      // 'border-2' (width) and 'border-t'/'border-t-2' (side width) are not colors
      if (/^\d+$/.test(suffix)) continue
      if (BORDER_SIDE_SUFFIX.test(suffix)) continue
      if (!isColorShapedSuffix(suffix)) continue
    }
    if (prop === 'border-width') {
      // only numeric widths and side-width variants are WIDTH utilities — 'border-slate-400'
      // (a color) must not match here
      if (!/^\d+$/.test(suffix) && !BORDER_SIDE_SUFFIX.test(suffix)) continue
    }
    if (prop === 'font-size' && !isSizeShapedSuffix(suffix)) continue
    return cls
  }
  return null
}

function findFontWeightUtility(className: string): string | null {
  for (const cls of className.split(/\s+/)) {
    if (cls.includes(':')) continue
    if (cls.startsWith('font-') && FONT_WEIGHT_SUFFIXES.has(cls.slice('font-'.length))) return cls
  }
  return null
}

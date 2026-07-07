import type { TaggedElement } from './source'
import { DraftStore } from './drafts'
import { UTILITY_PREFIXES, parseColor, type Theme, type Tokens } from './tokens'
import type { ColorEntry, ScaleEntry } from './tokenpicker'
import { hasDirectText, marginSectionVisible, isFlex, mainAxisProp } from './panel-readers'

export interface RowSpec {
  label: string
  props: string[]
  min?: number
  max?: number
  toCss?: (n: number) => string
  fromCss?: (css: string) => number
  /** When true (W/H rows), a sizing chevron menu button (Fixed/Hug/Fill, ui/menu.ts) renders
   * next to the field. */
  sizeMode?: boolean
  /** When true (e.g. LH), the field accepts the literal keyword `auto` and displays it via setAuto(). */
  allowAuto?: boolean
  /** Draft value to apply when the user types the `auto` keyword (only meaningful with allowAuto). */
  autoCss?: string
  /**
   * Fired once per prop, immediately before that prop's value is drafted (after onBeforeEdit,
   * before drafts.apply). Used by Stroke's width fields: drafting a border-*-width while the
   * computed border-*-style is 'none' also drafts border-*-style: solid (one-time), so a
   * newly-drafted width is actually visible. Receives the live DraftStore so it can read/write
   * drafts itself (SECTIONS is a module-level const and can't close over a Panel instance).
   */
  onBeforeApply?: (el: TaggedElement, prop: string, drafts: DraftStore) => void
}

export interface SectionSpec {
  title: string
  rows: RowSpec[]
  expandKey?: string
  expandRows?: RowSpec[]
  /** Section renders always (stable DOM order) but is hidden via the `hidden` attribute when this returns false. */
  visible?: (el: TaggedElement, drafts?: DraftStore) => boolean
  /** Custom section body — used by Layout, which isn't a plain row-field grid. */
  custom?: 'layout' | 'typography' | 'fill' | 'stroke'
  /** Tooltip (title attr) on the section title — used where the section name itself needs explaining (Margin). */
  hint?: string
}

const RADIUS = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']

const BORDER_WIDTH_PROPS = ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']
const BORDER_STYLE_PROPS = ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style']
const BORDER_COLOR_PROPS = ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']

// Gap isn't built via buildField/RowSpec (it's a bespoke NumberField inside the Layout
// section's custom body — see buildLayoutSection), but it still needs a RowSpec-shaped
// object so tokenEntriesFor/pillLabelFor (both keyed on `.props`) and the boundTokens map
// (keyed on `.props.join(',')`) can treat it identically to every other token-pickable field.
const GAP_SPEC: RowSpec = { label: 'Gap', props: ['gap'], min: 0 }

// Tailwind's numeric spacing scale (padding/margin/gap/width/height) — each step n maps to
// n * theme.spacingBasePx. Kept as a flat literal list (not generated) so the exact set —
// including the half-steps (0.5, 1.5, ...) and the post-12 non-uniform stride (14, 16, 20, ...) —
// is easy to eyeball against Tailwind's own docs.
const SPACING_SCALE = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64,
  72, 80, 96,
]

// RowSpec.props arrays with length > 1 that correspond to a single Tailwind synthetic/shorthand
// utility prefix not derivable from any individual longhand's own UTILITY_PREFIXES entry (e.g.
// ['padding-left','padding-right'] should resolve to 'px', not 'pl' from props[0]). Keyed by the
// joined prop list (order matches each RowSpec's own `props` array above). Stroke's W field
// (BORDER_WIDTH_PROPS) has no entry here — border-width isn't part of Tailwind's linear spacing
// scale (see tokens.ts's own separate BORDER_WIDTH_SCALE) and tokenEntriesFor returns null for
// it, so buildField never wires onTokenOpen for that field (no icon, `=` inert) and pillLabelFor is
// never reached for it either.
const MULTI_PROP_SYNTHETIC: Record<string, string> = {
  [['padding-left', 'padding-right'].join(',')]: 'padding-inline',
  [['padding-top', 'padding-bottom'].join(',')]: 'padding-block',
  [['margin-left', 'margin-right'].join(',')]: 'margin-inline',
  [['margin-top', 'margin-bottom'].join(',')]: 'margin-block',
  [RADIUS.join(',')]: 'border-radius',
}

/** Resolves a RowSpec's `props` array to its Tailwind utility prefix (e.g. 'px', 'rounded', 'w'). */
function utilityPrefixFor(props: string[]): string | undefined {
  if (props.length === 1) return UTILITY_PREFIXES[props[0]]
  const synthetic = MULTI_PROP_SYNTHETIC[props.join(',')]
  return synthetic ? UTILITY_PREFIXES[synthetic] : undefined
}

/**
 * Tooltip text bridging a row to its CSS props and Tailwind utility ("padding-left,
 * padding-right → px-*"). Derived via utilityPrefixFor from the same UTILITY_PREFIXES map
 * request.ts emits from, so a hint that names a utility can never drift from what request.ts
 * emits; rows the utility map doesn't cover (font-size, stroke width) fall back to the bare
 * CSS prop list.
 */
export function cssHintFor(spec: { props: string[] }): string {
  // font-size maps to text-* on the request path via a special case in tokens.ts (the 'text'
  // prefix is shared with color utilities, so it can't live in UTILITY_PREFIXES) — mirror it
  // here so the S field's tooltip names the utility the request will actually emit.
  if (spec.props.includes('font-size')) return 'font-size → text-*'
  const css = spec.props.join(', ')
  const prefix = utilityPrefixFor(spec.props)
  return prefix ? `${css} → ${prefix}-*` : css
}

const RADIUS_PROP_SET = new Set(RADIUS)

/**
 * Scale source for the `=` token picker (B5), keyed by RowSpec.props. Spacing props (padding/
 * margin/gap/width/height) resolve through Tailwind's numeric scale x theme.spacingBasePx;
 * radius props through theme.radiusScale; font-size through the text scale; everything else
 * (e.g. opacity) has no token picker and returns null.
 */
export function tokenEntriesFor(spec: { props: string[] }, theme: Theme, tokens: Tokens): ScaleEntry[] | null {
  if (spec.props.some((p) => p === 'font-size')) {
    const entries = tokens.textScale.map((t) => ({ label: t.name, px: t.px }))
    return entries.length === 0 ? null : entries
  }
  if (spec.props.some((p) => RADIUS_PROP_SET.has(p))) {
    const entries = Object.entries(theme.radiusScale).map(([label, px]) => ({ label, px }))
    return entries.length === 0 ? null : entries
  }
  const prefix = utilityPrefixFor(spec.props)
  const isSpacingProp = prefix !== undefined && prefix !== 'opacity' && prefix !== 'border'
  if (isSpacingProp) {
    if (theme.spacingBasePx === null) return null
    const base = theme.spacingBasePx
    return SPACING_SCALE.map((n) => ({ label: String(n), px: n * base }))
  }
  return null
}

/** Named color-token entries for the color rows' `{ }` icon — null when the theme defines
 * no (parseable) color tokens, which suppresses the icon entirely (spec: no empty dropdowns). */
export function colorTokenEntries(tokens: Tokens): ColorEntry[] | null {
  const entries = tokens.colors
    .filter((t) => parseColor(t.value) !== null)
    .map((t) => ({ label: t.name, color: t.value }))
  return entries.length === 0 ? null : entries
}

/** border-top-width -> border-top-style (matches each width longhand to its side's style longhand). */
function styleForWidthProp(widthProp: string): string {
  return widthProp.replace('-width', '-style')
}

/**
 * Drafting a border width only becomes visible if the side actually has a style — a computed
 * `border-style: none` swallows any width. So the FIRST time a width is drafted while the
 * computed style for that side is 'none', also draft that side's style to 'solid' (one-time —
 * a later width edit while style is already something else must not stomp a user-chosen style).
 */
function draftSolidIfNone(el: TaggedElement, widthProp: string, drafts: DraftStore): void {
  const styleProp = styleForWidthProp(widthProp)
  const draftStyle = drafts.current(el, styleProp)
  // jsdom reports '' rather than the spec default 'none' for an unset border-style — treat
  // both as "no visible border yet" so the auto-solid behavior works in tests and browsers alike.
  const computedStyle = draftStyle ?? getComputedStyle(el).getPropertyValue(styleProp)
  if (computedStyle === 'none' || computedStyle === '') drafts.apply(el, styleProp, 'solid')
}

/**
 * Typing/scrubbing/token-picking a main-axis size means Fixed intent; on an app-CSS `flex-1`
 * element the number would otherwise be a silent no-op (basis 0% + grow still win the main-axis
 * sizing over an authored width). This is the same defeat onSizeModeChange's Fixed/Hug branches
 * perform (panel-layout.ts) — kept as ONE shared implementation, exported here and called from
 * both places, rather than two copies that could drift.
 */
export function defeatFillIfGrowing(el: TaggedElement, prop: string, drafts: DraftStore): void {
  const parent = el.parentElement
  if (!parent || !isFlex(parent as TaggedElement)) return
  const direction = getComputedStyle(parent).flexDirection.startsWith('column') ? 'column' : 'row'
  if (prop !== mainAxisProp(direction)) return
  const grow = Number.parseFloat(drafts.current(el, 'flex-grow') ?? getComputedStyle(el).getPropertyValue('flex-grow') ?? '0')
  if (grow >= 1) {
    drafts.apply(el, 'flex-grow', '0')
    drafts.apply(el, 'flex-basis', 'auto')
  }
}

const WEIGHTS: Array<[value: string, label: string]> = [
  ['100', 'Thin'],
  ['200', 'Extra Light'],
  ['300', 'Light'],
  ['400', 'Regular'],
  ['500', 'Medium'],
  ['600', 'Semibold'],
  ['700', 'Bold'],
  ['800', 'Extra Bold'],
  ['900', 'Black'],
]

// Canonical option tables for the panel's selects — panel.ts and the Storybook select
// stories both import these, so the catalog can't drift from the shipped dropdowns.
const STROKE_STYLES: Array<[value: string, label: string]> = [
  ['none', 'None'],
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
]

const SIZE_MODES: Array<[value: string, label: string]> = [
  ['fixed', 'Fixed'],
  ['hug', 'Hug'],
  ['fill', 'Fill'],
]

// The W/H specs — rendered as the first two rows of the unified Layout section body
// (spec M-C). Exported so panel.ts's buildBody layout branch can compose them directly.
const SIZE_ROWS: RowSpec[] = [
  { label: 'W', props: ['width'], min: 0, sizeMode: true, onBeforeApply: defeatFillIfGrowing },
  { label: 'H', props: ['height'], min: 0, sizeMode: true, onBeforeApply: defeatFillIfGrowing },
]

// The padding H/V specs — rendered inside the padding block of the unified Layout section
// body (spec M-C; reordered 2026-07-06 layout-polish spec), after the auto-layout cluster
// and before the align block. Exported so panel.ts's buildBody layout branch can compose
// them directly.
const PADDING_ROWS: RowSpec[] = [
  { label: 'H', props: ['padding-left', 'padding-right'], min: 0 },
  { label: 'V', props: ['padding-top', 'padding-bottom'], min: 0 },
]

// M-D min/max sizing (spec M-D): disclosure rows under W/H, derived from the size row they
// constrain (rather than a positional slice of a flat 4-entry array) so W and H can never
// desync from their own min/max pair. Typing `auto` clears the constraint — autoCss carries
// each property's CSS initial value (min-*: auto, max-*: none), so the request says "remove
// the constraint" in keywords, never a measured px.
// Labels are axis-qualified (Min W / Max H) because the rows sit below the side-by-side W|H
// pair (2026-07-06 size-pair spec), no longer nested under their axis.
export function minMaxRowsFor(sizeSpec: RowSpec): RowSpec[] {
  const p = sizeSpec.props[0] // 'width' | 'height'
  return [
    { label: `Min ${sizeSpec.label}`, props: [`min-${p}`], min: 0, allowAuto: true, autoCss: 'auto' },
    { label: `Max ${sizeSpec.label}`, props: [`max-${p}`], min: 0, allowAuto: true, autoCss: 'none' },
  ]
}

// Section ORDER is fixed forever: Layout -> Margin -> Typography -> Fill -> Stroke -> Appearance.
const SECTIONS: SectionSpec[] = [
  {
    title: 'Layout',
    rows: [],
    custom: 'layout',
    expandKey: 'padding',
    expandRows: [
      { label: 'T', props: ['padding-top'], min: 0 },
      { label: 'R', props: ['padding-right'], min: 0 },
      { label: 'B', props: ['padding-bottom'], min: 0 },
      { label: 'L', props: ['padding-left'], min: 0 },
    ],
    // Unified UI3 section (spec M-C; reordered 2026-07-06 layout-polish spec): W/H rows ->
    // auto-layout cluster -> padding block -> align block, one fixed order, flex or not. The
    // cluster alone is single-select-only (B6); rows keep multi relative-delta behavior.
  },
  {
    title: 'Margin',
    expandKey: 'margin',
    rows: [
      { label: 'H', props: ['margin-left', 'margin-right'] },
      { label: 'V', props: ['margin-top', 'margin-bottom'] },
    ],
    expandRows: [
      { label: 'T', props: ['margin-top'] },
      { label: 'R', props: ['margin-right'] },
      { label: 'B', props: ['margin-bottom'] },
      { label: 'L', props: ['margin-left'] },
    ],
    visible: marginSectionVisible,
    hint: 'Space this element adds around itself (CSS margin) — shown only when the element actually has margins',
  },
  {
    title: 'Typography',
    rows: [],
    custom: 'typography',
    visible: hasDirectText,
  },
  {
    title: 'Fill',
    rows: [],
    custom: 'fill',
  },
  {
    title: 'Stroke',
    rows: [],
    custom: 'stroke',
    expandKey: 'stroke',
    expandRows: [
      { label: 'T', props: ['border-top-width'], min: 0, onBeforeApply: draftSolidIfNone },
      { label: 'R', props: ['border-right-width'], min: 0, onBeforeApply: draftSolidIfNone },
      { label: 'B', props: ['border-bottom-width'], min: 0, onBeforeApply: draftSolidIfNone },
      { label: 'L', props: ['border-left-width'], min: 0, onBeforeApply: draftSolidIfNone },
    ],
  },
  {
    title: 'Appearance',
    expandKey: 'radius',
    rows: [
      { label: 'R', props: RADIUS, min: 0 },
      {
        label: 'O',
        props: ['opacity'],
        min: 0,
        max: 100,
        toCss: (n) => String(n / 100),
        fromCss: (css) => {
          const n = Number.parseFloat(css)
          return Math.round((Number.isFinite(n) ? n : 1) * 100)
        },
      },
    ],
    expandRows: [
      { label: 'TL', props: ['border-top-left-radius'], min: 0 },
      { label: 'TR', props: ['border-top-right-radius'], min: 0 },
      { label: 'BR', props: ['border-bottom-right-radius'], min: 0 },
      { label: 'BL', props: ['border-bottom-left-radius'], min: 0 },
    ],
  },
]

export {
  RADIUS,
  BORDER_WIDTH_PROPS,
  BORDER_STYLE_PROPS,
  BORDER_COLOR_PROPS,
  GAP_SPEC,
  SPACING_SCALE,
  MULTI_PROP_SYNTHETIC,
  utilityPrefixFor,
  RADIUS_PROP_SET,
  styleForWidthProp,
  draftSolidIfNone,
  WEIGHTS,
  STROKE_STYLES,
  SIZE_MODES,
  SIZE_ROWS,
  PADDING_ROWS,
  SECTIONS,
}

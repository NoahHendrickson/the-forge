import type { TaggedElement } from './source'
import { DraftStore } from './drafts'
import { parseColor as parseColorLocal } from './tokens'

const px = (n: number): string => `${n}px`
const fromPx = (css: string): number => Math.round(Number.parseFloat(css) || 0)

/**
 * Walks up from `el` (starting at el itself) for the first ancestor whose (draft-or-computed)
 * background-color has alpha > 0 — the color a Text/Stroke swatch would actually be seen
 * against. Falls back to white when no ancestor paints a background (the page's default canvas).
 */
function effectiveBackground(el: TaggedElement, drafts: DraftStore): string {
  let node: Element | null = el
  while (node) {
    const draft = drafts.isComparing(node as TaggedElement) ? null : drafts.current(node as TaggedElement, 'background-color')
    const css = draft ?? getComputedStyle(node).getPropertyValue('background-color')
    const parsed = parseColorLocal(css)
    if (parsed && parsed.a > 0) return css
    node = node.parentElement
  }
  return '#fff'
}

function isFlex(el: TaggedElement): boolean {
  const d = getComputedStyle(el).display
  return d === 'flex' || d === 'inline-flex'
}

/**
 * Normalizes a computed justify-content keyword to the matrix's flex-start|center|flex-end
 * vocabulary. Display-only: drafts still store whatever canonical keyword the user clicked.
 * An untouched flex container reports 'normal' (real browsers) or '' (jsdom) rather than
 * 'flex-start', so without this the matrix would show zero active dots by default.
 */
export function normalizeJustify(justify: string): string {
  if (justify === 'normal' || justify === 'start' || justify === 'left' || justify === '') return 'flex-start'
  if (justify === 'end' || justify === 'right') return 'flex-end'
  return justify
}

/**
 * Normalizes a computed align-items keyword the same way as normalizeJustify, except
 * 'stretch' is intentionally left as-is (not mapped to a matrix keyword) — stretch is
 * represented by the child's W/H size mode being Fill, not a matrix position, so it must
 * continue to produce no active dot.
 */
export function normalizeAlign(align: string): string {
  if (align === 'normal' || align === 'start' || align === '') return 'flex-start'
  if (align === 'end') return 'flex-end'
  return align
}

/** True when `el` has a direct child text node with non-whitespace content (element children don't count). */
export function hasDirectText(el: Element): boolean {
  return [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '')
}

const MARGIN_PROPS = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']

/**
 * Margin-section disclosure (spec 2026-07-05, decision 2): designers don't set margins, so
 * the section renders only when the element actually carries some — any computed margin that
 * isn't zero (negative and `auto` margins count), OR any live margin draft. The draft clause
 * is the mid-edit latch: scrubbing a margin to 0 keeps the draft (and thus the section) alive
 * under the pointer; it only disappears once the element genuinely has no margin and no
 * pending edit. jsdom reports '' for an unset margin — treat as zero (same quirk handling as
 * draftSolidIfNone's border-style read).
 */
export function marginSectionVisible(el: TaggedElement, drafts?: DraftStore): boolean {
  const computed = getComputedStyle(el)
  return MARGIN_PROPS.some((p) => {
    if (drafts && drafts.current(el, p) !== null) return true
    const v = computed.getPropertyValue(p)
    return v !== '' && v !== '0px'
  })
}

/** Snaps a computed font-weight keyword/number to one of the 9 named-weight values. */
function snapWeight(css: string): string {
  if (css === 'normal') return '400'
  if (css === 'bold') return '700'
  const n = Number.parseFloat(css)
  if (!Number.isFinite(n)) return '400'
  // Snap to the nearest named weight (100-900, step 100).
  return String(Math.min(900, Math.max(100, Math.round(n / 100) * 100)))
}

/** Unquotes a computed font-family's first entry for display (e.g. `"Georgia"` -> `Georgia`). */
function firstFamily(computedFontFamily: string): string {
  const first = computedFontFamily.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]|['"]$/g, '')
}

/** Quotes a family name for use in a font-family CSS value if it contains whitespace. */
function cssFamilyValue(name: string): string {
  return /\s/.test(name) ? `"${name}"` : name
}

/** Enumerates unique font families from document.fonts, feature-detecting its absence (jsdom). */
function documentFontFamilies(): string[] {
  const fonts: unknown = (document as unknown as { fonts?: Iterable<{ family: string; status?: string }> }).fonts
  if (!fonts || typeof (fonts as Iterable<unknown>)[Symbol.iterator] !== 'function') return []
  const seen = new Set<string>()
  for (const face of fonts as Iterable<{ family: string; status?: string }>) {
    if (face.status !== undefined && face.status !== 'loaded') continue
    seen.add(face.family.replace(/^['"]|['"]$/g, ''))
  }
  return [...seen]
}

/** Direction the SIZE dimension corresponds to on the parent's flex axis. */
function mainAxisProp(direction: string): 'width' | 'height' {
  return direction === 'column' ? 'height' : 'width'
}

export { px, fromPx, effectiveBackground, isFlex, snapWeight, firstFamily, cssFamilyValue, documentFontFamilies, mainAxisProp }

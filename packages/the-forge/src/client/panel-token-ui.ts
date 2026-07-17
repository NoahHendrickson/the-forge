import type { TaggedElement } from './source'
import { NumberField, createTokenButton } from './controls'
import { TokenPicker, type ScaleEntry } from './tokenpicker'
import { utilityPrefixFor, tokenEntriesFor, colorTokenEntries, type RowSpec } from './panel-specs'
import { nearestColorToken, readTokens, readTheme, parseColor as parseColorLocal, rgbToHex } from './tokens'

/**
 * Full Tailwind utility label for a token-picker entry applied to `spec` (e.g. `px-4`,
 * `rounded-md`, `text-sm`). Radius rows are NOT special-cased to `rounded-*` uniformly —
 * a single-corner row (TL/TR/BR/BL, props.length === 1) must yield its own honest
 * `rounded-tl-md`-style label via UTILITY_PREFIXES (utilityPrefixFor resolves each
 * longhand's own prefix), while the linked R row (all 4 corners) resolves through
 * MULTI_PROP_SYNTHETIC to the collapsed `rounded-md` form.
 */
export function pillLabelFor(spec: RowSpec, entry: ScaleEntry): string {
  if (spec.props.some((p) => p === 'font-size')) return `text-${entry.label}`
  const prefix = utilityPrefixFor(spec.props) ?? spec.props[0]
  return `${prefix}-${entry.label}`
}

/** One-parse, one-palette-scan reader for a color value's display state: the chip text
 * (exact token name, `transparent`, or short hex) plus whether it IS an exact token.
 * refresh() runs this per color row per tick — every scrub mousemove — so the parse and
 * the nearestColorToken scan must happen once, not once per question (PR #6 review:
 * the previous colorLabel/colorTokenName split parsed 3× and scanned 2× per refresh). */
export function colorDisplay(css: string): { text: string; token: boolean } {
  const parsed = parseColorLocal(css)
  if (!parsed) return { text: css, token: false }
  // Fully-transparent always renders as the literal keyword — a nearest-token guess (which
  // only compares r/g/b) would otherwise report some opaque color's name for a color that's
  // actually invisible.
  if (parsed.a === 0) return { text: 'transparent', token: false }
  // Token names are only claimed for fully-opaque colors — a semi-transparent value must
  // show its own hex (with alpha) rather than borrowing an opaque token's name, even when
  // the r/g/b channels coincide.
  if (parsed.a === 1) {
    const nearest = nearestColorToken(parsed, readTokens().colors)
    if (nearest && nearest.distance === 0) return { text: nearest.token.name, token: true }
  }
  return { text: rgbToHex(parsed.r, parsed.g, parsed.b, parsed.a), token: false }
}

export class PanelTokenUi {
  /** The shared popover. Exposed so Panel can wire cross-popover exclusion
   * (picker.beforeOpen) and lifecycle (close/destroy) without this module knowing
   * ColorPicker exists. */
  readonly picker: TokenPicker

  // Bound token pills, keyed by the owning field's spec.props.join(',') (a stable per-field
  // identity — see MULTI_PROP_SYNTHETIC above). B1's set()/setMixed()/setAuto() unconditionally
  // clear a field's pill state, so a plain refresh() would silently drop every bound pill even
  // when nothing about that field changed. This map lets refresh() re-apply bindToken() when
  // the field's current (draft-or-computed) value still matches what was bound — cleared
  // wholesale on selection change (show()), and per-entry when the value diverges (refresh()).
  private bound = new Map<string, { label: string; px: number }>()

  constructor(
    popoverParent: HTMLElement,
    private getEl: () => TaggedElement | null
  ) {
    this.picker = new TokenPicker(popoverParent)
  }

  /**
   * The one open-the-picker path for every numeric (scale-backed) field — gap and buildField
   * both wire their onTokenOpen here so the entries lookup, pill bind, and boundTokens
   * bookkeeping exist once (PR #6 review: previously three near-copies). `commitPx` is the
   * field's own absolute-commit path (identical to its onInput), applied before the pill
   * binds so refresh() sees the drafted value and the B5 re-bind contract holds.
   */
  openScalePicker(spec: RowSpec, field: NumberField, commitPx: (px: number) => void): void {
    if (!this.getEl()) return
    const entries = tokenEntriesFor(spec, readTheme(), readTokens())
    if (!entries) return
    this.picker.open({
      anchor: field.root,
      entries,
      onApply: (entry) => {
        commitPx(entry.px)
        const label = pillLabelFor(spec, entry)
        field.bindToken(label)
        this.bound.set(spec.props.join(','), { label, px: entry.px })
      },
    })
  }

  /** Color rows: the `{ }` button wired to the color-token dropdown. `applyColor` is
   * Panel's own apply dance (onBeforeEdit → onPick → refresh → onEdited). */
  colorTokenButton(row: HTMLElement, applyColor: (css: string) => void): HTMLButtonElement {
    return createTokenButton(() => {
      const entries = colorTokenEntries(readTokens())
      if (!entries || !this.getEl()) return
      this.picker.open({
        anchor: row,
        entries,
        onApply: (entry) => {
          applyColor(entry.color) // exact token value ⇒ request.ts emits bg-neutral-900 etc.
        },
      })
    })
  }

  /** Drop one field's pill bookkeeping (Backspace detach, auto-display supersedes pill). */
  drop(spec: { props: string[] }): void {
    this.bound.delete(spec.props.join(','))
  }

  /** Drop everything (selection change, drafts reset). */
  clear(): void {
    this.bound.clear()
  }

  /**
   * B5: the caller's field.set() above unconditionally cleared any pill (B1 contract) — re-apply it when
   * this field has a bound token AND the just-read value still equals the bound px
   * (same-field refresh with an unchanged draft). A DIFFERING value (user edited the
   * field directly, or a different draft arrived) leaves the pill cleared and drops
   * the stale entry from boundTokens so it doesn't keep getting checked forever.
   *
   * Compare mode is an exception to BOTH halves of that: while comparing, `values`
   * was read from the ORIGINAL (pre-draft) computed style, not the live draft, so it
   * diverging from bound.px is expected and must NOT be treated as "the user changed
   * it" — skip the delete so un-compare can still re-bind. And the pill itself must
   * stay hidden while comparing (a pristine-preview state showing a token pill would
   * lie about what's actually drafted), so skip the bindToken call too.
   */
  rebind(spec: { props: string[] }, field: NumberField, value: number | null, mixed: boolean, comparing: boolean): void {
    const key = spec.props.join(',')
    const bound = this.bound.get(key)
    if (!bound || comparing) return
    // `value` is `readValue`'s fromPx result — already rounded for display (panel-patterns
    // doc). `bound.px` is the token entry's exact px (fractional on non-integer scales, e.g.
    // a 3.75px spacing base's p-3.5 = 13.125px). Comparing them for exact equality compared
    // a rounded number against an unrounded one, so the pill self-deleted one refresh after
    // binding on any such theme. Compare in the rounded domain instead: survive when the
    // bound px rounds to (or within a hair of) the displayed value; a genuine ≥0.5px user
    // divergence still unbinds.
    if (!mixed && value !== null && Math.abs(bound.px - value) < 0.5) field.bindToken(bound.label)
    else this.bound.delete(key)
  }
}

import { parseColor, nearestColorToken, contrastRatio, readTokens, type Tokens, type RGBA } from './tokens'

export interface HSV {
  h: number
  s: number
  v: number
}

export interface RGB {
  r: number
  g: number
  b: number
}

/** Pure HSV -> RGB conversion. h in [0,360), s/v in [0,1]. */
export function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r1 = 0
  let g1 = 0
  let b1 = 0
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0]
  else if (hp < 2) [r1, g1, b1] = [x, c, 0]
  else if (hp < 3) [r1, g1, b1] = [0, c, x]
  else if (hp < 4) [r1, g1, b1] = [0, x, c]
  else if (hp < 5) [r1, g1, b1] = [x, 0, c]
  else [r1, g1, b1] = [c, 0, x]
  const m = v - c
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  }
}

/** Pure RGB -> HSV conversion. r/g/b in [0,255]. */
export function rgbToHsv(r: number, g: number, b: number): HSV {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6)
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2)
    else h = 60 * ((rn - gn) / delta + 4)
  }
  if (h < 0) h += 360

  const s = max === 0 ? 0 : delta / max
  const v = max

  return { h, s, v }
}

function clampByte(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)))
}

function rgbaCss(r: number, g: number, b: number, a: number): string {
  if (a >= 1) return `rgb(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)})`
  const alpha = Math.round(a * 100) / 100
  return `rgba(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)}, ${alpha})`
}

function badgeFor(ratio: number): string {
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA Large'
  return 'Fail'
}

export interface OpenOpts {
  /** Row to align to — popover sits within the panel, top set from this element's offsetTop. */
  anchor: HTMLElement
  /** Current css color to seed the picker's internal state from. */
  initial: string
  /** CSS color to compute the contrast ratio against; null hides the contrast line. */
  contrastAgainst: string | null
  /** Fired live on every change (drag, hex commit, hue, palette/hint click). */
  onPick: (css: string, meta: { token?: string }) => void
}

/**
 * One instance per Panel. Appended to the panel root, absolutely positioned, hidden by
 * default. `readTokens` is memoized globally, so tests inject tokens via the constructor's
 * `getTokens` param instead of relying on the module-level cache.
 */
export class ColorPicker {
  root = document.createElement('div')

  private svArea = document.createElement('div')
  private svThumb = document.createElement('div')
  private hueInput = document.createElement('input')
  private hexInput = document.createElement('input')
  private hintEl = document.createElement('div')
  private contrastEl = document.createElement('div')
  private paletteEl = document.createElement('div')

  private hsv: HSV = { h: 0, s: 0, v: 0 }
  private alpha = 1
  private onPick: ((css: string, meta: { token?: string }) => void) | null = null
  private contrastAgainst: string | null = null

  private svDragging = false
  private svListenersAttached = false
  private globalListenersAttached = false

  private outsideMousedown = (e: Event): void => {
    if (this.root.hidden) return
    // The picker lives inside the overlay's OPEN shadow root. A window-level listener
    // receives the RETARGETED event, whose `target` is the shadow HOST — not the actual
    // element under the cursor — so `this.root.contains(e.target)` is always false for a
    // click anywhere inside the shadow tree. `composedPath()[0]` gives the true original
    // target regardless of shadow boundaries; fall back to `e.target` where unavailable.
    const target = typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target
    if (target instanceof Node && this.root.contains(target)) return
    this.close()
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close()
  }

  constructor(
    panelRoot: HTMLElement,
    private getTokens: () => Tokens = readTokens
  ) {
    this.root.className = 'color-popover'
    this.root.hidden = true

    this.svArea.className = 'cp-sv'
    this.svThumb.className = 'cp-sv-thumb'
    this.svArea.append(this.svThumb)
    this.root.append(this.svArea)

    this.hueInput.type = 'range'
    this.hueInput.min = '0'
    this.hueInput.max = '360'
    this.hueInput.className = 'cp-hue'
    this.root.append(this.hueInput)

    const hexRow = document.createElement('div')
    hexRow.className = 'cp-hex-row'
    this.hexInput.type = 'text'
    this.hexInput.className = 'cp-hex'
    hexRow.append(this.hexInput)
    this.root.append(hexRow)

    this.hintEl.className = 'cp-hint'
    this.root.append(this.hintEl)

    this.contrastEl.className = 'cp-contrast'
    this.root.append(this.contrastEl)

    this.paletteEl.className = 'cp-palette'
    this.root.append(this.paletteEl)

    this.svArea.addEventListener('mousedown', (e) => this.startSvDrag(e))
    this.hueInput.addEventListener('input', () => this.onHueInput())
    this.hexInput.addEventListener('change', () => this.onHexChange())
    this.hintEl.addEventListener('click', () => this.onHintClick())

    panelRoot.append(this.root)
  }

  open(opts: OpenOpts): void {
    // Reselection while a picker is already open (or a stray SV drag mid-flight) must not
    // leak window listeners — clean up before rebinding state to the new element.
    this.removeSvListeners()

    this.onPick = opts.onPick
    this.contrastAgainst = opts.contrastAgainst

    const parsed = parseColor(opts.initial) ?? { r: 0, g: 0, b: 0, a: 1 }
    this.hsv = rgbToHsv(parsed.r, parsed.g, parsed.b)
    this.alpha = parsed.a

    this.root.hidden = false
    const top = (opts.anchor as unknown as { offsetTop: number }).offsetTop ?? 0
    this.root.style.top = `${top}px`

    this.renderPalette()
    this.renderAll()

    window.addEventListener('keydown', this.onKeydown)
    window.addEventListener('mousedown', this.outsideMousedown)
    this.globalListenersAttached = true
  }

  close(): void {
    this.root.hidden = true
    this.removeSvListeners()
    // close() is called defensively (every Panel.show()/hide()) even when the picker was
    // never opened — guard so a no-op close doesn't register a spurious removeEventListener.
    if (!this.globalListenersAttached) return
    window.removeEventListener('keydown', this.onKeydown)
    window.removeEventListener('mousedown', this.outsideMousedown)
    this.globalListenersAttached = false
  }

  /** Full teardown — removes any active window listeners. Call when the Panel itself is destroyed. */
  destroy(): void {
    this.close()
  }

  get currentRgb(): RGB {
    return hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v)
  }

  private currentCss(): string {
    const { r, g, b } = this.currentRgb
    return rgbaCss(r, g, b, this.alpha)
  }

  private emit(meta: { token?: string } = {}): void {
    this.onPick?.(this.currentCss(), meta)
  }

  private startSvDrag(e: Event): void {
    const me = e as MouseEvent
    this.svDragging = true
    this.updateSvFromEvent(me)
    window.addEventListener('mousemove', this.onSvMove)
    window.addEventListener('mouseup', this.onSvUp)
    this.svListenersAttached = true
  }

  private onSvMove = (e: MouseEvent): void => {
    if (!this.svDragging) return
    this.updateSvFromEvent(e)
  }

  private onSvUp = (): void => {
    this.svDragging = false
    this.removeSvListeners()
  }

  private removeSvListeners(): void {
    if (!this.svListenersAttached) return
    this.svDragging = false
    window.removeEventListener('mousemove', this.onSvMove)
    window.removeEventListener('mouseup', this.onSvUp)
    this.svListenersAttached = false
  }

  private updateSvFromEvent(e: MouseEvent): void {
    const rect = this.svArea.getBoundingClientRect()
    const width = rect.width || 1
    const height = rect.height || 1
    const x = Math.min(width, Math.max(0, e.clientX - rect.left))
    const y = Math.min(height, Math.max(0, e.clientY - rect.top))
    this.hsv = { h: this.hsv.h, s: x / width, v: 1 - y / height }
    this.renderAll()
    this.emit()
  }

  private onHueInput(): void {
    const h = Number.parseFloat(this.hueInput.value) || 0
    this.hsv = { ...this.hsv, h }
    this.renderAll()
    this.emit()
  }

  private onHexChange(): void {
    const parsed = parseColor(this.hexInput.value.trim())
    if (!parsed) {
      this.hexInput.value = this.hexString()
      return
    }
    this.hsv = rgbToHsv(parsed.r, parsed.g, parsed.b)
    this.alpha = parsed.a
    this.renderAll()
    this.emit()
  }

  private onHintClick(): void {
    const nearest = this.nearest()
    if (!nearest) return
    const parsed = parseColor(nearest.token.value)
    if (parsed) {
      this.hsv = rgbToHsv(parsed.r, parsed.g, parsed.b)
      this.alpha = parsed.a
    }
    this.renderAll()
    this.onPick?.(nearest.token.value, { token: nearest.token.name })
  }

  private nearest(): { token: { name: string; value: string }; distance: number } | null {
    const { r, g, b } = this.currentRgb
    const rgba: RGBA = { r, g, b, a: this.alpha }
    return nearestColorToken(rgba, this.getTokens().colors)
  }

  private hexString(): string {
    const { r, g, b } = this.currentRgb
    const toHex = (n: number) => clampByte(n).toString(16).padStart(2, '0')
    let hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`
    if (this.alpha < 1) hex += toHex(Math.round(this.alpha * 255))
    return hex
  }

  /** Family key for grouping: name minus a trailing `-<digits>` shade suffix (e.g. `red-500` -> `red`). Shadeless names (e.g. `white`, `black`) group under this sentinel into one final row. */
  private static readonly SHADELESS = Symbol('shadeless')

  private familyKey(name: string): string | typeof ColorPicker.SHADELESS {
    const m = /^(.*)-\d+$/.exec(name)
    return m ? m[1] : ColorPicker.SHADELESS
  }

  private renderPalette(): void {
    this.paletteEl.replaceChildren()

    // Group tokens by family, preserving first-seen order — shadeless tokens (no
    // trailing -<digits>) are collected separately and appended as one final row,
    // per the brief ("shadeless like white/black in one final row").
    const families = new Map<string, Array<{ name: string; value: string }>>()
    const shadeless: Array<{ name: string; value: string }> = []
    for (const token of this.getTokens().colors) {
      const key = this.familyKey(token.name)
      if (key === ColorPicker.SHADELESS) {
        shadeless.push(token)
        continue
      }
      let group = families.get(key)
      if (!group) {
        group = []
        families.set(key, group)
      }
      group.push(token)
    }

    const rows = [...families.values()]
    if (shadeless.length > 0) rows.push(shadeless)

    for (const row of rows) {
      const rowEl = document.createElement('div')
      rowEl.className = 'cp-palette-row'
      for (const token of row) {
        const swatch = document.createElement('button')
        swatch.type = 'button'
        swatch.className = 'cp-swatch'
        swatch.title = token.name
        swatch.style.backgroundColor = token.value
        swatch.addEventListener('click', () => {
          const parsed = parseColor(token.value)
          if (parsed) {
            this.hsv = rgbToHsv(parsed.r, parsed.g, parsed.b)
            this.alpha = parsed.a
          }
          this.renderAll()
          this.onPick?.(token.value, { token: token.name })
        })
        rowEl.append(swatch)
      }
      this.paletteEl.append(rowEl)
    }
  }

  private renderAll(): void {
    const { r, g, b } = this.currentRgb

    // Hue slider + SV area background reflect the current hue.
    this.hueInput.value = String(Math.round(this.hsv.h))
    this.svArea.style.setProperty('--cp-hue', `hsl(${this.hsv.h} 100% 50%)`)
    this.svThumb.style.left = `${this.hsv.s * 100}%`
    this.svThumb.style.top = `${(1 - this.hsv.v) * 100}%`

    this.hexInput.value = this.hexString()

    const nearest = this.nearest()
    const exact = nearest !== null && nearest.distance === 0
    this.hintEl.hidden = exact || nearest === null
    if (nearest && !exact) {
      this.hintEl.textContent = `≈ ${nearest.token.name}`
    }

    this.renderContrast(r, g, b)
  }

  private renderContrast(r: number, g: number, b: number): void {
    const bgParsed = this.contrastAgainst ? parseColor(this.contrastAgainst) : null
    if (!bgParsed) {
      this.contrastEl.hidden = true
      return
    }
    const fg: RGBA = { r, g, b, a: this.alpha }
    const ratio = contrastRatio(fg, bgParsed)
    const badge = badgeFor(ratio)
    this.contrastEl.hidden = false
    this.contrastEl.textContent = `${ratio.toFixed(2)} ${badge}`
    this.contrastEl.classList.toggle('cp-fail', badge === 'Fail')
  }
}

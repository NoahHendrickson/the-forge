import { DEFAULT_WIDTH } from './dock'

export const CSS = `
[hidden] { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }
:host { all: initial; }

/*
 * Design tokens (Figma UI3 dark reference) — used literally throughout this file.
 * Panel bg:            #2C2C2C
 * Elevated control bg: rgba(255,255,255,0.06)
 * Control hover:        rgba(255,255,255,0.12)
 * Control active/sel:   rgba(255,255,255,0.16)
 * Panel border:         rgba(255,255,255,0.09)
 * Section separator:    rgba(255,255,255,0.07)
 * Control border hover: rgba(255,255,255,0.12)
 * Text primary:         #F5F5F5
 * Text secondary:       #D4D4D4
 * Text muted:           #9A9A9A
 * Accent:               #0D99FF
 * Ripple outline:       #E2954A (must stay distinct from selection accent)
 * Radius: panel 12px, controls 6px, matrix tile 8px.
 * Type: 11px controls/labels, 10px source path, 12px panel tag.
 */

button {
  font: 500 12px system-ui, sans-serif; border-radius: 999px;
  border: 1px solid #d0d0cb; background: #fff; color: #1a1a18;
  cursor: pointer; padding: 6px 12px;
}
#toggle {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; padding: 8px 14px;
  background: #2C2C2C; color: #F5F5F5; border: 1px solid rgba(255,255,255,0.15);
}
#toggle.active { background: #0D99FF; border-color: transparent; color: #fff; }
#status {
  position: fixed; right: 16px; bottom: 60px; z-index: 2147483647;
  display: flex; gap: 6px; align-items: center;
  font: 400 12px system-ui, sans-serif; color: #D4D4D4;
  background: #2C2C2C; border: 1px solid rgba(255,255,255,0.15); border-radius: 999px; padding: 5px 8px 5px 12px;
}
#status button {
  background: rgba(255,255,255,0.06); color: #D4D4D4; border: none; border-radius: 6px;
  font: 500 11px system-ui, sans-serif; padding: 4px 8px;
}
#status button:hover { background: rgba(255,255,255,0.12); }
#watch { color: #A8A8A8; }
#watch.live { color: #62C073; }
#outline {
  position: fixed; z-index: 2147483645; pointer-events: none;
  border: 1.5px solid rgba(13,153,255,0.75); border-radius: 2px;
}
#select-outline {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 2px solid #0D99FF; border-radius: 2px;
}
.select-outline-multi {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 2px solid #0D99FF; border-radius: 2px;
}
.ripple-outline {
  position: fixed; z-index: 2147483644; pointer-events: none;
  border: 1.5px dashed #e2954a; border-radius: 2px;
  opacity: 1; transition: opacity 0.3s ease-out;
}
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: var(--forge-dock-w, ${DEFAULT_WIDTH}px); max-height: 80vh;
  display: flex; flex-direction: column; overflow: hidden;
  font: 400 12px system-ui, sans-serif; background: #2C2C2C; color: #F5F5F5;
  border: 1px solid rgba(255,255,255,0.09); border-radius: 12px; padding: 0;
  box-shadow: 0 5px 24px rgba(0,0,0,0.35);
  -webkit-font-smoothing: antialiased;
}
/* Docked: full-height right sidebar; page content is pushed left by Dock's html
 * margin-right (the VisBug-style mechanism — see dock.ts). */
#panel.docked {
  top: 0; right: 0; bottom: 0; max-height: none;
  border-radius: 0; border: none; border-left: 1px solid rgba(255,255,255,0.09);
  box-shadow: none;
}
/* The scroll container is the BODY, not the root: the root is a flex column so the
 * footer pins, and popovers live inside the body (position: relative) so they keep
 * tracking their anchor rows when the sections scroll. */
.panel-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; position: relative;
}
#panel .panel-head, #panel .panel-actions { flex: none; }
.panel-empty { padding: 28px 12px; color: #9A9A9A; font: 400 11px system-ui, sans-serif; text-align: center; }
.panel-footer { flex: none; border-top: 1px solid rgba(255,255,255,0.07); padding: 8px 10px; }
.panel-footer:has(> #status[hidden]) { display: none; }
.panel-footer #status { position: static; border-radius: 8px; padding: 5px 8px; flex-wrap: wrap; }
.panel-resize {
  position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
  cursor: col-resize; z-index: 20;
}
.panel-resize:hover, .panel-resize:active { background: rgba(13,153,255,0.4); }
.panel-mode {
  position: absolute; top: 10px; right: 10px;
  width: 22px; height: 20px; padding: 0; line-height: 1;
}
#toggle.dock-open { right: calc(16px + var(--forge-dock-w, ${DEFAULT_WIDTH}px)); }
.panel-body::-webkit-scrollbar { width: 8px; }
.panel-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }

/* Right padding reserves the absolute .panel-mode button's footprint so a long tag
 * (or "No selection") never runs underneath it. */
#panel .panel-head { position: relative; padding: 12px 36px 10px 12px; }
#panel .panel-head-tag { font: 600 12px system-ui, sans-serif; color: #F5F5F5; }
/* Dir + tail spans: the DIRECTORY ellipsizes while the filename:line:col tail keeps
 * flex: none — the useful part of a source path is its end, which plain end-ellipsis
 * used to cut first. (Chosen over a direction:rtl clip trick, which mangles
 * punctuation, and over JS width-measuring truncation, which needs re-running on
 * every resize.) */
#panel .panel-head-src {
  font: 400 10px ui-monospace, monospace; color: #9A9A9A; margin-top: 2px;
  display: flex; min-width: 0;
}
#panel .panel-head-src .src-dir { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; }
#panel .panel-head-src .src-tail { white-space: nowrap; flex: none; }
#panel .panel-actions { display: flex; gap: 6px; padding: 0 12px 10px; }

#panel .panel-section {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 6px; border-top: 1px solid rgba(255,255,255,0.07);
  font: 600 11px system-ui, sans-serif; color: #E8E8E8; text-transform: none;
}
#panel .panel-section [data-expand] { width: 20px; height: 18px; padding: 0; }

#panel .panel-rows { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 10px; align-items: center; }

:where(#panel) button {
  font: 500 11px system-ui, sans-serif; color: #D4D4D4;
  background: rgba(255,255,255,0.06); border: none; border-radius: 6px; padding: 4px 8px;
  cursor: pointer;
}
:where(#panel) button:hover { background: rgba(255,255,255,0.12); }
:where(#panel) button:active { background: rgba(255,255,255,0.16); }

[data-add-layout] {
  width: 100%; text-align: center; padding: 6px 0; background: transparent;
  border: 1px dashed rgba(255,255,255,0.18); color: #B8B8B8;
}
[data-add-layout]:hover { border-style: solid; background: rgba(255,255,255,0.06); }

.nf {
  display: flex; align-items: center; gap: 4px;
  height: 24px; background: rgba(255,255,255,0.06);
  border: 1px solid transparent; border-radius: 6px; padding: 0 6px;
  flex: 1 1 40%;
}
.nf:hover { border-color: rgba(255,255,255,0.12); }
.nf:focus-within { border-color: #0D99FF; }
.nf-label { color: #9A9A9A; font-size: 10px; cursor: ew-resize; user-select: none; min-width: 16px; }
.nf-label:hover { color: #F5F5F5; }
.nf input {
  width: 100%; min-width: 24px; flex: 1;
  border: none; outline: none; font: 400 11px system-ui, sans-serif; color: #F5F5F5; background: transparent;
}
.nf-pill input {
  background: rgba(13,153,255,0.15); color: #7CC4FF; border-radius: 4px;
  padding: 1px 5px; width: auto; flex: 0 1 auto; font-size: 10.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.token-btn {
  display: none; flex: none; width: 16px; height: 16px; padding: 0;
  align-items: center; justify-content: center;
  background: transparent; border: none; color: #9A9A9A; cursor: pointer;
}
.token-btn:hover { color: #F5F5F5; }
.token-btn svg { width: 11px; height: 11px; display: block; }
.nf:hover .token-btn, .nf:focus-within .token-btn, .color-row:hover .token-btn, .color-row:focus-within .token-btn { display: flex; }

.seg-field { display: flex; align-items: center; gap: 4px; }
.seg-field-label { flex: none; width: 40px; color: #9A9A9A; font-size: 11px; }
.seg-track {
  flex: 1; display: flex; gap: 2px; min-width: 0;
  background: rgba(255,255,255,0.06); border-radius: 6px; padding: 2px;
}
/* Align-self has 5 options — stack label above a full-width track so nothing clips. */
[data-align-self] { flex-direction: column; align-items: stretch; gap: 3px; }
[data-align-self] .seg-field-label { width: auto; }
/* Typography's Align row shares its .type-row with the LS number field, leaving too little
 * width for the 3-option segment track — "Center" clips at the 280px panel width. Same fix
 * as [data-align-self] above: stack the label above a full-width track instead of sharing
 * the row's horizontal space with the label. */
[data-text-align] { flex-direction: column; align-items: stretch; gap: 3px; }
[data-text-align] .seg-field-label { width: auto; }
/* Layout's Direction row: "Direction" needs ~48px at 11px, overflowing the fixed 40px
 * label column and painting under the seg track (found by the 280px clipping audit).
 * Same fix as [data-align-self] above: stack the label above a full-width track — which
 * also gives "Row"/"Column" enough room to render without ellipsis at minimum width.
 * flex-basis 100% is load-bearing: inside the wrapping .panel-rows the field would
 * otherwise be content-sized (~64px) and the track would still crush "Column". */
[data-flex-direction] { flex-direction: column; align-items: stretch; gap: 3px; flex: 1 1 100%; }
[data-flex-direction] .seg-field-label { width: auto; }
.seg {
  flex: 1; padding: 3px 0; text-align: center; border-radius: 4px;
  background: transparent; color: #B8B8B8; font-size: 10px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.seg:hover { color: #F5F5F5; }
.seg-active { background: rgba(255,255,255,0.16); color: #fff; }

.layout-grid { display: flex; gap: 8px; width: 100%; }
.layout-side { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.layout-side .nf { flex: 0 0 auto; }

.matrix-tile {
  width: 88px; height: 88px; background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
  display: flex; align-items: center; justify-content: center; flex: none;
}
.align-matrix {
  display: grid; grid-template-columns: repeat(3, 20px); grid-template-rows: repeat(3, 20px); gap: 2px;
}
.align-matrix.am-sb-col { grid-template-columns: 20px; grid-template-rows: repeat(3, 20px); }
.align-matrix.am-sb-row { grid-template-columns: repeat(3, 20px); grid-template-rows: 20px; }
.am-dot {
  width: 20px; height: 20px; border: none; background: transparent; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.am-dot::after {
  content: ''; width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,0.28);
}
.am-dot:hover { background: rgba(255,255,255,0.08); }
.am-dot:hover::after { width: 7px; height: 7px; background: rgba(255,255,255,0.6); }
.am-active::after {
  width: 8px; height: 8px; background: #0D99FF; box-shadow: 0 0 0 2px rgba(13,153,255,0.25);
}

.size-row { display: flex; gap: 4px; flex: 1 1 40%; min-width: 0; }
.size-row .nf { flex: 1; }
.size-mode {
  appearance: none; -webkit-appearance: none;
  background-color: rgba(255,255,255,0.06);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath d='M1 2.5L4 5.5L7 2.5' stroke='%239A9A9A' stroke-width='1' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 5px center;
  color: #D4D4D4; border: 1px solid transparent; border-radius: 6px; height: 24px; padding: 0 18px 0 6px;
  font: 400 10.5px system-ui, sans-serif;
}
.size-mode:hover { border-color: rgba(255,255,255,0.12); }

.layout-section, .flex-child-controls { display: flex; flex-direction: column; gap: 6px; width: 100%; }

.type-family { width: 100%; }
.type-row { display: flex; gap: 4px; width: 100%; }

.color-row { display: flex; align-items: center; gap: 6px; flex: 1 1 100%; }
.swatch {
  width: 16px; height: 16px; border-radius: 4px; padding: 0; flex: none;
  border: 1px solid rgba(255,255,255,0.15); position: relative; overflow: hidden;
  background-image: linear-gradient(45deg, rgba(255,255,255,0.12) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255,255,255,0.12) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.12) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.12) 75%);
  background-size: 8px 8px; background-position: 0 0, 0 4px, 4px -4px, -4px 0;
}
/*
 * The swatch's own background-color (if any) would paint BENEATH the checkerboard
 * background-image layers above, inverting the design intent (checker base should
 * only ever show through actual transparency). So the color lives on a separate
 * CHILD element stacked on top instead — the parent keeps the checkerboard as its
 * only background.
 */
.swatch-color { position: absolute; inset: 0; background-color: currentColor; }
.color-value { color: #9A9A9A; font-size: 10.5px; }
.color-value-pill {
  background: rgba(13,153,255,0.15); color: #7CC4FF;
  border-radius: 4px; padding: 1px 5px;
}
.sc-row { justify-content: space-between; }
.sc-count { color: #9A9A9A; font-size: 10.5px; margin-left: auto; }
.stroke-style { flex: 1 1 40%; }

.color-popover {
  position: absolute; right: 12px; width: 200px; z-index: 10;
  background: #383838; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
  box-shadow: 0 5px 24px rgba(0,0,0,0.4); padding: 10px; display: flex; flex-direction: column; gap: 8px;
}
.cp-sv {
  position: relative; height: 120px; border-radius: 6px; cursor: crosshair;
  background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, var(--cp-hue, red));
}
.cp-sv-thumb {
  position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px;
  border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,0.4); pointer-events: none;
}
.cp-hue {
  width: 100%; height: 10px; appearance: none; -webkit-appearance: none; border-radius: 999px;
  background: linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red);
}
.cp-hue::-webkit-slider-thumb {
  appearance: none; -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
  background: #fff; border: 1px solid rgba(0,0,0,0.3);
}
.cp-hue::-moz-range-thumb {
  width: 12px; height: 12px; border-radius: 50%;
  background: #fff; border: 1px solid rgba(0,0,0,0.3);
}
.cp-hex-row { display: flex; }
.cp-hex {
  width: 100%; height: 24px; background: rgba(255,255,255,0.06); border: 1px solid transparent;
  border-radius: 6px; padding: 0 6px; color: #F5F5F5; font: 400 11px ui-monospace, monospace;
}
.cp-hex:focus { border-color: #0D99FF; outline: none; }
.cp-hint {
  font-size: 10.5px; color: #7CC4FF; cursor: pointer; background: rgba(13,153,255,0.12);
  border-radius: 4px; padding: 3px 6px; width: fit-content;
}
.cp-contrast { font-size: 10.5px; color: #D4D4D4; }
.cp-contrast.cp-fail { color: #F87171; }
.cp-palette {
  display: flex; flex-direction: column; gap: 3px; max-height: 120px; overflow-y: auto;
}
.cp-palette-row { display: flex; gap: 2px; }
.cp-swatch {
  width: 16px; height: 16px; border-radius: 4px; padding: 0; border: 1px solid rgba(255,255,255,0.15);
}

.token-popover {
  position: absolute; right: 12px; width: 180px; z-index: 10;
  background: #383838; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
  box-shadow: 0 5px 24px rgba(0,0,0,0.4); padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
.tp-search {
  height: 24px; width: 100%; background: rgba(255,255,255,0.06);
  border: 1px solid transparent; border-radius: 6px; padding: 0 6px;
  color: #F5F5F5; font: 400 11px system-ui, sans-serif;
}
.tp-search:focus { border-color: #0D99FF; outline: none; }
.tp-list { display: flex; flex-direction: column; max-height: 160px; overflow-y: auto; }
.tp-row {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 4px 8px; border-radius: 4px; cursor: pointer; color: #D4D4D4; font-size: 11px;
}
.tp-row:hover, .tp-row-active { background: rgba(255,255,255,0.08); }
.tp-row-px { color: #9A9A9A; font-size: 10.5px; margin-left: auto; }
.tp-row-swatch {
  width: 12px; height: 12px; border-radius: 3px; flex: none;
  border: 1px solid rgba(255,255,255,0.15);
}
/* .tp-row is flex + justify-content:space-between (label left, px right). A color row has
 * only swatch + label — space-between would fling the label to the right edge, so pull it
 * back left by absorbing the slack. Extend-only: .tp-row's own declarations are untouched. */
.tp-row-swatch + .tp-row-label { margin-right: auto; }
`

export class Overlay {
  host = document.createElement('div')
  toggle = document.createElement('button')
  sendButton = document.createElement('button')
  copyButton = document.createElement('button')
  compareAllButton = document.createElement('button')
  resetAllButton = document.createElement('button')

  private outline = document.createElement('div')
  private selectOutline = document.createElement('div')
  status = document.createElement('div')
  private statusLabel = document.createElement('span')
  private sentLabel = document.createElement('span')
  private watchLabel = document.createElement('span')

  /** Pool of ripple-outline divs, reused across showRipples() calls instead of recreated. */
  private ripplePool: HTMLElement[] = []
  private rippleClearTimer: ReturnType<typeof setTimeout> | null = null

  /** Pool of select-outline-multi divs (B6), reused across showSelectOutlines() calls. */
  private selectOutlinePool: HTMLElement[] = []

  /** Max ripple outlines shown at once — keeps the effect legible when many siblings shift. */
  private static readonly RIPPLE_CAP = 8
  /** Ripples fade and clear this long after the most recent showRipples() call. */
  private static readonly RIPPLE_CLEAR_MS = 1500
  /** Matches the `.ripple-outline` CSS transition duration — time to fully fade before hiding. */
  private static readonly RIPPLE_FADE_MS = 300

  constructor() {
    const root = this.host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    this.toggle.id = 'toggle'
    this.toggle.textContent = 'Design'
    this.outline.id = 'outline'
    this.selectOutline.id = 'select-outline'
    this.status.id = 'status'
    this.sendButton.textContent = 'Send to agent'
    this.copyButton.textContent = 'Copy for agent'
    this.resetAllButton.textContent = 'Reset all'
    this.sentLabel.id = 'sent'
    this.sentLabel.hidden = true
    this.watchLabel.id = 'watch'
    this.watchLabel.hidden = true
    // Watch indicator leads the strip — it's ambient session state ("● Linked…"), read
    // before the per-draft controls and per-send summary.
    this.status.append(this.watchLabel, this.statusLabel, this.sendButton, this.copyButton, this.compareAllButton, this.resetAllButton, this.sentLabel)
    this.outline.hidden = true
    this.selectOutline.hidden = true
    this.status.hidden = true
    root.append(style, this.toggle, this.status, this.outline, this.selectOutline)
  }

  mount(): void {
    document.body.appendChild(this.host)
  }

  attachPanel(panelRoot: HTMLElement): void {
    this.host.shadowRoot!.appendChild(panelRoot)
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.host.contains(target)
  }

  setActive(on: boolean): void {
    this.toggle.classList.toggle('active', on)
    if (!on) {
      this.hideOutline()
      this.hideSelectOutline()
      this.hideSelectOutlines()
      this.status.hidden = true
      this.clearRipples()
    }
  }

  private place(box: HTMLElement, rect: DOMRect): void {
    box.hidden = false
    box.style.left = `${rect.left - 2}px`
    box.style.top = `${rect.top - 2}px`
    box.style.width = `${rect.width + 4}px`
    box.style.height = `${rect.height + 4}px`
  }

  showOutline(rect: DOMRect): void {
    this.place(this.outline, rect)
  }

  hideOutline(): void {
    this.outline.hidden = true
  }

  showSelectOutline(rect: DOMRect): void {
    this.place(this.selectOutline, rect)
  }

  hideSelectOutline(): void {
    this.selectOutline.hidden = true
  }

  /**
   * Draws one pooled `.select-outline-multi` div per rect (VisBug-style multi-select
   * outlines) — pool pattern copied from showRipples: reused across calls, extra slots
   * hidden rather than removed when the selection shrinks.
   */
  showSelectOutlines(rects: DOMRect[]): void {
    while (this.selectOutlinePool.length < rects.length) {
      const div = document.createElement('div')
      div.className = 'select-outline-multi'
      div.style.pointerEvents = 'none'
      div.hidden = true
      this.host.shadowRoot!.appendChild(div)
      this.selectOutlinePool.push(div)
    }
    this.selectOutlinePool.forEach((div, i) => {
      if (i < rects.length) this.place(div, rects[i])
      else div.hidden = true
    })
  }

  hideSelectOutlines(): void {
    for (const div of this.selectOutlinePool) div.hidden = true
  }

  /**
   * Draws up to RIPPLE_CAP dashed outlines at the given rects (siblings that reflowed
   * after an edit). Reuses a pool of divs across calls rather than recreating them.
   * A single shared timer clears all ripples RIPPLE_CLEAR_MS after the most recent call
   * (re-triggering resets the timer, so a fresh edit extends the fade window).
   */
  showRipples(rects: DOMRect[]): void {
    const shown = rects.slice(0, Overlay.RIPPLE_CAP)
    while (this.ripplePool.length < shown.length) {
      const div = document.createElement('div')
      div.className = 'ripple-outline'
      div.style.pointerEvents = 'none'
      div.hidden = true
      this.host.shadowRoot!.appendChild(div)
      this.ripplePool.push(div)
    }
    this.ripplePool.forEach((div, i) => {
      if (i < shown.length) {
        this.place(div, shown[i])
        div.style.opacity = '1' // full opacity again — a reused div may still be mid-fade-out
      } else {
        div.hidden = true
      }
    })
    if (this.rippleClearTimer) clearTimeout(this.rippleClearTimer)
    this.rippleClearTimer = setTimeout(() => {
      this.rippleClearTimer = null
      this.clearRipples()
    }, Overlay.RIPPLE_CLEAR_MS)
  }

  /**
   * Starts the fade-then-hide sequence: dropping opacity to 0 lets the CSS transition
   * on `.ripple-outline` actually animate, instead of the outline vanishing instantly.
   * The divs are hidden RIPPLE_FADE_MS later, once the transition has had time to finish.
   */
  private clearRipples(): void {
    if (this.rippleClearTimer) {
      clearTimeout(this.rippleClearTimer)
      this.rippleClearTimer = null
    }
    for (const div of this.ripplePool) div.style.opacity = '0'
    setTimeout(() => {
      for (const div of this.ripplePool) div.hidden = true
    }, Overlay.RIPPLE_FADE_MS)
  }

  updateStatus(draftCount: number, comparingAll: boolean, sentText?: string, watch?: { text: string; live: boolean }): void {
    // Strip is visible when there are drafts OR a non-empty summary OR a watch indicator
    // (the linked/asleep state is persistent messaging — user-ratified in the watch-mode
    // plan — so it keeps the strip up even with zero drafts). No watcher (`watch`
    // undefined) renders nothing: terminal-only users see the strip behave exactly as
    // before watch mode existed.
    this.status.hidden = draftCount === 0 && !sentText && !watch
    // Draft-count label and controls are hidden when no drafts (they act on drafts)
    this.statusLabel.hidden = draftCount === 0
    this.sendButton.hidden = draftCount === 0
    this.copyButton.hidden = draftCount === 0
    this.compareAllButton.hidden = draftCount === 0
    this.resetAllButton.hidden = draftCount === 0
    // Draft count text (shown only when visible)
    this.statusLabel.textContent = `${draftCount} draft${draftCount === 1 ? '' : 's'}`
    // Compare button label
    this.compareAllButton.textContent = comparingAll ? 'After' : 'Before'
    // Sent summary label
    this.sentLabel.hidden = !sentText
    this.sentLabel.textContent = sentText ?? ''
    // Watch indicator (linked / asleep)
    this.watchLabel.hidden = !watch
    this.watchLabel.textContent = watch?.text ?? ''
    this.watchLabel.classList.toggle('live', watch?.live === true)
  }
}

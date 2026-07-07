import { DEFAULT_WIDTH } from './dock'
import { createButton } from './ui/button'

/**
 * The design-token registry — the single canonical source for the overlay's palette,
 * font stacks, and type scale. The CSS `:host` token block below is GENERATED from this
 * map, and tokens.stories.ts + overlay.test.ts consume this same export, so adding a
 * token is a one-line change here (plus using it).
 */
export const TOKENS = {
  surface: '#2C2C2C',
  'surface-2': '#383838',
  control: 'rgba(255,255,255,0.06)',
  'control-hover': 'rgba(255,255,255,0.12)',
  'control-active': 'rgba(255,255,255,0.16)',
  'border-panel': 'rgba(255,255,255,0.09)',
  'border-strong': 'rgba(255,255,255,0.15)',
  separator: 'rgba(255,255,255,0.07)',
  'text-primary': '#F5F5F5',
  'text-secondary': '#D4D4D4',
  'text-title': '#E8E8E8',
  'text-faint': '#B8B8B8',
  'text-muted': '#9A9A9A',
  accent: '#0D99FF',
  'accent-soft': '#7CC4FF',
  'accent-outline': 'rgba(13,153,255,0.75)',
  positive: '#62C073',
  'watch-idle': '#A8A8A8',
  ripple: '#E2954A',
  'font-ui': 'system-ui, sans-serif',
  'font-mono': 'ui-monospace, monospace',
  'text-xs': '10px',
  'text-sm': '11px',
  'text-md': '12px',
} as const

const tokenBlock = Object.entries(TOKENS)
  .map(([name, value]) => `  --${name}: ${value};`)
  .join('\n')

// Design tokens (Figma UI3 dark reference) — used via var() throughout this file.
// --surface / --surface-2: panel and elevated-popover backgrounds.
// --control / --control-hover / --control-active: elevated control bg and its states.
// --border-panel / --border-strong / --separator: panel border, strong border
//   (toggle/status border, scrollbar thumb), and section-rule border.
// --text-primary / --text-secondary / --text-title / --text-faint / --text-muted:
//   the text-color scale, darkest (primary) to dimmest (muted).
// --accent / --accent-soft / --accent-outline: interactive blue and its tints.
// --positive / --watch-idle: watch indicator's live vs. idle color.
// --ripple: sibling-reflow ripple outline (must stay distinct from selection accent)
// --font-ui / --font-mono: font-family stacks.
// --text-xs / --text-sm / --text-md: the 10/11/12px type scale.
// Radius: panel 12px, controls 6px, matrix tile 8px.
export const CSS = `
[hidden] { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }
:host { all: initial; }
:host {
${tokenBlock}
}


button {
  font: 500 var(--text-md) var(--font-ui); border-radius: 999px;
  border: 1px solid #d0d0cb; background: #fff; color: #1a1a18;
  cursor: pointer; padding: 6px 12px;
}
#toggle {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; padding: 8px 14px;
  background: var(--surface); color: var(--text-primary); border: 1px solid var(--border-strong);
}
#toggle.active { background: var(--accent); border-color: transparent; color: #fff; }
#status {
  position: fixed; right: 16px; bottom: 60px; z-index: 2147483647;
  display: flex; gap: 6px; align-items: center;
  font: 400 var(--text-md) var(--font-ui); color: var(--text-secondary);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 999px; padding: 5px 8px 5px 12px;
}
#status button {
  background: var(--control); color: var(--text-secondary); border: none; border-radius: 6px;
  font: 500 var(--text-sm) var(--font-ui); padding: 4px 8px;
}
#status button:hover { background: var(--control-hover); }
#watch { color: var(--watch-idle); }
#watch.live { color: var(--positive); }
#status button.watch-unlink { background: none; color: var(--watch-idle); padding: 4px 6px; }
#status button.watch-unlink:hover { background: var(--control); color: var(--text-primary); }
#outline {
  position: fixed; z-index: 2147483645; pointer-events: none;
  border: 1.5px solid var(--accent-outline); border-radius: 2px;
}
#select-outline {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 2px solid var(--accent); border-radius: 2px;
}
.select-outline-multi {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 2px solid var(--accent); border-radius: 2px;
}
.ripple-outline {
  position: fixed; z-index: 2147483644; pointer-events: none;
  border: 1.5px dashed var(--ripple); border-radius: 2px;
  opacity: 1; transition: opacity 0.3s ease-out;
}
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: var(--forge-dock-w, ${DEFAULT_WIDTH}px); max-height: 80vh;
  display: flex; flex-direction: column; overflow: hidden;
  font: 400 var(--text-md) var(--font-ui); background: var(--surface); color: var(--text-primary);
  border: 1px solid var(--border-panel); border-radius: 12px; padding: 0;
  box-shadow: 0 5px 24px rgba(0,0,0,0.35);
  -webkit-font-smoothing: antialiased;
}
` +
// Docked: full-height right sidebar; page content is pushed left by Dock's html
// margin-right (the VisBug-style mechanism — see dock.ts).
`#panel.docked {
  top: 0; right: 0; bottom: 0; max-height: none;
  border-radius: 0; border: none; border-left: 1px solid var(--border-panel);
  box-shadow: none;
}
` +
// The scroll container is the BODY, not the root: the root is a flex column so the
// footer pins, and popovers live inside the body (position: relative) so they keep
// tracking their anchor rows when the sections scroll.
`.panel-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; position: relative;
}
#panel .panel-head, #panel .panel-actions { flex: none; }
.panel-empty { padding: 28px 12px; color: var(--text-muted); font: 400 var(--text-sm) var(--font-ui); text-align: center; }
.panel-footer { flex: none; border-top: 1px solid var(--separator); padding: 8px 10px; }
.panel-footer:has(> #status[hidden]) { display: none; }
.panel-footer #status { position: static; border-radius: 8px; padding: 5px 8px; flex-wrap: wrap; }
.panel-resize {
  position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
  cursor: col-resize; z-index: 20;
}
.panel-resize:hover, .panel-resize:active { background: rgba(13,153,255,0.4); }
` +
// .panel-mode's corner anchor moved onto the shared .panel-head-actions wrapper below —
// .panel-prompt (content-sized, unlike .panel-mode's fixed 22px) needs a flex sibling to
// sit beside rather than a guessed fixed right offset.
`.panel-mode {
  width: 22px; height: 20px; padding: 0; line-height: 1;
}
` +
// Header corner action cluster (Prompt + mode toggle) — anchored where .panel-mode used
// to anchor itself; .panel-head's right padding below reserves room for this whole
// cluster, not just the mode button, so a long tag/source line still can't run under it.
`.panel-head-actions {
  position: absolute; top: 10px; right: 10px;
  display: flex; align-items: center; gap: 6px;
}
#toggle.dock-open { right: calc(16px + var(--forge-dock-w, ${DEFAULT_WIDTH}px)); }
.panel-body::-webkit-scrollbar { width: 8px; }
.panel-body::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }

` +
// Right padding reserves the absolute .panel-head-actions cluster's footprint (Prompt +
// mode button, not just the mode button alone) so a long tag (or "No selection") never
// runs underneath it.
`#panel .panel-head { position: relative; padding: 12px 96px 10px 12px; }
#panel .panel-head-tag { font: 600 var(--text-md) var(--font-ui); color: var(--text-primary); }
` +
// Dir + tail spans: the DIRECTORY ellipsizes while the filename:line:col tail keeps
// flex: none — the useful part of a source path is its end, which plain end-ellipsis
// used to cut first. (Chosen over a direction:rtl clip trick, which mangles
// punctuation, and over JS width-measuring truncation, which needs re-running on
// every resize.)
`#panel .panel-head-src {
  font: 400 var(--text-xs) var(--font-mono); color: var(--text-muted); margin-top: 2px;
  display: flex; min-width: 0;
}
#panel .panel-head-src .src-dir { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; }
#panel .panel-head-src .src-tail { white-space: nowrap; flex: none; }
#panel .panel-actions { display: flex; gap: 6px; padding: 0 12px 10px; }

#panel .panel-section {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 6px; border-top: 1px solid var(--separator);
  font: 600 var(--text-sm) var(--font-ui); color: var(--text-title); text-transform: none;
}
#panel .panel-section [data-expand] { width: 20px; height: 18px; padding: 0; }

#panel .panel-rows { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 10px; align-items: center; }

:where(#panel) button {
  font: 500 var(--text-sm) var(--font-ui); color: var(--text-secondary);
  background: var(--control); border: none; border-radius: 6px; padding: 4px 8px;
  cursor: pointer;
}
:where(#panel) button:hover { background: var(--control-hover); }
:where(#panel) button:active { background: var(--control-active); }

[data-add-layout] {
  width: 100%; text-align: center; padding: 6px 0; background: transparent;
  border: 1px dashed rgba(255,255,255,0.18); color: var(--text-faint);
}
[data-add-layout]:hover { border-style: solid; background: var(--control); }

.nf {
  display: flex; align-items: center; gap: 4px;
  height: 24px; background: var(--control);
  border: 1px solid transparent; border-radius: 6px; padding: 0 6px;
  flex: 1 1 40%;
}
.nf:hover { border-color: var(--control-hover); }
.nf:focus-within { border-color: var(--accent); }
.nf-label { color: var(--text-muted); font-size: 10px; cursor: ew-resize; user-select: none; min-width: 16px; }
.nf-label:hover { color: var(--text-primary); }
.nf input {
  width: 100%; min-width: 24px; flex: 1;
  border: none; outline: none; font: 400 var(--text-sm) var(--font-ui); color: var(--text-primary); background: transparent;
}
` +
// The one "this value is a design token" pill treatment — shared by numeric inputs and the
// color rows' value chip (.color-value-pill, toggled by colorDisplay()'s exact-match check)
// so the token look can't drift between field kinds. Input-specific layout stays below.
`.nf-pill input, .color-value-pill {
  background: rgba(13,153,255,0.15); color: var(--accent-soft); border-radius: 4px; padding: 1px 5px;
}
.nf-pill input {
  width: auto; flex: 0 1 auto; font-size: 10.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
` +
// Whisper label for context (e.g. applied Hug/Fill size mode) — dim, right-aligned, non-interactive.
`.nf-whisper { color: var(--text-muted); font-size: 10px; flex: none; padding-right: 4px; pointer-events: none; }
` +
`.token-btn {
  display: none; flex: none; width: 16px; height: 16px; padding: 0;
  align-items: center; justify-content: center;
  background: transparent; border: none; color: var(--text-muted); cursor: pointer;
}
.token-btn:hover { color: var(--text-primary); }
.token-btn svg { width: 11px; height: 11px; display: block; }
.nf:hover .token-btn, .nf:focus-within .token-btn, .color-row:hover .token-btn, .color-row:focus-within .token-btn { display: flex; }

.seg-field { display: flex; align-items: center; gap: 4px; }
.seg-field-label { flex: none; width: 40px; color: var(--text-muted); font-size: 11px; }
.seg-track {
  flex: 1; display: flex; gap: 2px; min-width: 0;
  background: var(--control); border-radius: 6px; padding: 2px;
}
` +
// Align-self has 5 options — stack label above a full-width track so nothing clips.
`[data-align-self] { flex-direction: column; align-items: stretch; gap: 3px; }
[data-align-self] .seg-field-label { width: auto; }
` +
// Typography's Align row shares its .type-row with the LS number field, leaving too little
// width for the 3-option segment track — "Center" clips at the 280px panel width. Same fix
// as [data-align-self] above: stack the label above a full-width track instead of sharing
// the row's horizontal space with the label.
`[data-text-align] { flex-direction: column; align-items: stretch; gap: 3px; }
[data-text-align] .seg-field-label { width: auto; }
` +
// Layout's Direction row: "Direction" needs ~48px at 11px, overflowing the fixed 40px
// label column and painting under the seg track (found by the 280px clipping audit).
// Same fix as [data-align-self] above: stack the label above a full-width track — which
// also gives "Row"/"Column" enough room to render without ellipsis at minimum width.
// flex-basis 100% is load-bearing: inside the wrapping .panel-rows the field would
// otherwise be content-sized (~64px) and the track would still crush "Column".
`[data-flex-direction] { flex-direction: column; align-items: stretch; gap: 3px; flex: 1 1 100%; }
[data-flex-direction] .seg-field-label { width: auto; }
` +
// .seg-cluster holds the track + wrap toggle as a row inside the column-stacked
// [data-flex-direction] field — without it the toggle inherits the field's column
// axis and stacks below the track instead of sitting inline beside it (browser-only
// bug: jsdom can't see flex layout, caught in M-B Task 5's real-browser E2E pass).
`.seg-cluster { display: flex; align-items: center; gap: 4px; }
.seg {
  flex: 1; padding: 3px 0; text-align: center; border-radius: 4px;
  background: transparent; color: var(--text-faint); font-size: 10px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.seg:hover { color: var(--text-primary); }
.seg-active { background: var(--control-active); color: #fff; }
.seg-disabled .seg-track { opacity: 0.5; pointer-events: none; }
` +
// Wrap toggle sits on the Direction row as a sibling of the exclusive track (Task 2) —
// a small left margin reads as attached-but-separate rather than a third track option.
`.wrap-toggle { flex: none; margin-left: 6px; }
` +
// .seg hard-clips overflow by design (title = escape hatch), but Baseline is a word, not a
// glyph — let this one toggle size to its label so it doesn't clip to "Ba…" at the 280px
// panel width (M-B review finding).
`.baseline-toggle { width: auto; flex: none; overflow: visible; padding: 0 8px; }

.layout-grid { display: flex; gap: 8px; width: 100%; }
.layout-side { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.layout-side .nf { flex: 0 0 auto; }
` +
// Column, not row: the tile holds the 64px matrix AND the Baseline toggle. As a centered
// 88px flex ROW the pair overflowed both edges (centered overflow), pushing the matrix's
// left dot column outside the tile — user-reported, browser-verified. Height is content-
// driven (matrix + baseline + gap) with the width still pinned at 88px.
`.matrix-tile {
  width: 88px; background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
  display: flex; flex-direction: column; gap: 4px; padding: 8px 0;
  align-items: center; justify-content: center; flex: none;
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
  width: 8px; height: 8px; background: var(--accent); box-shadow: 0 0 0 2px rgba(13,153,255,0.25);
}

.size-row { display: flex; gap: 4px; flex: 1 1 40%; min-width: 0; }
.size-row .nf { flex: 1; }
.group-label { color: var(--text-muted); font-size: 11px; }
.size-block { display: flex; flex-direction: column; gap: 4px; }
.size-fields { display: flex; gap: 6px; }
.padding-block { display: flex; flex-direction: column; gap: 4px; }
.padding-fields { display: flex; gap: 6px; }
.align-head { display: flex; align-items: center; justify-content: space-between; }
` +
// Align toggle — a small switch (pill + knob); aria-pressed drives the on state.
`.align-toggle {
  width: 26px; height: 14px; border-radius: 999px; background: var(--control);
  position: relative; padding: 0; flex: none;
}
.align-toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px;
  border-radius: 50%; background: var(--text-faint); transition: left 0.12s;
}
.align-toggle[aria-pressed="true"] { background: var(--accent); }
.align-toggle[aria-pressed="true"]::after { left: 14px; background: #fff; }
` +
// The align strip's SegmentField now gets its label from .align-head — collapse the empty span.
`[data-align-self] .seg-field-label:empty { display: none; }
` +
// Data URIs can't reference custom properties, so the chevron's %239A9A9A stroke stays literal.
`.size-mode {
  appearance: none; -webkit-appearance: none;
  background-color: var(--control);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath d='M1 2.5L4 5.5L7 2.5' stroke='%239A9A9A' stroke-width='1' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 5px center;
  color: var(--text-secondary); border: 1px solid transparent; border-radius: 6px; height: 24px; padding: 0 18px 0 6px;
  font: 400 10.5px var(--font-ui);
}
.size-mode:hover { border-color: var(--control-hover); }` +
`.menu-btn {
  width: 16px; align-self: stretch; padding: 0; border: none; background: none; flex: none;
  color: var(--text-muted); font-size: 9px; cursor: pointer; border-radius: 4px;
}
.menu-btn:hover { color: var(--text-primary); background: rgba(255,255,255,0.08); }` +
// The menu popover appends to .panel-body (position: relative) — same host and z plane
// as .token-popover, so it scrolls with the rows and never clips at the panel edge.
// min-width here must match ui/menu.ts's MENU_WIDTH const, used to clamp the popover's
// left offset so it never overhangs the panel body's right edge.
`.menu-popover {
  position: absolute; z-index: 20; min-width: 120px; padding: 4px;
  background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 6px;
  box-shadow: 0 5px 24px rgba(0,0,0,0.4); display: flex; flex-direction: column;
}
.menu-item {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: none;
  background: none; color: var(--text-primary); font-size: 11px; text-align: left;
  cursor: pointer; border-radius: 4px;
}
.menu-item:hover { background: rgba(255,255,255,0.08); }
.menu-check { margin-left: auto; color: var(--accent); }
.menu-sep { height: 1px; background: var(--border-strong); margin: 3px 0; }` +
`
.layout-section, .flex-child-controls { display: flex; flex-direction: column; gap: 6px; width: 100%; align-items: stretch; }
` +
// ^ align-items: stretch overrides .panel-rows's align-items: center, which in THIS column
// context means horizontal centering — every non-full-width child floated toward the middle,
// invisible at the 280px default and a mess at 700px (2026-07-06 layout-polish spec).
// Nested .panel-rows (the min/max disclosure rows) inherit the outer 12px gutter from
// .layout-section's own .panel-rows padding — zero theirs or the rows double-indent. The
// `#panel` prefix exists purely to out-rank `#panel .panel-rows`'s own (1,0,1) specificity —
// without it this (0,2,0) rule lost the cascade and the rows sat ~18.5px too far right (E2E finding).
`#panel .layout-section .panel-rows { padding: 0; }
` +
// The section body is class="panel-rows layout-section", so plain .layout-section (0,1,0)
// loses its stretch to #panel .panel-rows's align-items: center (1,0,1) — this #panel-prefixed
// override (1,2,0) out-ranks it. Same specificity trap as the min/max padding rule above
// (browser-verified E2E finding; jsdom can't see it).
`#panel .layout-section.panel-rows { align-items: stretch; }

.type-family { width: 100%; }
.type-row { display: flex; gap: 4px; width: 100%; }

.color-row { display: flex; align-items: center; gap: 6px; flex: 1 1 100%; }
.swatch {
  width: 16px; height: 16px; border-radius: 4px; padding: 0; flex: none;
  border: 1px solid var(--border-strong); position: relative; overflow: hidden;
  background-image: linear-gradient(45deg, var(--control-hover) 25%, transparent 25%),
    linear-gradient(-45deg, var(--control-hover) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--control-hover) 75%),
    linear-gradient(-45deg, transparent 75%, var(--control-hover) 75%);
  background-size: 8px 8px; background-position: 0 0, 0 4px, 4px -4px, -4px 0;
}
` +
// The swatch's own background-color (if any) would paint BENEATH the checkerboard
// background-image layers above, inverting the design intent (checker base should
// only ever show through actual transparency). So the color lives on a separate
// CHILD element stacked on top instead — the parent keeps the checkerboard as its
// only background.
`.swatch-color { position: absolute; inset: 0; background-color: currentColor; }
.color-value { color: var(--text-muted); font-size: 10.5px; }
` +
// .color-value-pill shares the .nf-pill input token-pill declaration block above.
`.sc-row { justify-content: space-between; }
.sc-count { color: var(--text-muted); font-size: 10.5px; margin-left: auto; }
.stroke-style { flex: 1 1 40%; }

.color-popover {
  position: absolute; right: 12px; width: 200px; z-index: 10;
  background: var(--surface-2); border: 1px solid var(--control-hover); border-radius: 8px;
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
  width: 100%; height: 24px; background: var(--control); border: 1px solid transparent;
  border-radius: 6px; padding: 0 6px; color: var(--text-primary); font: 400 var(--text-sm) var(--font-mono);
}
.cp-hex:focus { border-color: var(--accent); outline: none; }
.cp-hint {
  font-size: 10.5px; color: var(--accent-soft); cursor: pointer; background: rgba(13,153,255,0.12);
  border-radius: 4px; padding: 3px 6px; width: fit-content;
}
.cp-contrast { font-size: 10.5px; color: var(--text-secondary); }
.cp-contrast.cp-fail { color: #F87171; }
.cp-palette {
  display: flex; flex-direction: column; gap: 3px; max-height: 120px; overflow-y: auto;
}
.cp-palette-row { display: flex; gap: 2px; }
.cp-swatch {
  width: 16px; height: 16px; border-radius: 4px; padding: 0; border: 1px solid var(--border-strong);
}

.token-popover {
  position: absolute; right: 12px; width: 180px; z-index: 10;
  background: var(--surface-2); border: 1px solid var(--control-hover); border-radius: 8px;
  box-shadow: 0 5px 24px rgba(0,0,0,0.4); padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
.tp-search {
  height: 24px; width: 100%; background: var(--control);
  border: 1px solid transparent; border-radius: 6px; padding: 0 6px;
  color: var(--text-primary); font: 400 var(--text-sm) var(--font-ui);
}
.tp-search:focus { border-color: var(--accent); outline: none; }
.tp-list { display: flex; flex-direction: column; max-height: 160px; overflow-y: auto; }
.tp-row {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--text-secondary); font-size: 11px;
}
.tp-row:hover, .tp-row-active { background: rgba(255,255,255,0.08); }
.tp-row-px { color: var(--text-muted); font-size: 10.5px; margin-left: auto; }
.tp-row-swatch {
  width: 12px; height: 12px; border-radius: 3px; flex: none;
  border: 1px solid var(--border-strong);
}
` +
// .tp-row is flex + justify-content:space-between (label left, px right). A color row has
// only swatch + label — space-between would fling the label to the right edge, so pull it
// back left by absorbing the slack. Extend-only: .tp-row's own declarations are untouched.
`.tp-row-swatch + .tp-row-label { margin-right: auto; }

` +
// Changes lifecycle list (send-lifecycle spec) — chips reuse the design tokens above:
// applying/mismatch share the ripple amber, done the watch-live green.
`.changes-section {
  flex: none; display: flex; flex-direction: column; max-height: 180px;
  border-top: 1px solid var(--separator);
}
.changes-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px 4px; font: 600 var(--text-sm) var(--font-ui); color: var(--text-title);
}
.changes-list { overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 2px; }
.changes-list::-webkit-scrollbar { width: 8px; }
.changes-list::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
.change-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 6px; font: 400 var(--text-sm) var(--font-ui); color: var(--text-secondary);
  cursor: default;
}
.change-row:hover { background: var(--control); }
.change-row.row-gone { opacity: 0.5; }
.chip {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  font: 500 var(--text-xs) var(--font-ui); border-radius: 999px; padding: 1px 7px;
}
.chip::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.chip-draft { color: var(--text-faint); border: 1px dashed rgba(255,255,255,0.25); }
.chip-sent { color: var(--text-faint); background: rgba(255,255,255,0.08); }
.chip-applying { color: var(--ripple); background: rgba(226,149,74,0.12); }
@keyframes forge-chip-pulse { 50% { opacity: 0.4; } }
.chip-applying::before { animation: forge-chip-pulse 1.2s ease-in-out infinite; }
.chip-done { color: var(--positive); background: rgba(98,192,115,0.12); }
.chip-mismatch { color: var(--ripple); background: rgba(226,149,74,0.12); }
.chip-unverified { color: var(--text-faint); background: rgba(255,255,255,0.08); }
.chip-failed { color: #F87171; background: rgba(248,113,113,0.12); }
.change-el { flex: none; color: var(--text-primary); }
.change-summary {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-muted);
}
.change-note { flex-basis: 100%; color: #F87171; font-size: 10.5px; padding: 0 6px 2px 22px; white-space: normal; }
.change-note-mismatch { color: var(--ripple); }
.change-actions { display: flex; gap: 4px; flex-basis: 100%; padding: 0 6px 2px 22px; }

` +
// Free-form prompt box (prompt-mode spec) — floats anchored to the selected element, a
// sibling of the outlines in the shadow root (see mountPromptBox below).
`.prompt-box {
  position: fixed; z-index: 2147483646; width: 280px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.prompt-textarea {
  box-sizing: border-box; width: 100%; resize: vertical; min-height: 56px;
  background: var(--control); color: var(--text-primary); border: 1px solid var(--border-panel);
  border-radius: 4px; padding: 6px; font: 400 var(--text-sm)/1.4 var(--font-ui); outline: none;
}
.prompt-textarea:focus { border-color: var(--accent); }
.prompt-box .prompt-send { align-self: flex-end; }
` +
// PromptBox mounts as a shadow-root sibling of #panel/#status (see mountPromptBox above),
// so .prompt-send falls outside both of those scoped button rules and would otherwise
// fall back to the plain base button rule (light pill) — mirror the dark #panel/#status
// control idiom explicitly here instead.
`.prompt-box .prompt-send {
  background: var(--control); color: var(--text-primary); border: none; border-radius: 6px;
}
.prompt-box .prompt-send:hover { background: var(--control-hover); }
` +
// .panel-prompt is a layout-only class hook now — position/size comes from the
// .panel-head-actions flex wrapper it's placed in (panel.ts); no rule needed here, but the
// selector name stays a stable test contract (see panel.test.ts / overlay.test.ts).
`
`

export class Overlay {
  host = document.createElement('div')
  toggle = createButton({ label: 'Design' })
  sendButton = createButton({ label: 'Send to agent' })
  copyButton = createButton({ label: 'Copy for agent' })
  // compareAllButton's label is state-dependent ('Before'/'After') — set in updateStatus().
  compareAllButton = createButton()
  resetAllButton = createButton({ label: 'Reset all' })
  unlinkButton = createButton({ label: '✕', title: 'Unlink watcher session', className: 'watch-unlink' })

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
    this.outline.id = 'outline'
    this.selectOutline.id = 'select-outline'
    this.status.id = 'status'
    this.sentLabel.id = 'sent'
    this.sentLabel.hidden = true
    this.watchLabel.id = 'watch'
    this.watchLabel.hidden = true
    // Watch indicator leads the strip — it's ambient session state ("● Linked…"), read
    // before the per-draft controls and per-send summary.
    this.unlinkButton.hidden = true
    this.status.append(this.watchLabel, this.unlinkButton, this.statusLabel, this.sendButton, this.copyButton, this.compareAllButton, this.resetAllButton, this.sentLabel)
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

  /** Prompt box mounts in the shadow root like the panel — fixed-position sibling of the
   * outlines, so its coordinates share the overlay's viewport space. */
  mountPromptBox(el: HTMLElement): void {
    this.host.shadowRoot!.appendChild(el)
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

  updateStatus(draftCount: number, comparingAll: boolean, sentText?: string, watch?: { text: string; live: boolean; unlinkable?: boolean }): void {
    // Strip is visible when there are drafts OR a non-empty summary OR a watch indicator.
    // Since the 2026-07-05 watcher-unlink spec, watchIndicatorFor always returns an
    // indicator (the 'none' state renders the upfront "not linked" hint — a deliberate
    // reversal of the original zero-UI-change rule), so in practice the strip is visible
    // whenever design mode is on. `watch` stays optional so callers without watch state
    // (tests, panel-only flows) keep today's hide-when-empty behavior.
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
    // Unlink ✕: only when the indicator says there is a watcher to unlink/dismiss.
    this.unlinkButton.hidden = watch?.unlinkable !== true
  }
}

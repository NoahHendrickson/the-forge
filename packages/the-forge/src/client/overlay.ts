import { DEFAULT_WIDTH } from './dock'
import { createButton } from './ui/button'
import { DUR_FAST_MS, DUR_POP_MS, DUR_PANEL_MS, EASE_SPRING, EASE_OUT, prefersReducedMotion } from './motion'

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
  'dur-fast': `${DUR_FAST_MS}ms`,
  'dur-pop': `${DUR_POP_MS}ms`,
  'dur-panel': `${DUR_PANEL_MS}ms`,
  'ease-spring': EASE_SPRING,
  'ease-out': EASE_OUT,
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
// --dur-fast/--dur-pop/--dur-panel + --ease-spring/--ease-out: the motion system
//   (motion.ts is the source; see the 2026-07-12 overlay-motion spec).
// Radius: panel 12px, controls 6px, matrix tile 8px.
export const CSS = `
[hidden]:not(.forge-anim) { display: none !important; }
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
` +
// left/top/width/height on ONE fixed-position element is cheap paint, no layout cascade —
// safe to tween directly. #select-outline is deliberately NOT .forge-anim: entry is a
// fade-in via this @starting-style block (separate from Task 2's forge-anim one), exit is
// an instant [hidden] snap, never a fade-out.
`#select-outline { transition: opacity 80ms var(--ease-out); }
#select-outline.tween { transition: left var(--dur-fast) var(--ease-out), top var(--dur-fast) var(--ease-out), width var(--dur-fast) var(--ease-out), height var(--dur-fast) var(--ease-out); }
@starting-style { #select-outline { opacity: 0; } }
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
// Entry-only: #panel deliberately NOT .forge-anim — dock↔float toggles must not fade
// the panel, only a genuine hidden→shown fires @starting-style; panel.hide() stays a snap.
`#panel { transition: opacity var(--dur-panel) var(--ease-out), transform var(--dur-panel) var(--ease-out); }
@starting-style { #panel { opacity: 0; transform: translateY(6px); } }
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
// feedSlot (composer-consolidation Task 4): 45% flex-basis is the CSS default, live only
// until a drag or a restored persisted split sets an inline px flex-basis (Panel.feedSplit()
// returns -1 while this default is in effect). display: flex here is what makes
// .session-feed's own `flex: 1 1 auto` (overlay.ts's .session-feed rule, further below)
// actually fill the slot instead of sizing to content.
`.panel-feed-slot {
  flex: 0 1 45%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
}
.feed-divider {
  flex: none; height: 5px; cursor: row-resize; position: relative; z-index: 5;
}
.feed-divider:hover, .feed-divider:active { background: rgba(13,153,255,0.4); }
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

.layout-grid { display: flex; gap: 8px; width: 100%; }
.layout-side { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.layout-side .nf { flex: 0 0 auto; }
` +
// The tile is a centered column card around the 64px matrix (width pinned at 88px,
// height content-driven). Column layout predates the Baseline toggle's 2026-07-07
// removal and stays — a centered 88px flex ROW overflowed both edges (centered
// overflow), pushing the matrix's left dot column outside the tile (user-reported).
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
.menu-btn:hover { color: var(--text-primary); background: rgba(255,255,255,0.08); }
.nf-has-menu { padding-right: 2px; }
.nf-has-menu .menu-btn { height: 18px; align-self: center; }` +
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
` +
// The pop marks arrival at done — a small springy dot scale-in; the shake is the ONE
// stronger gesture in the system, semantically earned by failure; both keyed to
// .stage-flip so they play once per real transition, see changelist.ts lastStages.
`
.stage-flip .chip-done::before { animation: forge-pop var(--dur-pop) var(--ease-spring); }
.stage-flip .chip-failed { animation: forge-shake 250ms var(--ease-out); }
.change-el { flex: none; color: var(--text-primary); }
.change-summary {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-muted);
}
` +
// .change-detail: one line per drafted property (2026-07-11 draft-badge spec — replaces the
// "+N more"/title collapse on draft rows). flex-basis: 100% wraps each line full-width inside
// the flex row, same trick .change-note uses; the 22px left pad aligns under .change-el past
// the chip.
`
.change-detail {
  flex-basis: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-muted); font: 400 var(--text-xs) var(--font-ui); padding: 0 6px 0 22px;
}
.change-note { flex-basis: 100%; color: #F87171; font-size: 10.5px; padding: 0 6px 2px 22px; white-space: normal; }
.change-note-mismatch { color: var(--ripple); }
.change-actions { display: flex; gap: 4px; flex-basis: 100%; padding: 0 6px 2px 22px; }

` +
// .panel-prompt is a layout-only class hook now — position/size comes from the
// .panel-head-actions flex wrapper it's placed in (panel.ts); no rule needed here, but the
// selector name stays a stable test contract (see panel.test.ts / overlay.test.ts). The
// floating prompt popup itself was retired in Task 6 — its anchored popup is replaced by the
// feed's own persistent element chip + chat input (below), so there is no more shadow-root
// sibling popup to style here.
`
` +
// Session feed — live activity stream from the embedded session (Task 7).
// .session-feed: the section container, mirrors .changes-section structure; flex-grows to
// fill the space freed by the retired status row/config bar (composer consolidation Task 1 —
// the draggable divider that further redistributes this height is Task 4).
// .session-row: individual event rows (text snippets, tool rows, error rows, approvals).
// .session-approval: a pending tool-approval row — has Allow/Deny buttons.
// CSS class names here are test hooks — extend, don't rename.
`.session-feed {
  flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0;
  border-top: 1px solid var(--separator);
}
.session-list { flex: 1 1 auto; overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 2px; }
` +
// anchor-at-top spacer — see feed-anchor.ts (FeedAnchor)
`.feed-tail-spacer { flex: none; }
.session-list::-webkit-scrollbar { width: 8px; }
.session-list::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
.session-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding: 3px 6px; border-radius: 6px; font: 400 var(--text-sm) var(--font-ui);
  color: var(--text-secondary); word-break: break-word;
}
` +
// Error rows read as cards (chat-ux polish): red-tinted surface + ⚠ glyph, the same
// tint idiom as .chip-failed. The glyph is a ::before, NOT a DOM span — nine host-side
// tests pin the row's exact textContent, and a purely presentational icon has no business
// in the text contract. .error-text keeps min-width:0 so long CLI error strings wrap
// inside the card instead of blowing the row wide.
`.session-error-row {
  color: #F87171; background: rgba(248,113,113,0.08);
  border: 1px solid rgba(248,113,113,0.18); padding: 6px 8px;
  flex-wrap: nowrap; align-items: flex-start;
}
.session-error-row::before { content: '⚠'; flex: none; }
.session-error-row .error-text { flex: 1 1 auto; min-width: 0; }
` +
// Tool rows as steps (chat-ux polish): [category icon] [name] [detail·mono·ellipsis]
// [spinner→✓ at the right edge]. The spinner spins via forge-spin while the tool runs;
// tool-finished adds .done (spin stops, check settles green) + .tool-done on the row.
// nowrap + min-width:0 on .tool-detail is what makes one-line ellipsis work inside the
// flex row; the diff disclosure still wraps below via its own flex-basis: 100%.
`.session-tool-row { color: var(--text-muted); padding: 2px 6px; }
.tool-icon { flex: none; width: 12px; height: 12px; color: var(--text-faint); }
.tool-icon svg { width: 12px; height: 12px; display: block; }
.tool-name { flex: none; font-weight: 500; color: var(--text-secondary); }
.tool-detail {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 400 var(--text-xs) var(--font-mono); color: var(--text-muted);
}
.session-spinner {
  flex: none; margin-left: auto; color: var(--accent-soft); font-size: 10px;
  animation: forge-spin 0.9s linear infinite;
}
.session-spinner.done { animation: none; color: var(--positive); }
.tool-done .tool-icon { color: var(--text-muted); }
` +
// Approval card (chat-ux polish): the one row that ASKS something gets the accent
// treatment — tinted card, tool name emphasized, detail in mono, Allow as the primary
// action. Resolution still collapses to the bare Allowed/Denied line (pinned contract).
`.session-approval {
  border: 1px solid rgba(13,153,255,0.35); background: rgba(13,153,255,0.07);
  padding: 6px 8px; border-radius: 8px;
}
.approval-body { flex: 1 1 100%; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.approval-tool { font-weight: 600; color: var(--text-primary); }
.approval-detail {
  font: 400 var(--text-xs) var(--font-mono); color: var(--text-secondary);
  word-break: break-word;
}
.approval-actions { display: flex; gap: 6px; }
.session-approval .session-approval-allow { background: var(--accent); color: #fff; }
.session-approval .session-approval-allow:hover { background: var(--accent); opacity: 0.85; }
.session-approval-resolved { color: var(--text-muted); font-style: italic; border: none; background: none; }
` +
// Turn-completion marker (chat-ux polish): the "this exchange is finished" signal —
// muted, small, with the check in the positive green and the per-turn cost when known.
`.turn-done { color: var(--text-muted); font: 400 var(--text-xs) var(--font-ui); gap: 4px; }
.turn-done-check { color: var(--positive); }
.turn-done-cost { color: var(--text-faint); }
` +
// "Thinking" placeholder (chat-ux polish): fills the dead air between a sent message and
// the first token/tool — three staggered pulsing dots, the ChatGPT/Claude shimmer idiom.
`.chat-working { color: var(--text-muted); }
.chat-working-dots { display: inline-flex; gap: 3px; align-items: center; }
.chat-working-dot {
  width: 4px; height: 4px; border-radius: 50%; background: currentColor;
  animation: forge-dot-pulse 1.2s ease-in-out infinite;
}
.chat-working-dot:nth-child(2) { animation-delay: 0.2s; }
.chat-working-dot:nth-child(3) { animation-delay: 0.4s; }
` +
// Chat-entrance motion: content enters as fade+rise, deliberately NOT springy — the research
// line is "springs for interactive elements, plain rise for content"; the approval card is the
// exception because it's requesting a decision. Animation-on-insertion means streaming delta
// mutations on an existing bubble never re-trigger, and a reconnect replay burst animates once
// in unison — acceptable.
// The :not(.session-approval-resolved) gate is load-bearing: resolving an approval adds that
// class to the SAME element (session-feed.ts), and without the :not() the animation-rules
// change would restart the rise on resolve; with it, the element falls back to the .session-row
// rule whose animation-name is identical, so nothing restarts.
`.session-row { animation: forge-rise-in var(--dur-pop) var(--ease-out); }
.session-approval:not(.session-approval-resolved) { animation: forge-rise-in var(--dur-panel) var(--ease-spring); }
` +
// Chat rendering (Task 5 + Task 3 restyle) — bubbles, delta streaming, diff disclosures, config rows.
// .chat-msg: bubble base (extends .session-row); .chat-user / .chat-assistant: sender variant.
// Task 3 (2026-07-12): user bubbles full-width with background, assistant plain text no background,
// streaming caret replaces the dashed border — .chat-streaming::after with a blinking caret.
// .chat-msg-ref: element chip echo line.
// .session-diff / .diff-before / .diff-after: collapsed <details> tool-edit disclosure.
// .session-config: the config-changed summary line.
// CSS class names here are test hooks — extend, don't rename.
`.chat-msg { flex-direction: column; align-items: flex-start; gap: 2px; white-space: pre-wrap; }
` +
// User bubbles right-aligned at capped width with an asymmetric radius (chat-ux polish —
// the ChatGPT/claude.ai sender convention: your words hug the right, the reply owns the
// left), assistant text stays plain and full-width.
`.chat-user {
  background: var(--control-hover); border-radius: 12px 12px 4px 12px; padding: 7px 10px;
  align-self: flex-end; max-width: 85%; align-items: flex-end;
}
.chat-assistant { background: none; padding: 3px 0; }
.chat-streaming::after {
  content: '▍'; margin-left: 2px; color: var(--text-faint);
  animation: forge-blink 1s steps(1, end) infinite;
}
` +
// The attached-element reference renders as a chip (chat-ux polish) — echoing the
// composer pill it came from, the way ChatGPT shows attachments as cards on the message.
`.chat-msg-ref {
  color: var(--text-faint); font: 400 var(--text-xs) var(--font-mono);
  border: 1px solid var(--border-strong); border-radius: 999px; padding: 1px 8px;
  background: var(--control); max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}
` +
// Assistant markdown (chat-markdown.ts): tight block rhythm tuned for an 11px chat column.
// Blocks keep margin 0 and space out via the bubble's own flex gap; code blocks stretch
// full-width and scroll horizontally rather than wrapping mid-token.
`.chat-assistant { gap: 6px; }
.chat-assistant .md-p { margin: 0; }
.md-h { font-weight: 600; color: var(--text-title); }
.md-h1 { font-size: 13px; }
.md-h2 { font-size: 12px; }
.md-code {
  align-self: stretch; margin: 0; padding: 6px 8px; border-radius: 6px;
  background: rgba(0,0,0,0.25); border: 1px solid var(--separator);
  font: 400 var(--text-xs) var(--font-mono); white-space: pre; overflow-x: auto; max-width: 100%;
}
.md-code-inline {
  background: var(--control-hover); border-radius: 4px; padding: 0 4px;
  font: 400 var(--text-xs) var(--font-mono);
}
.md-list { margin: 0; padding-left: 18px; }
.md-list li { margin: 2px 0; }
.md-quote {
  margin: 0; padding-left: 8px; border-left: 2px solid var(--border-strong);
  color: var(--text-faint);
}
.md-link { color: var(--accent-soft); text-decoration: underline; }
` +
// Diff disclosure: the summary now carries basename + green/red line-delta chips
// (chat-rows.ts diffStats — Cursor's +N −M edit-card shape); pre blocks cap at 140px and
// scroll so a large edit can't swallow the feed.
`.session-diff { flex-basis: 100%; margin-top: 2px; font: 400 var(--text-xs) var(--font-mono); }
.session-diff summary { cursor: pointer; color: var(--text-muted); }
.session-diff summary:hover { color: var(--text-secondary); }
.session-diff .diff-file { color: inherit; }
.diff-stat-add { color: var(--positive); margin-left: 6px; }
.diff-stat-del { color: #F87171; margin-left: 4px; }
.diff-before, .diff-after {
  white-space: pre-wrap; word-break: break-word; margin: 2px 0; padding: 4px 6px; border-radius: 4px;
  max-height: 140px; overflow-y: auto;
}
.diff-before { background: rgba(248,113,113,0.08); }
.diff-after { background: rgba(74,222,128,0.08); }
.session-config { color: var(--text-faint); font-size: var(--text-xs); }
` +
// Chat composer (composer consolidation Task 1) — replaces the retired status row, standalone
// Stop button, and .session-config-bar. .chat-composer: the single bordered card holding the
// chip row, textarea, and controls row. .composer-chips: the chip row (+ Task 2's drafts
// pill). .composer-controls: model/effort/permission pickers + spacer + composer-send, one
// row. .session-model only caps the width, since full model ids are much longer than the
// fixed effort/permission vocabularies. The three selects carry min-width: 0 so they can
// shrink below their intrinsic content width — without it a flex item's default
// min-width: auto pins them at content size, and once the model select fills its 100px cap the
// row overflows a narrow (320px default) panel and shoves the flex: none composer-send clean
// off the right edge (real-browser regression; jsdom can't see flex, so no unit test guards it).
// Clipping (ellipsis/nowrap) keeps a shrunk select legible via its native chevron.
// .chat-chip retired → .composer-chip (unified chip, 2026-07-12 chat-composer-chip spec) — the
// chip row now sits INSIDE .chat-input, above the textarea, instead of as a sibling row.
// .chat-input: the bordered input box — chip row + textarea (+ disabled-reason) — Send moved
// out into .composer-controls, one row below, alongside the pickers. .chat-disabled-reason:
// shown when setAvailability(false, reason) disables the input.
// CSS class names here are test hooks — extend, don't rename.
`.chat-composer {
  display: flex; flex-direction: column; gap: 6px; margin: 8px; padding: 8px;
  border: 1px solid var(--border-panel); border-radius: 10px; background: var(--surface);
}
.composer-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.composer-controls { display: flex; align-items: center; gap: 6px; }
.composer-spacer { flex: 1 1 auto; }
.composer-controls .size-mode { font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-model { max-width: 100px; overflow: hidden; text-overflow: ellipsis; }
.composer-chip {
  display: inline-flex; align-items: center;
  border-radius: 6px; background: var(--surface);
}
.composer-chip .draft-pill { background: none; }
.composer-chip .draft-pill:hover { background: var(--control-hover); }
.draft-pill-el { font: 400 var(--text-xs) var(--font-mono); color: var(--text-secondary); }
.draft-pill-clear {
  background: none; border: none; color: var(--text-faint); padding: 0 6px 0 2px;
  font: 500 var(--text-sm) var(--font-ui); border-radius: 4px;
}
.draft-pill-clear:hover { color: var(--text-primary); }
` +
// Drafts pill + disclosure (composer consolidation Task 2) — .draft-pill is the unified chip,
// wrapped in .composer-chip inside .composer-chips; clicking it toggles .draft-disclosure open
// (a details-free div toggle, not a <details> element — see session-feed.ts). .draft-disclosure
// itself sits ABOVE .chat-input in .chat-composer so opening it (it hosts the unmodified
// ChangeList, whose own .changes-section rules cap it at max-height 180px) never pushes the
// textarea/controls rows around — it grows upward into free panel space instead.
// 2026-07-11 draft-badge spec: the pill's .open class is mirrored alongside the disclosure's
// (session-feed.ts's setDisclosureOpen) purely so .draft-pill-chevron has a same-element CSS
// hook to rotate on — the disclosure itself is a sibling, not an ancestor, of the pill.
// 2026-07-12 motion pass (Task 3, reworked per PR #34 review): the disclosure springs open via
// grid-template-rows 0fr⇄1fr — the only pure-CSS way to transition an auto-height reveal;
// .draft-slot (the single child) needs min-height:0 + overflow:hidden for the fr interpolation
// to clip. The closed state is display:none, NOT a rendered 0-height item: .chat-composer is
// flex with gap:6px, and a rendered zero-height first child still earns that gap — a dead 6px
// band above the chips row. display:none opts out of gap layout entirely (the pre-motion
// geometry — this replaced a margin-bottom:-6px compensation that had to stay synced to the
// parent gap); the same @starting-style + `display allow-discrete` mechanics as the .forge-anim
// popovers make it animatable anyway — @starting-style supplies the 0fr entry frame on the
// none→grid flip, allow-discrete holds display:grid through the 1fr→0fr collapse on exit.
// display:none also keeps collapsed ChangeList buttons untabbable for free (the former
// visibility juggling is gone). Browsers without these features snap open/closed (pre-motion
// behavior). The ~2% spring overshoot past 1fr is layout-safe slack. Class names are test hooks.
`.draft-pill {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: 6px; border: none;
  font: 500 var(--text-xs) var(--font-ui); color: var(--text-secondary);
}
.draft-pill:hover { background: var(--control-hover); }
.draft-pill-chevron { transition: transform 120ms ease; }
.draft-pill.open .draft-pill-chevron { transform: rotate(180deg); }
.draft-disclosure { display: none; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-pop) var(--ease-spring), display var(--dur-pop) allow-discrete; }
.draft-disclosure > .draft-slot { min-height: 0; overflow: hidden; }
.draft-disclosure.open { display: grid; grid-template-rows: 1fr; }
@starting-style { .draft-disclosure.open { grid-template-rows: 0fr; } }
` +
// The input box is now the bordered surface — chip row + textarea inside (chat-composer-chip
// spec, Task 2) — so focus moved from .chat-textarea to the wrapper via :focus-within.
// .has-items is the primed glow when a chip is showing: the rgba is --accent (#0D99FF) at 15%,
// same hardcoded-tint idiom as .tp-pill.
`.chat-input {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--border-panel); border-radius: 8px; background: var(--control);
  padding: 6px; transition: border-color 120ms, box-shadow 120ms;
}
.chat-input:focus-within { border-color: var(--accent); }
.chat-input.has-items { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(13,153,255,0.15); }
.chat-textarea {
  box-sizing: border-box; width: 100%; resize: none; min-height: 40px; max-height: 140px;
  overflow-y: auto; background: none; color: var(--text-primary); border: none;
  padding: 0; font: 400 var(--text-sm)/1.4 var(--font-ui); outline: none;
}
.chat-textarea:disabled { opacity: 0.5; }
` +
// SessionFeed mounts inside #panel (panel.feedSlot), but there is no generic `#panel button`
// dark-token rule (each panel button opts in individually — see .session-approval-allow) — pin
// the dark control styling explicitly, same idiom, for .composer-send: it now carries what
// used to be .session-stop's job too (the send↔stop morph), so it earns the circular treatment.
`.composer-send {
  flex: none; width: 26px; height: 26px; border-radius: 50%; padding: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--control); color: var(--text-primary); border: none;
  font: 500 13px var(--font-ui);
}
.composer-send:hover { background: var(--control-hover); }
.composer-send:disabled { opacity: 0.5; cursor: default; }
` +
// Press-down + spring return is the highest-touch button's micro-feedback; .pop is popOnce's
// re-triggerable one-shot for the glyph morph (see session-feed.ts updateSendMorph — fires
// only on genuine ↑/■ flips, never per keystroke).
`.composer-send { transition: transform var(--dur-fast) var(--ease-spring), background 120ms; }
.composer-send:active { transform: scale(0.92); }
.composer-send.pop { animation: forge-pop var(--dur-fast) var(--ease-spring); }
.chat-disabled-reason { color: var(--text-faint); font: 400 var(--text-xs) var(--font-ui); padding: 0 2px; }
` +
// Canvas-mode chrome (design-canvas-mode spec): the header toggle just tints '.panel-mode'
// like every other header button; the zoom pill is its own fixed-position affordance,
// bottom-left (the panel/toggle/status cluster owns bottom-right). Colors/font copied
// from #toggle/#status rather than invented.
`.canvas-toggle.on { color: var(--accent); }
.zoom-pill-wrap { position: fixed; left: 16px; bottom: 16px; z-index: 2147483647; }
.zoom-pill-wrap .menu-btn { min-width: 52px; padding: 6px 10px; border-radius: 8px; }
.zoom-pill {
  background: var(--surface); color: var(--text-primary); border: 1px solid var(--border-strong);
  font: 500 var(--text-md) var(--font-ui);
}
.zoom-pill:hover { background: var(--control-hover); }
` +
// Motion primitives (2026-07-12 overlay-motion spec). forge-pop/rise-in are from-only —
// the destination is the element's natural state, so one keyframe serves every use site.
// The reduced-motion block is a blanket: 1ms (never 0s — transitionend must still fire
// for JS that waits on it) across every shadow-DOM transition/animation, including the
// pre-existing ripple fade and chip pulse. Page-context motion (dock margin, canvas
// transform) is guarded separately via prefersReducedMotion() in motion.ts.
// Streaming caret blink — steps(1, end) = hard on/off, no fade.
`@keyframes forge-pop { from { transform: scale(0.8); } }
@keyframes forge-rise-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes forge-shake { 25% { transform: translateX(-2px); } 50% { transform: translateX(2px); } 75% { transform: translateX(-1px); } }
@keyframes forge-blink { 50% { opacity: 0; } }
` +
// Chat-ux polish additions: forge-spin drives the tool spinner while a tool runs (linear —
// a spring on a continuous rotation reads as stutter); forge-dot-pulse is the staggered
// thinking-dots pulse. Both stop under the reduced-motion blanket below.
`@keyframes forge-spin { to { transform: rotate(360deg); } }
@keyframes forge-dot-pulse { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
` +
// Animated show/hide for hidden-toggled popovers/chrome (.forge-anim opt-in — see the
// [hidden] exemption at the top of this string). Entry: spring scale-in via
// @starting-style (fires on unhide AND on fresh insertion, which is how .menu-popover —
// created per open, removed on close — gets entry-only motion without the class).
// Exit: ~100ms plain fade; `display` rides the transition discretely (allow-discrete)
// so none lands only after the fade. Non-supporting browsers snap (today's behavior).
// The [hidden] rule carries the exit transition (destination-state timing wins).
// #status[hidden] is the ID-specificity trap: #status's own `display: flex` (1,0,0)
// outranks .forge-anim[hidden]'s display:none (0,2,0), so a hidden status strip would
// stay visible — the (1,1,0) ID-anchored override wins, and stays non-important so the
// allow-discrete display transition still holds it visible during the exit fade. Keep
// in sync if any other ID-selector element ever gets .forge-anim.
`.forge-anim, .menu-popover {
  transition: opacity var(--dur-pop) var(--ease-spring), transform var(--dur-pop) var(--ease-spring), display var(--dur-pop) allow-discrete;
  transform-origin: top center;
}
.forge-anim[hidden] {
  display: none; opacity: 0; transform: scale(0.98);
  transition: opacity 100ms var(--ease-out), transform 100ms var(--ease-out), display 100ms allow-discrete;
}
#status[hidden] { display: none; }
@starting-style {
  .forge-anim, .menu-popover { opacity: 0; transform: scale(0.96); }
}
` +
`@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
  }
}
`

export class Overlay {
  host = document.createElement('div')
  toggle = createButton({ label: 'Design' })
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
  /** The inner fade-then-hide timer clearRipples() arms (opacity->0 now, hidden RIPPLE_FADE_MS
   *  later). Tracked so a re-show can cancel it — otherwise a showRipples() that lands mid-fade
   *  (e.g. right after setActive(false) started one) restores the divs to visible, but the
   *  STALE timer from the earlier clear still fires later and wrongly hides the freshly
   *  re-shown ripples out from under it. */
  private rippleFadeTimer: ReturnType<typeof setTimeout> | null = null
  private outlineTweenTimer: ReturnType<typeof setTimeout> | null = null

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
    this.status.classList.add('forge-anim')
    this.sentLabel.id = 'sent'
    this.sentLabel.hidden = true
    this.watchLabel.id = 'watch'
    this.watchLabel.hidden = true
    // Watch indicator leads the strip — it's ambient session state ("● Linked…"), read
    // before the per-draft controls and per-send summary.
    this.unlinkButton.hidden = true
    this.status.append(this.watchLabel, this.unlinkButton, this.statusLabel, this.copyButton, this.compareAllButton, this.resetAllButton, this.sentLabel)
    this.outline.hidden = true
    this.selectOutline.hidden = true
    this.status.hidden = true
    root.append(style, this.toggle, this.status, this.outline, this.selectOutline)
  }

  mount(): void {
    // On <html>, not <body>: canvas mode applies a transform to <body>, and a transformed
    // ancestor hijacks position:fixed — every overlay outline/panel is fixed-positioned.
    // Bonus: app CSS like `body > *` can no longer style the host.
    document.documentElement.appendChild(this.host)
  }

  /** Mounts an external element (the panel root, the zoom-pill chrome, …) into the shadow
   * root — every overlay-adjacent DOM node lives inside the same shadow tree as #toggle/#status
   * so app CSS can never reach in and so contains()/containsDeep() see it as part of the host. */
  attach(el: HTMLElement): void {
    this.host.shadowRoot!.appendChild(el)
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.host.contains(target)
  }

  /** Like contains(), but also true for nodes INSIDE the host's shadow tree. Node.contains
   * never crosses a shadow boundary, so plain contains() only works for callers passing a
   * RETARGETED event target (which the shadow boundary collapses to `host` itself — the
   * document-level listeners in index.ts). A caller that un-retargets via composedPath()[0]
   * (CanvasMode.realTarget) gets the real inner node back and needs this variant, or every
   * wheel/keydown over the panel would read as "not ours" and hijack panel scrolling. */
  containsDeep(target: EventTarget | null): boolean {
    return this.contains(target) || (target instanceof Node && !!this.host.shadowRoot?.contains(target))
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

  /** tween=true animates the outline from its current rect to the new one (Figma-style
   * selection hop — deliberately ease-out, not spring: a springy rect reads as wobble).
   * Callers that TRACK an element (remeasure on scroll/resize/edit-reflow) keep the
   * default snap — the tween is only for the selection CHANGING, and any tracking call
   * landing mid-tween disarms it (direct manipulation wins). First show from hidden
   * never tweens (it would fly in from a stale rect); it fades in via @starting-style. */
  showSelectOutline(rect: DOMRect, tween = false): void {
    const el = this.selectOutline
    if (this.outlineTweenTimer) clearTimeout(this.outlineTweenTimer)
    this.outlineTweenTimer = null
    if (tween && !el.hidden && !prefersReducedMotion()) {
      el.classList.add('tween')
      this.outlineTweenTimer = setTimeout(() => {
        this.outlineTweenTimer = null
        el.classList.remove('tween')
      }, DUR_FAST_MS + 50)
    } else {
      el.classList.remove('tween')
    }
    this.place(el, rect)
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
    // A re-show must cancel a stale in-flight fade from an earlier clearRipples() call, or
    // that timer still fires later and hides the ripples this call just made visible again.
    if (this.rippleFadeTimer) {
      clearTimeout(this.rippleFadeTimer)
      this.rippleFadeTimer = null
    }
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
    if (this.rippleFadeTimer) clearTimeout(this.rippleFadeTimer) // guard a rapid double-call
    for (const div of this.ripplePool) div.style.opacity = '0'
    this.rippleFadeTimer = setTimeout(() => {
      this.rippleFadeTimer = null
      for (const div of this.ripplePool) div.hidden = true
    }, Overlay.RIPPLE_FADE_MS)
  }

  updateStatus(draftCount: number, comparingAll: boolean, sentText?: string, watch?: { text: string; live: boolean; unlinkable?: boolean }): void {
    // Strip is visible when there are drafts OR a non-empty summary OR a watch indicator.
    // Since composer consolidation Task 3 (2026-07-09), the caller (index.ts's refreshStatus)
    // only passes a `watch` indicator for a genuinely LINKED terminal watcher ('live' or
    // 'asleep') — an embedded session's own lifecycle no longer gets a strip of its own (the
    // composer's placeholder text and drafts pill already carry that state), and a 'none'
    // watcher passes `undefined` rather than the old upfront "not linked" hint. So the strip is
    // now genuinely absent most of the time, not "visible whenever design mode is on". `watch`
    // stays optional so callers without watch state (tests, panel-only flows) keep today's
    // hide-when-empty behavior.
    this.status.hidden = draftCount === 0 && !sentText && !watch
    // Draft-count label and controls are hidden when no drafts (they act on drafts)
    this.statusLabel.hidden = draftCount === 0
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

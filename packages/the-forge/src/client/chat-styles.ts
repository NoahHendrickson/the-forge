// Chat/session-feed CSS — the fragment module concatenated into overlay.ts's CSS constant
// (extracted 2026-07-20: overlay.ts crossed the under-1k line convention, flagged in the
// PR #34 and PR #42 reviews). Same rules as every overlay.ts chunk: JS comments live
// BETWEEN the concatenated template segments, never inside them (CSS-string comments ship
// as bundle bytes — guard-tested in overlay.test.ts), colors/fonts/motion ride the :host
// token block overlay.ts generates, and every class name is a test hook — extend, don't
// rename. This module must stay a pure string fragment: no DOM access, no exports besides
// CHAT_CSS, no imports that drag behavior in — overlay.ts is the only consumer (PR #43
// review: shared JS/CSS constants like the textarea cap live beside overlay.ts's TOKENS,
// never here — behavior modules must not import a styles fragment).

export const CHAT_CSS =
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
// .chat-textarea's max-height rides --chat-textarea-max, generated from overlay.ts's
// TEXTAREA_MAX_PX — the same constant session-feed.ts's autoGrow clamps to (no-drift).
`.chat-input {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--border-panel); border-radius: 8px; background: var(--control);
  padding: 6px; transition: border-color 120ms, box-shadow 120ms;
}
.chat-input:focus-within { border-color: var(--accent); }
.chat-input.has-items { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(13,153,255,0.15); }
.chat-textarea {
  box-sizing: border-box; width: 100%; resize: none; min-height: 40px; max-height: var(--chat-textarea-max);
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
`

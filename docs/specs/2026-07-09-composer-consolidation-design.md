# Composer consolidation — design doc

**Date:** 2026-07-09
**Status:** Ratified (2026-07-09) — post-milestone-B layout pass; implementation not started
**Parent:** [2026-07-09-chat-surface-design.md](2026-07-09-chat-surface-design.md) (milestone B, merged `8d5c5ea`)

## 1. Overview

The bottom of the panel currently stacks five strata (status row → chat list → config bar → chip → input → Send → Changes section → watch strip). This pass consolidates them into a single modern composer — the layout language of Claude Desktop / Codex: small dropdowns around the input, send inside the box, statuses as placeholder text, drafted edits as a pill riding the same send gesture — and gives the chat room to breathe.

### Ratified decisions (2026-07-09)

1. **Layout A — unified composer.** One bordered card (`.chat-composer`) owns everything below the chat list: chips row (element chip + drafts pill), textarea, controls row (model/effort/permission compact selects left, circular send right). The Changes top-level section is removed; ChangeList mounts inside a disclosure anchored to the drafts pill.
2. **Send = everything present.** Drafts ride the existing queue+dispatch path AND typed text rides `/session/say`; one click sends both — server-side nudge-before-FIFO already guarantees edits apply before the message is answered. Text alone → chat only; drafts alone → edits only.
3. **Draggable divider** (`.feed-divider`) between the properties area and the chat section redistributes panel height; min-heights both sides; position persisted in sessionStorage beside the panel's existing size persistence. Chat defaults taller than today.

### Dispositions (agent-proposed, user-approved with the design)

- **Send↔Stop morph:** while a turn is in flight AND the textarea is empty, ↑ becomes ■ (interrupt); typing flips it back to ↑ (messages queue mid-turn via the existing FIFO). The standalone Stop button is deleted.
- **Statuses → placeholder:** ready "Message, or send your edits…", starting "Starting session…", busy "Working…", config-disabled reason as today. Errors remain feed ROWS (content, not chrome); the status row is deleted.
- **Drafts pill lifecycle:** appears when inline-style drafts exist ("N edits drafted"); after send shows "applying…" while lifecycle rows are in flight; clears when terminal. Expanding the pill shows the real ChangeList (draft→sent→applying→done rows, re-send/dismiss/Compare intact).
- **Watch strip renders only when a terminal session is linked** — the embedded session's state is carried by placeholder + pill.

## 2. Structure

```
#panel
  head / actions / body (property sections)          ← unchanged
  .feed-divider                                      ← NEW drag handle
  .session-feed
    .session-list (chat bubbles/tool rows/approvals) ← taller default, flex-grows
    .chat-composer                                   ← NEW single card
      .composer-chips:  .chat-chip | .draft-pill (+ .draft-disclosure → ChangeList)
      .chat-input textarea (placeholder = status)
      .composer-controls: .session-model ▾ .session-effort ▾ .session-permission ▾ · spacer · .composer-send (↑/■)
  footer: watch strip only when watcher linked       ← conditional
```

Deleted surfaces: `.session-status` row, standalone `.session-stop` button, `.session-config-bar` (selects move into `.composer-controls`), the Changes top-level section chrome (`changesSlot` content moves into `.draft-disclosure`).

## 3. Behavior contract

- **Send verb (host-owned, as ratified in milestone B):** on ↑ — if drafts exist, run the existing send-to-agent flow (queue POST → dispatch) first; if trimmed text exists, `POST /session/say` (with chip element if attached); both → drafts then say. Failures keep the current milestone-B semantics (text preserved on failure, transient error rows, 429 copy).
- **Morph:** busy(turn in flight) && textarea empty → ■ interrupt (POST /session/interrupt). Any text present → ↑. Never disabled while enabled-state (availability rules unchanged from milestone B).
- **Pill:** count = live drafts store; click toggles disclosure; disclosure hosts the existing ChangeList root (component moves, does not fork — all its class hooks and tests keep working). Pill state text: `N edits drafted` → `applying…` (any row in sent/applying) → hidden (all terminal + drafts empty).
- **Placeholder mapping** reads the same availability + session state the host already derives; no new polling.
- **Divider:** pointer-drag adjusts the flex split between `#panel .body` and `.session-feed`; clamps at 120px min each side; double-click resets to default; persisted key beside the panel-size key in lifecycle-store's sessionStorage namespace.

## 4. Constraints

- All controls via `src/client/ui/` factories; new hooks `.chat-composer`, `.composer-chips`, `.composer-controls`, `.composer-send`, `.draft-pill`, `.draft-disclosure`, `.feed-divider`; existing hooks extend, never rename. No CSS-string comments.
- Zero new deps; zero idle overhead (divider listeners active only while panel is open; no new timers).
- Budget: within the existing 320KB ceiling (this pass should be roughly net-neutral: new CSS vs deleted section chrome).
- **Panel-patterns amendment:** this supersedes the "Changes as a stable top-level section" part of docs/research/2026-07-04-panel-patterns.md — user-ratified 2026-07-09 in this spec. Other panel-patterns rulings (Mixed-not-blank, section order for property sections) stand.

## 5. Testing

- jsdom: pill visibility ↔ drafts store; send-verb matrix (text only / drafts only / both — assert queue POST + say ordering); morph logic (busy+empty → ■, typing → ↑, click ■ → interrupt); placeholder mapping per state; disclosure hosts ChangeList (its existing suite keeps passing unmoved); divider clamps + persistence; watch strip conditional rendering.
- Stories: composer states (ready, busy-morphed, drafts pill, disclosure open, disabled).
- fake E2E: extend assertions to the new hooks (composer present, pill appears after a draft, send-both round-trip).
- Real-browser pass at the end (layout work — jsdom can't see flex/drag).

## 6. Out of scope

- Any server/protocol change (this is client-only; the send verb composes EXISTING endpoints).
- Mic input (still deferred); milestone C adapters.

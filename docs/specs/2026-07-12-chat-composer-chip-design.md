# Chat composer chip consolidation + message rendering pass

**Date:** 2026-07-12 · **Status:** approved (Noah, 2026-07-12) · **Scope:** `src/client/session-feed.ts`, `src/client/overlay.ts` (CSS), tests

## Goal

Make the composer read like a modern AI chat input and the feed read like a conversation:
one chip inside the input box, a "primed" glow when there's something to send, full-width
user bubbles, plain left-aligned assistant text, and the sent message anchored to the top
of the feed while the reply streams in below.

## 1. Input box restructure

`.chat-input` becomes the bordered box: `border`, `background`, and `border-radius` move off
`.chat-textarea`, which goes borderless/transparent inside it. The unified chip renders
inside `.chat-input`, above the textarea. Focus styling moves to the wrapper:
`.chat-input:focus-within { border-color: var(--accent); }`.

The composer card (`.chat-composer`) keeps its own border — the double-border look resolves
because the textarea no longer draws one; only `.chat-input` and the card do.

## 2. Unified chip

`.draft-pill` absorbs the element chip (`.chat-chip` retires — markup, CSS, and tests):

| State | Label | Chevron | × |
| --- | --- | --- | --- |
| Drafts only | `3 changes` | yes | no |
| Element only | `div.hero` | no | yes |
| Both | `3 changes · div.hero` | yes | yes |
| Neither | chip hidden | — | — |

- Click toggles the draft disclosure (existing mechanics) — a no-op when there are no drafts.
- × detaches the element only (routes to the existing `setChip(null)` path); draft dismissal
  stays inside the ChangeList rows.
- The pill keeps its class and disclosure wiring; the element label and × are new child
  spans (`.draft-pill-el`, `.draft-pill-clear`).

## 3. Primed state

Whenever the chip is visible (element attached OR drafts pending), `.chat-input` carries
`has-items`: accent border plus a soft accent glow (`box-shadow` with the accent color at
low alpha), persisting without focus. Reads as "ready to send".

## 4. Message rendering

- `.chat-user`: full-width bubble — stronger background, 8px radius, padding; the
  `.chat-msg-ref` element line stays inside it.
- `.chat-assistant`: `background: none`, no bubble padding — plain left-aligned text.
- `.chat-streaming`: the dashed border goes (odd on a non-bubble); a blinking caret via
  `.chat-streaming::after` marks the in-progress reply instead.

## 5. Anchor sent message at top

On send, the feed scrolls so the new user bubble's top aligns with the top of the
`.session-list` viewport, and the reply streams in below it (claude.ai behavior).

Mechanism: a `.feed-tail-spacer` element stays the last child of `.session-list` — never a
session row (excluded from `rowList`/MAX_ROWS; `addRow` inserts before it). On send it is
sized so the bubble can reach the viewport top (`list.clientHeight − bubble.offsetHeight`,
floored at 0), then the bubble is `scrollIntoView({ block: 'start' })`-anchored. On each
subsequent row/delta the spacer shrinks to
`max(0, list.clientHeight − height from anchor bubble to feed end)` so it never leaves more
blank space than needed. There is no other autoscroll behavior today; none is added beyond
this anchor.

## Testing

- jsdom: chip label/chevron/× across the four states, × routes to `setChip(null)`, click
  toggles disclosure only when drafts exist, `has-items` class toggling, wrapper/textarea
  class structure, user/assistant bubble class output, spacer exists and is excluded from
  the row cap, anchor path calls `scrollIntoView` (mocked).
- Real-browser E2E against the demo app (repo gotcha: jsdom sees no layout): glow, full-width
  bubbles, anchor-at-top with streaming reply below, spacer never visibly holds stale blank
  space.
- CSS class hooks extended, not renamed — except the deliberate `.chat-chip` retirement.

## Out of scope

Send/stop morph, composer pickers (`composer-config.ts`), ChangeList internals, server/
session code — all untouched.

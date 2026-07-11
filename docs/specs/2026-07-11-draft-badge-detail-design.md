# Draft badge + detail design — 2026-07-11

Compact affordance for batched drafts: the composer's drafts pill counts individual
property changes (not elements), signals it opens with a chevron, and the open disclosure
lists every change per element instead of "first +N more" behind a hover-only tooltip.

User-ratified choices (2026-07-11 brainstorm):

- **Pill counts changes, not elements** — "7 changes drafted", matching the bullets the
  agent will actually receive; not "2 elements · 7 changes", not the current element count.
- **Draft rows always list every change** as sub-lines once the disclosure is open — the
  pill click IS the opt-in to detail; no second per-row expand, no hover popover.
- **Sent/applying/done rows keep the compact "+N more" summary** — history stays terse;
  full detail is reserved for the about-to-send moment.

## Current state (what changes)

- `.draft-pill` (`session-feed.ts` setDraftState) reads `drafts.elementCount()` via
  `index.ts` refreshStatus: "1 edit drafted" / "N edits drafted". One element with four
  property drafts shows "1 edit drafted".
- The pill is a bare text button — no visual hint that clicking toggles
  `.draft-disclosure.open`.
- ChangeList draft rows (`changelist.ts` renderDraftRow) and sent rows both compress via
  `collapseWithMore`: visible text is the first change + "+N more", the full list only in
  the row's native `title` attribute (hover-only, delayed, invisible on touch).

## Design

### 1. Pill label — change count

`DraftStore.changeCount()`: sum of the per-element property-map sizes — same cheap
Map-size read as `elementCount()`, no scanning. `index.ts` refreshStatus passes it in the
existing `setDraftState({ count, applying })` payload; `session-feed.ts` renders
"1 change drafted" / "N changes drafted" (the `applying…` label is untouched).

Accepted caveat: a draft scrubbed back to its exact original still counts — no-ops are
only detectable at send-time via computed styles (`buildChangeRequestWithElements`), and
the existing element count has the identical blind spot. The count self-corrects on send.

`elementCount()` stays — the overlay status line and `hasDrafts` checks still use it.

### 2. Chevron on the pill

A chevron glyph in a `span` appended after the pill's label text, rotated 180° via CSS
while the disclosure is open. The pill click handler already toggles
`.draft-disclosure.open`; it now also mirrors an `.open` class onto the pill itself so the
CSS has a same-element hook. Because setDraftState rewrites the label, the pill's text
node and chevron span are managed as children (label span + chevron span), not
`textContent` on the button — `.draft-pill` class and click behavior unchanged (test
hooks: extend, don't rename). Built via the existing `createButton` pill; no new factory.

### 3. Draft rows list every change

`renderDraftRow` drops `collapseWithMore`: after the element-label line, each drafted
property renders as its own sub-line (new `.change-detail` class, one per property), in
the row's existing per-entry format `prop → value` (e.g. `padding-top → 24px` — the
DraftStore's `original` is the prior *inline* style, usually empty, so there is no
meaningful "before" to show; the real before/after pair is computed at send time). The
`title` tooltip on draft rows goes away (redundant once the detail is visible). Sent-row `summarize()` and `collapseWithMore` stay exactly as
they are for sent/applying/done/failed rows.

Row hover/click element-highlight behavior is unchanged — sub-lines render inside the
existing row container so the row-level handlers cover them.

## Out of scope

No changes to the request builder, queue, agent-facing markdown, or send lifecycle —
this is purely the overlay's presentation of what will be sent. Sent-row rendering is
untouched.

## Testing

- `tests/client/drafts.test.ts`: `changeCount()` — 0 when empty, sums across elements,
  decrements on targeted discard/commit.
- `tests/client/session-feed.test.ts`: pill label assertions updated to "N changes
  drafted"; chevron span present; `.open` class mirrors disclosure state.
- `tests/client/changelist.test.ts`: draft row renders one `.change-detail` line per
  drafted property; no `title` attribute on draft rows; sent rows still collapse via
  "+N more".
- jsdom covers all of the above (no layout dependence); real-browser pass in the demo app
  before merge (per gotcha: jsdom can't prove visuals).

## Budget

Client bundle is at 236/250KB — this adds a label variant, a chevron span + a few CSS
rules, and a render loop swap; well under a KB. Verify with the existing budget check in
`check-prod-clean.sh` / the client-budget test.

# Watcher unlink + not-linked state — design

**Date:** 2026-07-05
**Status:** approved (brainstormed with user; approach A of A/B/C)

## Problem

Two gaps in the linked-session (watch mode) UX, both found in first real use:

1. **No user-facing way to stop a live watcher.** Interrupting the agent session works, but nothing in the overlay says so, and a user who started `/forge-watch` in a session they've since backgrounded has no way to stop it short of killing that session or waiting out the 20-minute idle stop.
2. **No upfront "nothing linked" state.** With no watcher, the strip renders nothing; the user only learns their Send went to the manual fallback ("type /forge-design…") *after* clicking Send. The user wants to see "not linked" before sending, with a pointer to how to link.

## Decision reversal (recorded deliberately)

The original watch-mode design ratified: *`none` renders nothing — terminal-only users must see zero UI change from watch mode existing* (`watch.ts` doc comment, `updateStatus` visibility rule). The user has explicitly revised this: an always-visible link-state indicator while design mode is on is worth the change for terminal-only `/forge-design` users. Consequence: the status strip is visible whenever design mode is on (previously hidden with zero drafts and nothing sent).

Send-time copy also changes CTA: `/forge-watch` (link a session) becomes the steer everywhere for the `none` state; `/forge-design` still works but is no longer advertised at send time.

## Design

### 1. UI — status strip

- `watchIndicatorFor` (in `watch.ts`, the single copy home) gains a `none` row and now always returns an indicator:
  - `none` → `○ Not linked — type /forge-watch in Claude Code to link` (existing `--watch-idle` gray).
- Strip visibility in `Overlay.updateStatus`: visible whenever design mode is on (the `watch` argument is now always present).
- New unlink button next to the watch label: `✕`, created via the `ui/button` factory (never raw `createElement`), test-hook class `watch-unlink`, Storybook story in `stories/`. Shown for `live` and `asleep`; hidden for `none`.
- Click → `POST /__the-forge/unwatch` with `forgeHeaders()` (X-Forge-Secret) → on success trigger an immediate `WatchStatus` re-poll so the indicator flips to "Not linked" without waiting the 5s poll tick.

### 2. Server — `WatcherHub.unlink()` + `/unwatch` endpoint

New endpoint `POST /__the-forge/unwatch`, added to `MUTATING_PATHS` (secret-gated). Calls new `WatcherHub.unlink()`:

- **Parked waiter:** settle with `{stop: true, reason: 'unlinked'}` (new `WaitResponse` reason) — the loop hears the stop directly through its in-flight `/wait` and ends. No token denial: this is the same trust model as the idle stop (a loop told to stop directly is trusted to obey), and a denial here would bounce a legitimate later `/forge-watch` re-run from that same session once before letting it re-link.
- **One-shot token denial, only for the not-parked case** (between cycles, or mid-apply): nothing is parked, so no response can carry the stop — flipping `watching` off alone would let the loop's next `/wait` re-arm as if the user had run `/forge-watch` again. Instead the hub remembers the last-seen watcher token and that token's **next** wait gets `{stop, 'unlinked'}`, then the denial clears. One-shot is the correct scope: it ends the in-flight loop, and any wait after that is by definition a deliberate user re-run of `/forge-watch`, which must re-link. (A tokenless legacy bin can't be denied — its loop re-arms on its next wait; accepted, same advisory-only degradation as the `replaced` fallback.) One-shot is the correct semantics: it ends the in-flight loop, and any later wait from that token is by definition a deliberate user re-run of `/forge-watch`, which must re-link. (Mirrors the existing `replacedToken` absorption; requires the hub to record the last-seen token at wait entry, since nothing is parked to read it from.)
- **Every case:** `watching = false`, `everWatched = false`, `replacedToken = null` → `state()` returns `'none'`. Asleep-dismiss is therefore the same operation with nothing to settle. All polling browsers converge on "Not linked" within one poll (≤5s).
- **Queue untouched:** claimed items finish applying and `mark_applied` still works; pending items stay queued and deliver to whoever links next.
- Response body: `{ watcher: 'none' }`.

### 3. Copy matrix

All client copy stays in `watch.ts`; one new canned text in `mcp/protocol.ts`.

| Surface | `none` copy |
| --- | --- |
| Strip indicator | `○ Not linked — type /forge-watch in <Agent> to link` |
| Send flash (`sentLabelFor`) | `Sent — queued. Type /forge-watch in <Agent> to link & apply` |
| Queued line (`queuedLineFor`) | `N queued — type /forge-watch in <Agent> to link & apply` |

Agent-side stop text for `unlinked` (terse — per-tick token-cost rule; never interpolates server data):

> Watching stopped — the user unlinked this session from the design panel. Run /forge-watch to re-link if asked. Do not call wait_for_design_edits again unless the user asks.

Version skew: the bin maps stop reasons to canned texts; an unrecognized reason falls back to the `idle` text (graceful mid-upgrade degradation; bin and plugin normally ship from the same install).

### 4. Accepted edges

- **Dev-server outage:** `degrade()` drops `live → none`, so the indicator reads "Not linked" during an outage. Accepted: the verifier already owns the loud "unreachable" messaging; the indicator must not be a second alarm (same rationale as the existing `degrade()` comment).
- **No confirmation dialog** on unlink: one click, fully reversible via `/forge-watch`.
- **Mid-apply unlink** still lets the apply finish and be verified; only the *loop* ends.

### 5. Tests

Mirror `src/` layout; root `npm test` is the gate.

- `tests/client/watch.test.ts` — new `none` matrix rows (indicator, send flash, queued line).
- `tests/server/watchers.test.ts` — unlink while parked (waiter resolves `unlinked`, state → `none`, next wait from the same token re-arms cleanly); unlink between cycles / mid-apply (one-shot token denial on next wait, then clean re-arm on the wait after); asleep-dismiss (everWatched cleared, no denial); unlink when `none` (no-op, still 200).
- `tests/server/endpoints.test.ts` — `/unwatch` requires `X-Forge-Secret`; response shape.
- `tests/mcp/protocol.test.ts` — `unlinked` canned text; unknown-reason → `idle` text fallback.
- Overlay/client tests — strip visible in design mode with `none` indicator; `watch-unlink` button visibility per state; immediate re-poll after unlink.
- Real-browser E2E against the demo app before merge (jsdom cannot prove strip/overlay behavior).

## Out of scope

- Any change to the dispatch ladder, queue lifecycle, or `/forge-design` pull flow.
- Multi-watcher support (single-slot hub stays).
- Panel/dock placement of link state (approach B, rejected: buries the upfront signal).
- Client-only hide of the indicator (approach C, rejected: loop would keep running/billing).

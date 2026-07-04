# Final review fixes — M5 (m5-dispatch)

## Fix 1 (REQUIRED): manual-rung label vs poller — RED/GREEN

- Bug: the M4 status poller (`Verifier.poll()` in `src/client/verifier.ts`) rendered
  `"N applying…"` from `this.sent.size()` even when the server still reported those
  items as `pending` — i.e. the manual rung, where nothing actually applies until the
  user types `/design` into their agent session. The poller already fetched per-item
  `status` from `/__the-forge/status` but discarded it for anything other than
  `applied`/`failed`.
- RED: added a `manual rung: pending (unclaimed) items show the instruction, not
  "applying…"` describe block to `tests/client/verifier.test.ts` — sends an item,
  mocks `/status` to report it `pending`, and asserts the summary is exactly
  `"1 queued — type /design in Claude Code"` (never `"applying…"`); a follow-up test
  flips the mock to `claimed` on the next tick and asserts the summary becomes
  `"1 applying…"`; two more tests cover the `codex` display name and the
  `claude-code` default when `__THE_FORGE__.agent` is unset. All five failed against
  unmodified `verifier.ts` (`expected '1 applying…' to be '1 queued — type /design in
  Claude Code'`), confirming the bug.
- Also updated the one **pre-existing, now-stale** test (`prepends a pending
  "applying…" segment...`) — it predates the dispatch/manual-rung feature and its
  mock never included a status for the second ("still pending") item at all. Renamed
  it to `...for CLAIMED entries...` and had its mock explicitly report that item as
  `status: 'claimed'`, which is the only status for which "applying…" is actually
  correct.
- GREEN:
  1. New `src/client/agent.ts` — extracted the `AgentName` type and
     `AGENT_DISPLAY_NAME` map (previously private to `client/index.ts`) into a shared
     module, plus a `currentAgent()` helper reading
     `globalThis.__THE_FORGE__?.agent ?? 'claude-code'`. Avoids a circular import
     (`index.ts` already imports `verifier.ts`).
  2. `client/index.ts` now imports `AgentName`/`AGENT_DISPLAY_NAME` from `./agent`
     instead of defining them locally; behavior unchanged.
  3. `client/verifier.ts`: `poll()` builds a `statusById` map from the `/status`
     response, then for every id still in `sent.pendingIds()` after
     applied/failed handling, counts it as `claimed` (status === `'claimed'`) or
     `pendingManual` (status === `'pending'`, OR missing/unknown in the response —
     conservative default, since "we don't know it was claimed" must not imply
     "applying"). `renderSummary(counters, claimed, pendingManual,
     agentDisplayName)` renders the manual instruction
     (`"${pendingManual} queued — type /design in ${agentDisplayName}"`) whenever
     `pendingManual > 0`, else `"${claimed} applying…"` whenever `claimed > 0`.

## Fix 2 (REQUIRED): stale claimed-without-claimedAt in queue.pull() — RED/GREEN

- Bug: `Queue.pull()`'s re-claim check was `if (i.status === 'claimed' && i.claimedAt)
  { ...age check... } return false` — a `claimed` item with a **missing** `claimedAt`
  (legacy M4 `queue.json` shape, written before `claimedAt` existed) fell through to
  `return false`, i.e. permanently un-reclaimable; an **unparseable** `claimedAt`
  (`new Date(...).getTime()` → `NaN`) made the age arithmetic `nowMs - NaN > timeout`
  evaluate to `false` too, same permanent-stuck outcome.
- RED: added two tests to the `claim timeout` describe block in
  `tests/server/queue.test.ts` — hand-write a `queue.json` with a `claimed` item
  missing `claimedAt` entirely, and a second with `claimedAt: 'not-a-date'`; assert
  `pull()` returns the item on the very first call and restamps a valid `claimedAt`.
  Both failed against unmodified `queue.ts` (`expected [] to deeply equal
  ['legacy-1']`), confirming the item was stuck.
- GREEN: `pull()`'s claimable filter for `status === 'claimed'` now: `if
  (!i.claimedAt) return true`; else parse `claimedAtMs = new
  Date(i.claimedAt).getTime()`, `if (Number.isNaN(claimedAtMs)) return true`; else
  the original age check.

## Fix 3 (REQUIRED): /dispatch no-op when nothing pending — RED/GREEN

- Bug: `POST /__the-forge/dispatch` always ran the dispatch ladder (tmux/AppleScript/
  deeplink), even with an empty queue and no markdown override — needlessly invoking
  (or risking invoking) the ladder for no actual change request.
- RED: added `short-circuits to the manual rung WITHOUT invoking the ladder when
  there is no pending item and no markdown override` to
  `tests/server/endpoints.test.ts` (empty queue, empty body, spy `dispatchFn`) —
  asserts `{ rung: 'manual', detail: 'nothing pending' }` and `dispatchFn` never
  called. Failed against unmodified `endpoints.ts` (`dispatchFn` was called once).
  A companion test confirms the ladder still runs when a `markdown` override is
  posted even with an empty queue.
- GREEN: `endpoints.ts`'s `/dispatch` handler now checks `if (!pending && markdown
  === undefined) return send(res, 200, { rung: 'manual', detail: 'nothing pending'
  })` immediately after computing `pending`, before building `opts` or calling
  `run(opts)`.
- Updated three **pre-existing** tests that exercised `/dispatch` against an empty
  queue with no markdown and asserted `dispatchFn` *was* invoked (`runs the injected
  dispatch function...`, `defaults the agent from plugin config...`, `falls back to
  the dispatch.ts ladder export...`) — each now seeds the queue with one pending item
  first (`queue.add({}, '...')`), matching real usage (dispatch only ever fires right
  after a queue add) and preserving each test's original intent (opts wiring,
  agent override, default-ladder-export wiring).

## Fix 4 (REQUIRED): mcp differentiates non-ok HTTP from unreachable — RED/GREEN

- Bug: `src/mcp/index.ts`'s `makeBackend()` collapsed two very different failure
  modes into the same `NOT_RUNNING_MESSAGE` ("dev server is not running"): a `fetch`
  that throws (genuinely nothing listening) vs. a `fetch` that succeeds but returns
  a non-2xx status (a *reachable* server that rejected the request — e.g. it
  restarted, or the plugin/bin versions have drifted apart).
- RED: since `mcp/index.ts` runs top-level stdio side effects on import (no seam for
  a unit test), added coverage at the same level as the existing e2e suite
  (`tests/mcp/e2e.test.ts`, which builds and spawns the real `dist/mcp.js`): a new
  describe block spins up a real HTTP server that always answers `500`, points a temp
  `.the-forge/endpoint.json` at it, spawns the built binary, and asserts the
  `pull_design_edits` tool-call error text contains `"HTTP 500"` and `"rejected the
  request"` and does **not** contain `"is not running"`. Failed against unmodified
  `mcp/index.ts` (received the generic not-running message instead). A companion
  describe block (server bound then closed, so the port is genuinely unreachable)
  confirms the original `NOT_RUNNING_MESSAGE` text is preserved for that case.
- GREEN: `mcp/index.ts` adds `rejectedMessage(status)` returning `` `The Forge server
  rejected the request (HTTP ${status}) — the dev server may have restarted or the
  plugin/bin versions may differ; restart your Vite dev server and agent session.`
  ``; both `pull()` and `mark()` now throw `rejectedMessage(res.status)` instead of
  `NOT_RUNNING_MESSAGE` when `!res.ok`, while the `catch` blocks around the `fetch`
  call itself (genuine connection failure) still throw `NOT_RUNNING_MESSAGE`
  unchanged.
- No pre-existing test asserted the old (now-changed) non-ok-path message, so nothing
  needed to be rewritten beyond the new coverage above.

## Fix 5 (REQUIRED): post-timeout ladder can never mutate — RED/GREEN

- Bug: `dispatch()` races `runLadder(...)` against a timeout via `Promise.race`, but
  never cancels `runLadder` — if the overall timeout wins (resolves `'manual'` first)
  while an adapter's `exec()` call is still in flight (e.g. a hung `tmux list-panes`),
  that call could later resolve and let the adapter proceed straight into a
  **mutating** call (`tmux send-keys`, an osascript keystroke script, or `open` for
  the Cursor deeplink) — typing into the user's terminal well after the caller had
  already moved on with the manual-rung answer.
- RED: added a `post-timeout mutation guard (settled flag)` describe block to
  `tests/server/dispatch.test.ts` with three cases: (1) a hung `list-panes` that
  resolves with a matching pane *after* a 20ms `ladderTimeoutMs` has already fired —
  asserts zero `send-keys` calls ever happen; (2) a hung `osascript` call that
  resolves `'ok'` post-timeout — asserts no follow-up `osascript` call is attempted
  (i.e. the ladder doesn't try a second app's script after resolving late); (3) a hung
  Cursor deeplink `open()` that resolves post-timeout — asserts `exec` was called
  exactly once (no retry/second invocation). Case (1) failed against unmodified
  `dispatch.ts` (`send-keys` was called once — `expected [...] to have a length of
  +0 but got 1`), proving the mutation could reach the user's terminal after timeout.
- GREEN: `dispatch.ts` adds an exported `SettledRef { settled: boolean }` interface.
  `dispatch()` creates one `settledRef = { settled: false }`, passes it into
  `runLadder`, and flips `settledRef.settled = true` inside the timeout's
  `setTimeout` callback (immediately before resolving `'manual'`). `runLadder`
  threads `settledRef` into `tryTmux`, `tryAppleScript`, and `tryDeeplink`:
  - `tryTmux` checks `settledRef.settled` immediately after `list-panes` resolves
    (before scanning for a matching pane) and again right before calling `send-keys`.
  - `tryAppleScript` checks it before each per-app `osascript` call in its loop, and
    again immediately after that call resolves (before interpreting `'ok'`/
    `'no-session'` or trying the next app).
  - `tryDeeplink` checks it before calling `open`.
  An already-in-flight exec call can't be un-invoked, but every *subsequent* decision
  point (proceeding to the next step, or trying the next app/rung) now bails to
  `null` once settled — so the ladder can advance no further once the timeout has
  fired.

## Fix 6 (pure refactor): extract shared pruneItems() — GREEN only (no behavior change)

- Extracted the byte-for-byte-identical pruning logic that `Queue.prune()` (in-memory
  path) and `persist()` (merged-array path) each independently re-implemented (age
  cutoff vs. `PRUNE_AFTER_MS` using `finishedBasis`, then an oldest-terminal-first
  overflow cap at `MAX_STORED_ITEMS`) into one pure, exported function:
  `pruneItems(items: QueueItem[], nowMs: number): QueueItem[]` plus a module-level
  `finishedBasis(item)` helper (demoted from a `Queue` static, since it's now used
  outside the class too).
  - `Queue.prune()` is now just `this.items = pruneItems(this.items, this.now())`.
  - `persist()`'s merged-array path is now just `const finalMerged =
    pruneItems(merged, this.now())` (previously ~20 lines duplicating the same
    filter/sort/overflow-drop logic).
- No test changes: this is a pure refactor with identical observable behavior for any
  given input, verified by running the **entire pre-existing** `tests/server/
  queue.test.ts` suite (including the two pruning-basis describe blocks, the pruning
  describe block's 200-item-cap and disk-merge-prune tests, and the createdAt-sort
  test) unchanged and green before and after.

## Verification

- Root `npm test` (`tsc --noEmit` + `vitest run` for `@the-forge/vite`): typecheck
  clean; **680/680 tests passed** (666 baseline + 5 Fix 1 + 2 Fix 2 + 2 Fix 3 + 2
  Fix 4 + 3 Fix 5; Fix 6 added zero new tests by design — pure refactor).
- `./scripts/check-prod-clean.sh` — **PASS** (production build of `@the-forge/vite`
  and the demo app contains no `data-dc-source` / `the-forge` / `__THE_FORGE__`
  trace).

## Deviations from brief

- **Fix 1 — new shared module `src/client/agent.ts`**: the brief said the agent
  display name should come from "the client config global" — `AgentName`/
  `AGENT_DISPLAY_NAME` previously lived only as private declarations inside
  `client/index.ts`, which `verifier.ts` cannot import from without creating a
  circular dependency (`index.ts` already imports `verifier.ts`). Extracted both into
  a new `client/agent.ts` module (plus a small `currentAgent()` reader for
  `globalThis.__THE_FORGE__?.agent`) and had both `index.ts` and `verifier.ts` import
  from it. No behavior change to `index.ts`'s existing `sentLabelFor` copy.
- **Fix 1 — rewrote one pre-existing test instead of leaving it untouched**: `tests/
  client/verifier.test.ts`'s `prepends a pending "applying…" segment...` test predates
  the manual-rung feature and exercised exactly the bug being fixed (its mock never
  told the poller the second item's status, so the poller fell back to `sent.size()`
  and asserted `"applying…"` for what should now correctly become the manual
  instruction). Updated it to mark that item `status: 'claimed'` (the one status for
  which "applying…" is actually correct) rather than leaving an assertion that
  encodes the bug.
- **Fix 3 — updated three pre-existing `/dispatch` tests**: each called `/dispatch`
  against a freshly-created empty queue with no markdown override and asserted the
  injected `dispatchFn` (or the mocked ladder export) was actually invoked with
  specific opts. Under the new no-op short-circuit these would get `{rung: 'manual',
  detail: 'nothing pending'}` without ever calling `dispatchFn`. Fixed by seeding
  each with one `queue.add(...)` call before dispatching, which also better reflects
  real usage (the Send button always queues an item immediately before POSTing
  `/dispatch`).
- **Fix 4 — no unit-level test seam**: `src/mcp/index.ts` is a stdio script with
  top-level `readline`/process side effects and no exported `makeBackend`, so (as
  with the existing e2e suite) the new coverage is at the built-binary /
  spawned-child level rather than a plain unit test — consistent with how this file
  was already tested pre-existing (`tests/mcp/e2e.test.ts`).
- No other deviations. All 6 items implemented as specified; TDD (RED before GREEN)
  followed for items 1–5 as required; item 6 is a pure refactor per the brief with
  all pre-existing tests left unchanged and green.

# Review remediation — 2026-07-16 full-project review

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the confirmed findings from the 2026-07-16 eight-domain full-project review (run at `bd77910`) as six focused PRs, each independently reviewable and gate-green.

**Architecture:** No new subsystems — every task is a surgical fix, a guard test, or a seam move inside existing modules. Six PRs with disjoint file sets (PR 6 stacked on PR 2, which shares `src/server/session/` files). Contract + test-sketch style per HANDOFF convention; implementers read the target file in full before editing and follow TDD (failing test → minimal fix → gate).

**Tech stack:** existing only — TypeScript, vitest + jsdom, tsup, zero new runtime dependencies (hard constraint).

## Global constraints

- Zero new runtime dependencies (`@babel/parser` + `magic-string` only).
- Zero production footprint; zero idle overhead (no listeners/observers/timers while design mode is off).
- Panel/overlay CSS class names are test hooks — extend, don't rename.
- Why-comments are load-bearing — preserve verbatim when moving code; new behavior gets its own why-comment.
- `unknown` + manual checks at I/O boundaries — no schema libraries.
- CLAUDE.md and AGENTS.md are byte-identical (pinned by `tests/docs-sync.test.ts`) — edit both or neither.
- Root `npm test` (typecheck + full vitest) is the gate for every task; `./scripts/check-prod-clean.sh` must pass before each PR is opened (build first; note it currently false-fails under `FORCE_COLOR` — run with `env -u FORCE_COLOR` until PR 5 lands).
- Merge decision belongs to Noah — every PR opens as a normal PR, never merged by the agent.

## Out of scope (deliberately deferred, with reasons)

- **panel.ts stage-3 split** — its own milestone; plan it before the Effects section lands.
- **endpoints.ts declarative route table + 500 path** — worthwhile refactor, separate milestone.
- **EDIT_TIER_ALLOW path-scoping** — behavioral change to a user-ratified posture; PR 5 fixes the misleading comment and the PR description surfaces the scoping question for Noah.
- **transform.ts parse-failure diagnostics, CLI JS-project mount detection, MCP `ping`, wedged-`sent` dismiss affordance, `lastSeq` reset on server restart** — real but lower-value; queue behind this milestone.

---

## PR 1 — fix(loop): send→apply→verify correctness

Branch: `fix/review-loop` off `main`. Files are mutually disjoint; tasks 1–4 can run in parallel.

### Task 1: sidecar passes `agent` to setupProjectConfig

**Files:** Modify `packages/the-forge/src/next/sidecar.ts` (~line 115). Test `packages/the-forge/tests/next/sidecar.test.ts`.

**Contract:** `ensureSidecar` must forward the consumer's `agent` option into `setupProjectConfig` (4th arg), exactly as `src/vite.ts:91` does, so `withForge(cfg, { agent: 'cursor' })` writes `.cursor/mcp.json` at the project root. Verify `SidecarOpts` actually carries `agent` from `withForge` (`src/next/index.ts` threads it); if it doesn't, thread it — the option exists on the public `withForge` surface.

**Test sketch (write first, watch it fail):** in sidecar.test.ts, following the existing setup-side-effect precedent in that suite: `ensureSidecar` with `agent: 'cursor'` in a temp git root → assert `.cursor/mcp.json` exists and contains a `the-forge` server entry; keep a companion assertion that the default (no agent) does NOT write it.

- [ ] Failing test
- [ ] Fix (pass `opts.agent`)
- [ ] `npx vitest run tests/next/sidecar.test.ts` green, then root `npm test`
- [ ] Commit `fix(next): pass agent through sidecar to setupProjectConfig — Cursor-on-Next never got .cursor/mcp.json`

### Task 2: verifier neutralizes longhand drafts, not just collapsed names

**Files:** Modify `packages/the-forge/src/client/verifier.ts` (`verifyElements`, ~lines 62–100). Test `packages/the-forge/tests/client/verifier.test.ts`.

**Contract:** The neutralize stash/strip loop must remove the union of `el.draftProps` and `el.changes.map((c) => c.property)` from the target's inline style before measuring, and restore all of them in the `finally`. Rationale (add as why-comment): `changes` carries collapsed names (`padding-block`, `border-radius` — see `COLLAPSE` in request.ts) while the DraftStore inline styles are the longhands the panel edits; `removeProperty('padding-block')` does not strip inline `padding-top`, so a DOM node surviving HMR with drafts inline would be measured against the client's own draft values — false `done`, then `commit()` visibly snaps the page back. `draftProps` exists for exactly this divergence (see `SentChange` docs in lifecycle.ts); commit uses it, neutralize was missed.

**Test sketch:** jsdom can't compute shorthands from longhands, so pin the mechanism, not the browser outcome: build a `SentEntry` whose element has `changes: [{ property: 'padding-block', afterCss: '8px', … }]` and `draftProps: ['padding-top', 'padding-bottom']`, with inline `padding-top/bottom` set on the target. Wrap `window.getComputedStyle` with a spy that records `target.style.getPropertyValue('padding-top')` at measure time → assert it is `''` during measurement (drafts stripped) and restored to the original inline value afterward. Keep an existing-style longhand test unchanged to prove no regression. Note in the PR body: needs one real-browser E2E pass against the demo app before merge (jsdom gotcha).

- [ ] Failing test → fix → suite green → root gate
- [ ] Commit `fix(client): verifier neutralize strips draft longhands, not just collapsed change names`

### Task 3: queue merge must not resurrect terminal items

**Files:** Modify `packages/the-forge/src/server/queue.ts` (`mergeWithDisk`, ~line 234). Test `packages/the-forge/tests/server/queue.test.ts`.

**Contract:** For ids known to BOTH memory and disk, the copy with the more advanced lifecycle stage wins: rank `pending`(0) < `claimed`(1) < `applied`/`failed`(2). When the disk copy outranks the in-memory copy, adopt the disk copy into `this.items` too (not only the merged output), so the next persist can't re-resurrect. Equal rank keeps the in-memory copy (today's behavior — it may carry a fresher note). Update the mergeWithDisk doc-comment: the "in-memory always reflects the more recent view" premise is false when another server marked the item terminal.

**Test sketch:** two `Queue` instances on one dir. A adds item X; both load; A pulls + marks `applied`; B (whose memory still says `pending`) calls `add()` (forcing B's persist). Assert: queue.json has X `applied`, `B.get(X).status === 'applied'`, and a subsequent `pull()` on either instance does NOT return X.

- [ ] Failing test → fix → suite green → root gate
- [ ] Commit `fix(server): queue merge prefers the more advanced lifecycle stage — applied items no longer resurrect to pending across two dev servers`

### Task 4: lifecycle-store accepts `source: null`

**Files:** Modify `packages/the-forge/src/client/lifecycle-store.ts` (`isValidElementChange`, ~lines 99–105). Test `packages/the-forge/tests/client/lifecycle.test.ts` (or the store's own suite if split there).

**Contract:** `ElementChange.source` is `SourceLocation | null` by type (request.ts) and `renderMarkdown` handles null ("no source tag — locate by selector/text"), so the restore validator must accept `source: null` instead of silently dropping the whole persisted entry for untagged elements. Validation: `v.source === null || (isRecord(v.source) && typeof v.source.file === 'string' …)`. Check whether this makes the `v.dcSource !== null` allowance in `isValidSentElement` live again (review noted it was dead code) — if the null-source entry restores with null dcSource, the restore path should degrade it to `unverified` per the store's existing rules, not reject it.

**Test sketch:** persist a sent entry whose element has `source: null`, `dcSource: null`; reload via the restore path → assert the entry survives (present in restored state, degrading per existing unverified rules), plus the existing invalid-shape tests still reject garbage.

- [ ] Failing test → fix → suite green → root gate
- [ ] Commit `fix(client): lifecycle restore keeps sent entries for untagged elements (source: null)`

### PR 1 wrap-up

- [ ] Full gate + `env -u FORCE_COLOR ./scripts/check-prod-clean.sh` after `npm run build`
- [ ] Open PR: title `fix: verify-loop correctness — sidecar agent arg, verifier neutralize, queue resurrection, null-source restore`; body lists each finding with its review provenance; notes the real-browser E2E requirement for Task 2.

---

## PR 2 — fix(session): embedded-session robustness

Branch: `fix/session-robustness` off `main`. Tasks 5–7 touch `manager.ts`, `claude.ts`+`cursor.ts`, `cursor.ts` respectively — run Task 5 and Task 6 in parallel only if Task 6 stays out of manager.ts; run Task 7 after Task 6 (same file).

### Task 5: post-approval watchdog leash survives adapter events

**Files:** Modify `packages/the-forge/src/server/session/manager.ts`. Test `packages/the-forge/tests/server/session/manager.test.ts`.

**Contract:** Today `onApprovalResolved(allow)` arms `_postApprovalWatchdogMs` (600s), but `_onAdapterEvent` re-arms `_armWatchdog()` → default 120s on ANY event while busy, so one stray `activity` line after Allow collapses the leash and the approved silent build is killed at 120s → respawn → re-send → re-approve — the loop the constant's own why-comment exists to prevent. Fix: add `private _leashMs: number | null = null`. Set in `onApprovalResolved`: `this._leashMs = allow ? this._postApprovalWatchdogMs : null` (before the existing arm call, which becomes `this._armWatchdog(this._leashMs ?? this._watchdogMs)`). In `_onAdapterEvent`'s busy re-arm, use `this._armWatchdog(this._leashMs ?? this._watchdogMs)`. Clear `_leashMs = null` on turn completion and on new turn start (`_sendTurnText`) — deliberately NOT on `tool-finished` (parallel tools: another approved tool may still be running; worst case a hung post-approval session takes 10 min to reap instead of 2, which is the constant's stated trade). Why-comment the field with this scenario.

**Test sketch:** fake-timer test alongside the existing zero-events-after-allow case (manager.test.ts ~line 710): resolve an approval with allow=true, deliver an `activity` event, advance past `watchdogMs` → session still alive; advance to `postApprovalWatchdogMs` → watchdog fires. Second test: after `turn-complete`, the next turn uses the default watchdog again.

- [ ] Failing test → fix → suite green → root gate
- [ ] Commit `fix(session): post-approval watchdog leash survives adapter events — no more approve→kill→re-approve loop`

### Task 6: stdin error guards — a write racing child death must not crash the dev server

**Files:** Modify `packages/the-forge/src/server/session/claude.ts` and `cursor.ts` (spawn sites and `SpawnedChild` usage); possibly `adapter.ts` if the `SpawnedChild` type needs an `on('error')`-capable stdin. Tests `tests/server/session/claude.test.ts`, `cursor.test.ts` + fixtures.

**Contract:** Both adapters attach an `error` listener on the child's stdin at spawn time that swallows EPIPE/`ERR_STREAM_DESTROYED` (the child's death already surfaces through the exit/`ended` path — the stream error adds nothing except an uncaught exception in the host Vite/Next process). No behavior change otherwise; do not add backpressure handling (turn payloads are small — YAGNI, note it in the why-comment).

**Test sketch:** extend the scripted-fixture harness: a fixture child whose stdin emits `error` (EPIPE) after the adapter writes to it post-exit → assert no unhandled exception (vitest fails loud on unhandled rejections/exceptions) and the session still lands in its normal ended state.

- [ ] Failing test (or crash-repro test) → fix → both adapter suites green → root gate
- [ ] Commit `fix(session): guard child stdin 'error' — EPIPE on a write racing child death no longer crashes the host dev server`

### Task 7: Cursor pre-ready interrupt cancels the queued turn

**Files:** Modify `packages/the-forge/src/server/session/cursor.ts` (`interrupt()`, ~lines 178–184). Test `tests/server/session/cursor.test.ts`.

**Contract:** The current pre-ready no-op is justified by "no turn can be in flight," which is false: send-at-spawn parks the turn in `turnQueue` and flushes it on session-ready — Stop during the boot window does nothing and the turn runs anyway. Fix: `interrupt()` before session-ready clears `turnQueue` (and emits whatever completion signal the manager's Stop path expects — read the existing interrupt flow and Scenario 10 fixture before choosing; the pinned test at cursor.test.ts:907 changes deliberately, update it with a why-comment). Do NOT touch the `loadingReplay` suppression.

**Test sketch:** spawn with a queued turn, `interrupt()` before the fixture answers `session/new`, then let session-ready arrive → assert no `session/prompt` is sent and the manager lands idle, not busy.

- [ ] Failing test → fix → suite green → root gate
- [ ] Commit `fix(session): cursor Stop during boot cancels the queued turn instead of silently no-oping`

### PR 2 wrap-up

- [ ] Full gate + prod-clean; open PR `fix: embedded-session robustness — watchdog leash, stdin EPIPE guard, pre-ready Stop`.

---

## PR 3 — fix(client): interaction edge state machines

Branch: `fix/client-interaction-edges` off `main`. Task 8 (controls.ts), Task 9 (composer-send.ts + index.ts), Task 10 (canvas.ts + overlay.ts + index.ts), Task 11 (session-feed.ts + feed-anchor.ts) are file-disjoint — parallelizable except Tasks 9/10 both touch index.ts (different regions; still run them sequentially to avoid edit collisions).

### Task 8: arrows on a pill-bound NumberField must not commit garbage

**Files:** Modify `packages/the-forge/src/client/controls.ts` (keydown handler, ~line 290). Test `tests/client/controls.test.ts`.

**Contract:** The ArrowUp/ArrowDown branch gains a `pillBound` gate, mirroring the existing `=` gate: while bound, arrows are a no-op (return before `preventDefault` so the readOnly input keeps native caret behavior). Today `parseFloat('p-4')` → NaN → base 0 → `commit(±1)` drafts 1px and unbinds the pill — the only path where normal keyboard use corrupts a draft.

**Test sketch:** bind a pill (existing helper in the suite), dispatch ArrowUp keydown → assert no `onInput`/commit fired, display still shows the token label, pill still bound. Companion: unbound field still steps ±1/±10 (existing tests stay green).

- [ ] Failing test → fix → suite green → root gate
- [ ] Commit `fix(client): ignore arrow keys while a NumberField is pill-bound — no more 1px garbage drafts`

### Task 9: second ↑ during an in-flight drafts leg keeps the structural ordering

**Files:** Modify `packages/the-forge/src/client/index.ts` (`sendDrafts` re-entrancy guard) and the `sendDraftsLeg` doc in `packages/the-forge/src/client/composer-send.ts` (ComposerSend itself needs no logic change). Tests `tests/client/design-mode.test.ts` (+ `composer-send.test.ts` doc-level assertions if present).

**Contract:** `DesignMode#sendDrafts` stores its in-flight promise (`private draftsPromise: Promise<boolean> | null`); when called while `draftsInFlight`, it returns THAT promise instead of `Promise.resolve(true)`. Consequence: a second ↑ gesture's chat leg waits for the real queue+dispatch outcome — ordering stays structural (the 2026-07-10 review's property) and a failed first `/queue` correctly suppresses the second gesture's chat too. Update the `sendDraftsLeg` contract comment in composer-send.ts (the "(or the leg was a no-op: … re-entrancy)" clause becomes "re-entrancy returns the in-flight leg's own promise"). Keep the two-flag design — this changes what the drafts flag returns, not the flag split.

**Test sketch:** drafts + text present; fire send() twice before the mocked `/queue`//`dispatch` resolve. Case A (success): assert `/session/say` POSTs happen only after `/dispatch` settled. Case B (first `/queue` fails): assert zero `/say` POSTs from either gesture and the transient error renders once.

- [ ] Failing test → fix → suite green → root gate
- [ ] Commit `fix(client): re-entrant sendDrafts returns the in-flight promise — double-↑ can no longer race /say past /dispatch`

### Task 10: canvas gesture wedges — blur, lost pointerup, stale timers, orphaned squelch

**Files:** Modify `packages/the-forge/src/client/canvas.ts`, `packages/the-forge/src/client/overlay.ts` (ripple pool), `packages/the-forge/src/client/index.ts` (only if teardown wiring needs it). Tests `tests/client/canvas.test.ts`, `tests/client/overlay.test.ts`.

**Contract — four independent sub-fixes, each with its own why-comment:**
1. **spaceHeld sticks across focus loss** (canvas.ts ~443): add a `window` `blur` listener (registered/removed with the other canvas listeners) that clears `spaceHeld` and restores the cursor. Fix the keyup doc-comment's false "keyup always arrives" premise.
2. **Pan drag wedge on lost pointerup** (canvas.ts ~495): in the drag's `onMove`, `if (ev.buttons === 0) return finish(false)` — self-heal when pointerup/pointercancel never arrived (app-switch mid-drag).
3. **Stale ripple hide-timer** (overlay.ts ~1030): track the inner fade `setTimeout` on the instance (like `rippleClearTimer`) so `showRipples()` cancels BOTH before re-showing; clear it in the design-off teardown path too.
4. **Orphaned click squelch** (canvas.ts ~513): keep a reference to the `{capture: true, once: true}` window click squelch and remove it in `removeListeners()` (it currently outlives the gesture when no click ever fires and can eat one unrelated page click after design mode is off — a zero-idle violation).

**Test sketch (jsdom-able):** (1) keydown Space → window blur event → assert `spaceHeld` cleared / next pointerdown does NOT start a pan; (2) start drag, dispatch pointermove with `buttons: 0` → assert drag finished, cursors restored; (3) `clearRipples()` then `showRipples()` before the fade window elapses, advance fake timers past `RIPPLE_FADE_MS` → assert the new ripples are still visible; (4) arm the squelch via a pan, call `removeListeners()` → dispatch a window click → assert it propagates (listener removed). Note in PR body: gesture fixes also need a manual real-browser pass (jsdom gotcha).

- [ ] Failing tests (one per sub-fix) → fixes → suites green → root gate
- [ ] Commit `fix(client): canvas gesture edge cases — blur clears space-pan, lost-pointerup self-heal, ripple timer race, squelch teardown`

### Task 11: feed map hygiene + spacer reset + dedicated FeedAnchor tests

**Files:** Modify `packages/the-forge/src/client/session-feed.ts` (eviction path), `packages/the-forge/src/client/feed-anchor.ts` (`onEvict`). Create `packages/the-forge/tests/client/feed-anchor.test.ts`. Modify `tests/client/session-feed.test.ts`.

**Contract:** (a) When MAX_ROWS eviction removes rows, delete the matching `approvalRows`/`toolRows` map entries (compare by row element), so a still-pending approval re-emitted by the server on reconnect re-renders instead of being deduped into undecidability, and `toolRows` stops growing unboundedly. (b) `FeedAnchor.onEvict` resets `this.spacer.style.height = '0px'` when the anchored row is evicted — its class doc already names "freeze the spacer at its last size forever" as the hazard; today only the bookkeeping is dropped. (c) New `feed-anchor.test.ts` pinning the module's invariant directly: spacer is always `.session-list`'s last child after `anchor()`/`update()`, the anchored-row sizing math, the `0px` early-out, and the new evict reset.

**Test sketch:** session-feed test: render a pending approval, push >MAX_ROWS rows to evict it, re-deliver the same approval event → assert a fresh approval row with Allow/Deny renders. feed-anchor tests as in (c).

- [ ] Failing tests → fixes → suites green → root gate
- [ ] Commit `fix(client): evicted feed rows release their map entries; FeedAnchor resets spacer on evict + gets its own suite`

### PR 3 wrap-up

- [ ] Full gate + prod-clean; open PR `fix: overlay interaction edges — pill arrows, double-send ordering, canvas gesture wedges, feed hygiene`.

---

## PR 4 — fix(tokens): fractional-px and color parsing

Branch: `fix/token-layer` off `main`. One implementer (both tasks touch tokens.ts).

### Task 12: rebind tolerance for fractional-px tokens

**Files:** Modify `packages/the-forge/src/client/panel-token-ui.ts` (`rebind`, ~lines 127–133). Test `tests/client/panel.test.ts` (token pill describes).

**Contract:** `rebind()` currently compares the *rounded* displayed value against the *unrounded* bound px (`13 !== 13.125`), deleting the binding one refresh after it was made on any theme where token px values aren't integers (root font-size ≠ 16, fractional `--spacing`). New rule: the pill survives when `Math.abs(bound.px - value) < 0.5` (i.e. the displayed value is the bound px rounded); true user divergence (≥ 0.5px) still unbinds. Why-comment: displayed values are rounded per the panel-patterns doc, bound px is exact — compare in the rounded domain. The B5/Compare rules are otherwise untouched.

**Test sketch:** bind a token whose px is fractional (e.g. spacing base 3.75 → `p-3.5` = 13.125px, or simulate via a stubbed theme), trigger a refresh where `readValue` reports the rounded 13 → assert the pill is still bound; then set a genuinely diverged value (15) → assert it unbinds.

- [ ] Failing test → fix → suite green → root gate
- [ ] Commit `fix(client): token pill rebind compares in the rounded domain — fractional-px themes no longer shed pills`

### Task 13: parseColor hsl support, toPx unit whitelist, alpha clamp

**Files:** Modify `packages/the-forge/src/client/tokens.ts` (`parseColor` ~193–261, `toPx` ~9–12, alpha parse ~226–240). Test `tests/client/tokens.test.ts`.

**Contract:** (a) `parseColor` gains `hsl()`/`hsla()` (modern space-separated and legacy comma syntax, deg-only hue is fine — YAGNI on grad/turn, say so in a comment) via a small `hslToRgb`; hsl-authored theme tokens then flow into palette rows, `nearestColorToken`, and `suggestColorUtility` like any other color. (b) `toPx` whitelists `px`/`rem`/bare-number-as-px and returns `null` for anything else (`em`, `%`, `ch`, …) — fail safe instead of reading `0.25em` as `0.25px`; audit the call sites so a `null` spacing base skips the spacing scale rather than throwing. (c) Clamp parsed alpha to [0, 1] wherever r/g/b already go through `clamp255`.

**Test sketch:** vectors — `hsl(220 90% 56%)`, `hsla(220, 90%, 56%, 0.5)` → known rgb; `hsl(0 0% 100%)` → white. `toPx('0.25em')` → null, `toPx('0.25rem')` → 4, base derivation with an `em` theme skips spacing tokens without throwing. `rgba(0,0,0,5)` → `a === 1`.

- [ ] Failing tests → fixes → suite green → root gate
- [ ] Commit `fix(client): parseColor learns hsl(), toPx fails safe on unknown units, alpha clamped`

### PR 4 wrap-up

- [ ] Full gate + prod-clean; open PR `fix: token layer — hsl themes, fractional-px pills, unit safety`.

---

## PR 5 — chore(gates): security guard test + endpoints hardening + script gates

Branch: `chore/security-gates` off `main`. Task 14 (tests only), Task 15 (endpoints.ts), Task 16 (scripts) are disjoint — parallelizable.

### Task 14: pin the client.js XSSI defense

**Files:** Modify `packages/the-forge/tests/server/client-bundle.test.ts`.

**Contract:** The `GET /__the-forge/client.js` route is deliberately secret-ungated (it's where the browser gets the secret); its defense against classic-`<script>` exfiltration is that the built bundle fails classic-script parsing (trailing `export{…}`). That property is currently incidental — nothing pins it against a future "drop the unused export" cleanup or an IIFE format switch. Add a test that loads the real `dist/client.js` and asserts `new vm.Script(source)` throws (classic-script parse must fail). Follow the design-mode boundary test's precedent for reading built artifacts (build runs before the gate); do NOT weaken to a regex — the vm parse is the actual property.

**Test sketch:** `import vm from 'node:vm'`; read `dist/client.js`; `expect(() => new vm.Script(src)).toThrow()` with a why-comment citing the 2026-07-10 finding-4 review and this review's F1.

- [ ] Test (passes today — this is a guard; verify it FAILS against a hand-stripped copy to prove it bites)
- [ ] Root gate
- [ ] Commit `test(server): pin client.js classic-script unparseability — the XSSI layer guarding the secret can no longer rot silently`

### Task 15: endpoints hardening trio + comment honesty

**Files:** Modify `packages/the-forge/src/server/endpoints.ts`. Modify `packages/the-forge/src/server/session/claude.ts` (comment only). Test `tests/server/endpoints.test.ts`.

**Contract:** (a) Secret checks use a constant-time compare: helper `secretMatches(provided, secret)` — reject non-string (arrays from duplicated headers), length mismatch, else `crypto.timingSafeEqual` on utf8 buffers; use at both check sites (~267, ~296). (b) `readBody` destroys the request on the too-large trip (`req.destroy()` after rejecting) so a hostile client can't keep streaming into discarded handlers. (c) The `/queue` handler wraps `watcherHub.notify()` in its own try/catch (log a `[the-forge]` warn) — its own comment already says delivery "must never delay or fail the Send"; today a throw after the 200 becomes `ERR_HTTP_HEADERS_SENT` inside the `.catch` → unhandled rejection → dev-server crash on Node ≥15. Also make `send()` idempotent (`if (res.headersSent) return`) as belt-and-braces. (d) Comment fixes: the threat-model comment (~261) claims mode 644/"local hardening out of scope" — the code writes 0700/0600; rewrite to match reality. The `/status` rationale (~142) claims "only ids/statuses" — the response includes agent-authored `note` text; either gate notes behind the secret or (simpler, chosen) fix the comment to honestly document the asymmetry. (e) `EDIT_TIER_ALLOW`'s comment in claude.ts (~17–31) frames bare `Edit`/`Write` rules as "a project-scoped file edit" — they are path-unscoped; rewrite honestly and add a TODO referencing the open scoping decision (surfaced in the PR body for Noah).

**Test sketch:** duplicated `X-Forge-Secret` header (array) → 403; oversized body → 400 and the socket does not accept further writes (assert `req.destroyed`); `/queue` with a `watcherHub.notify` stub that throws → response is still the already-sent 200 and no unhandled rejection (vitest fails loud); existing 403/405 suites untouched.

- [ ] Failing tests → fixes → suite green → root gate
- [ ] Commit `chore(server): timing-safe secret compare, oversized-body destroy, notify isolation; honest threat-model comments`

### Task 16: script gates — FORCE_COLOR fix + real 250KB client budget

**Files:** Modify `scripts/check-prod-clean.sh`.

**Contract:** (a) The size step's `node -e '…console.log(Math.ceil(...))'` colorizes the bare number under `FORCE_COLOR` (Claude Code background shells set `FORCE_COLOR=3`), tripping the script's own `^[0-9]+$` guard into a false FAIL. Wrap in `String(...)`. (b) The oft-cited 250KB client budget is enforced nowhere — add a real check: `dist/client.js` byte size via `wc -c` (portable macOS/Linux), `CLIENT_BUDGET_KB=250`, same PASS/FAIL output style as the package check. Current size is well under (last known ~236KB) so the gate lands green with honest headroom reporting.

**Verification:** `npm run build && FORCE_COLOR=3 ./scripts/check-prod-clean.sh` passes; hand-set `CLIENT_BUDGET_KB=1` and confirm it FAILs (then restore).

- [ ] Fix + verify both directions
- [ ] Commit `chore(scripts): FORCE_COLOR-proof the size gate; enforce the 250KB client bundle budget for real`

### PR 5 wrap-up

- [ ] Full gate + `FORCE_COLOR=3 ./scripts/check-prod-clean.sh`; open PR `chore: security guard test, endpoints hardening, real script gates` — body surfaces the EDIT_TIER_ALLOW scoping question explicitly for Noah.

---

## PR 6 — refactor(pre-C2): adapter seam + shared agent union + doc drift

Branch: `refactor/pre-c2-seams` off `fix/session-robustness` (STACKED on PR 2 — same session files; open after PR 2, note the base in the PR body, rebase onto main when PR 2 merges).

### Task 17: move adapter-shared plumbing out of claude.ts

**Files:** Modify `packages/the-forge/src/server/session/adapter.ts`, `claude.ts`, `cursor.ts`, plus every importer (manager.ts, tests, fixtures — find with grep). Tests: existing suites only (pure move).

**Contract:** `SpawnFn`, `SpawnedChild`, `truncateEditSide`, and its cap constant move from `claude.ts` to `adapter.ts` (the declared harness seam), so the C2 CodexAdapter depends on the seam, not on a sibling adapter. Pure move — preserve every why-comment verbatim; no re-exports from claude.ts (internal-only symbols; update all importers instead). No behavior change: the full suite must pass unmodified except import paths.

- [ ] Move + import updates → root gate green with zero test-logic edits
- [ ] Commit `refactor(session): move SpawnFn/SpawnedChild/truncateEditSide to adapter.ts — CodexAdapter will depend on the seam, not on claude.ts`

### Task 18: shared agent union + guardrails purity guard

**Files:** Modify `packages/the-forge/src/shared/chat-constants.ts`, `src/client/agent.ts`, `src/server/dispatch.ts`, `tests/shared/chat-constants.test.ts`.

**Contract:** Add `export type AgentId = 'claude-code' | 'cursor' | 'codex'` to chat-constants.ts (a type costs zero bytes in either bundle and the file's no-imports rule is about ITS imports — importing from it is its purpose). `src/client/agent.ts`'s `AgentName` and `src/server/dispatch.ts`'s `DispatchOpts['agent']` both become `AgentId` (type-only imports), so the union can't drift across the bundle boundary; `setup.ts:314`'s "must fail to compile" why-comment now genuinely covers both sides. Extend the purity guard test to loop over BOTH `chat-constants.ts` and `guardrails.ts` (which declares the identical no-imports invariant with no guard) and widen the regex to also catch `export … from` re-exports.

**Test sketch:** the extended guard test (fails if either shared file gains an import or re-export); typecheck is the drift gate for the union itself.

- [ ] Failing guard-test extension (prove it bites on a scratch edit) → wire types → root gate
- [ ] Commit `refactor(shared): single AgentId union across client/server; purity guard covers guardrails.ts and re-exports`

### Task 19: doc drift fixes

**Files:** Modify `CLAUDE.md` AND `AGENTS.md` (byte-identical — docs-sync test), `docs/HANDOFF.md`, `packages/the-forge/tsup.config.ts` (comment only).

**Contract:** (a) CLAUDE.md/AGENTS.md client table: add a `motion.ts` row (the motion-token single source, extracted in the 2026-07-12 overlay-motion pass); fix the `dock.ts` row — it says sessionStorage, the code uses localStorage. (b) HANDOFF.md: "ClaudeAdapter is the only implementation so far" → note CursorAdapter (merged 2026-07-11, PR #32) with Codex as C2; fix the false ".superpowers/sdd/progress.md is gitignored" claim (either add the ignore rule or correct the sentence — correct the sentence, adding ignore rules is repo-policy Noah may not want). (c) tsup.config.ts header: "280KB" → 320KB, matching check-prod-clean.sh.

- [ ] Edits (CLAUDE.md/AGENTS.md kept byte-identical) → `npx vitest run tests/docs-sync.test.ts` → root gate
- [ ] Commit `docs: fix drift — motion.ts row, dock localStorage, HANDOFF adapter status, tsup budget comment`

### PR 6 wrap-up

- [ ] Full gate + prod-clean; open PR `refactor: pre-C2 seams + doc drift` with the stacked-on-PR-2 note.

---

## Execution order & verification matrix

1. PR 1 (highest product value) → 2. PR 2 → 3. PR 3 → 4. PR 4 → 5. PR 5 → 6. PR 6 (stacked on 2). PRs 1–5 are file-disjoint and can be open simultaneously for review; implementation happens serially per PR (parallel subagents within a PR only on disjoint files).

Every task: failing test first (except the two pure-guard/doc tasks), root `npm test` before its commit. Every PR: `npm run build` + prod-clean before opening. PRs 1 and 3 additionally note the real-browser E2E requirement (jsdom gotcha) in their bodies for the pre-merge checklist.

## Review provenance

All findings from the 2026-07-16 eight-agent review at `bd77910` (session transcripts + `memory/full-project-review-2026-07-16.md`). Severities and failure scenarios are recorded there; this plan carries only the fix contracts.

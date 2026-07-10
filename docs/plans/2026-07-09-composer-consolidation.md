# Composer consolidation — implementation plan (2026-07-09)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: [docs/specs/2026-07-09-composer-consolidation-design.md](../specs/2026-07-09-composer-consolidation-design.md). Parent: milestone B (merged `8d5c5ea`).

**Goal:** Consolidate the panel's bottom strata into one Claude-Desktop-style composer — send inside the box, dropdowns around the input, statuses as placeholder, drafted edits as a pill sharing the send gesture — plus a draggable divider giving chat more height.

**Architecture:** Client-only. `session-feed.ts` restructures its bottom half into `.chat-composer` (chips / textarea / controls rows) and deletes the status row, standalone Stop, and `.session-config-bar`. The ChangeList component moves unforked from the panel's `changesSlot` into a pill-anchored disclosure. The host (`index.ts`) owns the send-everything verb over existing endpoints. `panel.ts` grows `.feed-divider`. No server changes.

**Tech stack:** unchanged — vanilla shadow-DOM TS, vitest + jsdom, Storybook. Zero new deps.

## Global constraints (spec §4 + CLAUDE.md)

- All controls via `src/client/ui/` factories; new hooks `.chat-composer`, `.composer-chips`, `.composer-controls`, `.composer-send`, `.draft-pill`, `.draft-disclosure`, `.feed-divider`; existing hooks extend, never rename. No CSS-string comments.
- Zero new deps; zero idle overhead — divider listeners exist only while dragging (pointerdown arms move/up, up disarms); no new timers.
- Budget: inside the existing 320KB ceiling (report measured KB at the gate).
- Panel-patterns amendment recorded in the spec (Changes top-level section superseded) — do not "restore" it.
- Tests mirror src/; root `npm test` after every task; real-browser pass at the end (jsdom can't see flex/drag).

**Sequencing:** Tasks 1→4 in order, each `npm test`-green, each its own commit; Task 5 is the browser/E2E gate. Single-file test runs from `packages/the-forge/`.

---

### Task 1 — composer shell: card, controls row, placeholder statuses, send↔stop morph

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts`, `packages/the-forge/src/client/overlay.ts` (CSS)
- Test: `packages/the-forge/tests/client/session-feed.test.ts` (extend/adjust)

**Interfaces produced (later tasks + host rely on):**

```ts
// SessionFeed — existing public surface kept: onSay, onConfig, onInterrupt, onDecide,
// setChip, setAvailability, start, stop. Changes:
//  - onSend REPLACES the internal Send-click→onSay wiring: the composer's ↑ now calls
//    onSend: () => void (host decides the verb — Task 3 wires it). trySend()/Cmd-Enter call onSend too.
//  - getText(): string  and  clearText(): void  — host reads/clears the textarea around its verb.
//  - setSessionState(s: 'idle'|'starting'|'ready'|'busy'|'failed'|'unavailable'): void —
//    drives the placeholder + morph; host feeds it from WatchStatus.sessionState() + availability.
//  - composer DOM: .chat-composer > .composer-chips (.chat-chip + Task 2's pill slot) /
//    textarea.chat-textarea / .composer-controls (.session-model, .session-effort,
//    .session-permission selects, spacer, button.composer-send)
```

**Contract:**
- Build `.chat-composer` at the feed bottom; MOVE the three selects from `.session-config-bar` into `.composer-controls` (delete the bar; selects keep their classes and seeding behavior — their tests must pass with only container-selector updates). Delete `.session-status` row and the standalone `.session-stop` button.
- `.composer-send` (via `createButton`, label set through textContent '↑'/'■', aria-label 'Send'/'Stop'): while `busyish && textarea.value.trim()===''` → shows ■ and click fires `onInterrupt`; otherwise ↑ and click fires `onSend`. `busyish` already tracks turn-in-flight (set on tool/assistant activity, cleared on turn-complete/ended/session-error) — reuse it; input listener re-evaluates the morph per keystroke.
- Placeholder mapping in `setSessionState`: idle/ready → `Message, or send your edits…`; starting → `Starting session…`; busy → `Working…`; failed → `Message to retry…`; unavailable keeps the availability reason path (`setAvailability` unchanged, still disables). Empty-text ↑ with no drafts stays a no-op.
- Chat list flex-grows into the freed space (CSS only here; divider is Task 4).

- [ ] **Step 1: failing tests** — sketch: `composer card exists with chips/textarea/controls rows`, `selects live in .composer-controls and .session-config-bar is gone`, `status row and .session-stop are gone`, `morph: busyish+empty shows ■ and fires onInterrupt`, `typing while busyish flips to ↑ and fires onSend`, `placeholder per setSessionState state`, `Cmd/Ctrl-Enter fires onSend`, `getText/clearText round-trip`. Adjust existing tests that referenced deleted surfaces (status row copy, stop button, config-bar container) — behavior equivalents, not deletions: the stop CAPABILITY test becomes the morph test.
- [ ] **Step 2: verify failure** — `npx vitest run tests/client/session-feed.test.ts`.
- [ ] **Step 3: implement + CSS** (no CSS-string comments; compact 11–12px selects, circular 26px send).
- [ ] **Step 4–5: verify + root gate** (`npm test` — design-mode tests will break on onSay-wiring: fix index.ts minimally here by wiring `onSend` to the OLD text-only verb so the suite stays green; Task 3 replaces it).
- [ ] **Step 6: commit** — `feat(client): unified chat composer — controls row, placeholder statuses, send/stop morph`

---

### Task 2 — drafts pill + disclosure hosting ChangeList

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts`, `packages/the-forge/src/client/index.ts`, `packages/the-forge/src/client/panel.ts` (remove changesSlot), `packages/the-forge/src/client/overlay.ts` (CSS)
- Test: `tests/client/session-feed.test.ts`, `tests/client/design-mode.test.ts`, `tests/client/panel.test.ts` (adjust), `tests/client/changelist.test.ts` must pass UNTOUCHED

**Interfaces produced:**

```ts
// SessionFeed additions:
//  - draftSlot: HTMLElement            // .draft-disclosure content host — index.ts appends changeList.root here
//  - setDraftState(s: { count: number; applying: boolean }): void
//      count>0 || applying → .draft-pill visible with text `${count} edit${s} drafted` or 'applying…'
//      count===0 && !applying → pill hidden, disclosure closed
//  - pill click toggles .draft-disclosure (a <details>-free div toggle; class .open)
```

**Contract:**
- `panel.ts`: delete `changesSlot` from the append list (and the field); `index.ts` appends `this.changeList.root` into `feed.draftSlot` instead. ChangeList itself is NOT modified — its own test file passes byte-unchanged (that is the reuse proof).
- `index.ts` derives the pill state: `count` from the drafts store (`drafts.onChange` already fires on apply/commit/clear — extend the existing subscription), `applying` = any lifecycle row in sent/applying (the ChangeList/LifecycleSession state the host already reads for the queued-line copy). Push via `feed.setDraftState` on every change tick.
- Pill text: `1 edit drafted` / `N edits drafted` / `applying…` (applying wins while true).

- [ ] **Step 1: failing tests** — `pill hidden at zero drafts`, `setDraftState(2,false) shows '2 edits drafted'`, `applying:true shows 'applying…'`, `pill click toggles disclosure open class`, `draftSlot content (a marker div) is visible only when disclosure open`, design-mode: `changeList.root lives inside .draft-disclosure`, `drafting an edit updates the pill (drafts.onChange → setDraftState wiring)`, panel: append list no longer contains changesSlot.
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement + CSS.**
- [ ] **Step 4–5: verify (changelist.test.ts UNTOUCHED and green) + root gate.**
- [ ] **Step 6: commit** — `feat(client): drafts pill + disclosure hosting ChangeList; Changes section retired`

---

### Task 3 — send-everything verb + conditional watch strip

**Files:**
- Modify: `packages/the-forge/src/client/index.ts`, `packages/the-forge/src/client/watch.ts` (only if indicator gating needs a helper)
- Test: `tests/client/design-mode.test.ts`, `tests/client/watch.test.ts` (adjust)

**Contract:**
- `feed.onSend` host verb: (1) if drafts exist → run the EXISTING send-to-agent flow verbatim (the current 'Send to agent' click handler body: queue POST → dispatch → lifecycle rows — extract it to a private method, do not duplicate); (2) then if `feed.getText().trim()` → the existing say flow (chip element attached, clearText + chip clear only on ok, 429/failure rows unchanged from milestone B). Both present → drafts first (server nudge-before-FIFO answers after edits apply). The old standalone overlay 'Send to agent' button: DELETE it and its flash copy path — the composer is now the single send surface (grep `'Send to agent'` → only historical strings in docs).
- Watch strip: render/attach the indicator element only when `watch.current()` is a linked-terminal state; embedded-session states no longer produce a strip (placeholder + pill carry them). `sentLabelFor`/`queuedLineFor` copy that referenced the strip position stays valid where still used.
- `feed.setSessionState` fed from the existing watch poll tick (sessionState) + availability recompute.

- [ ] **Step 1: failing tests** — `onSend with drafts only → queue+dispatch POSTs, no /say`, `text only → /say only`, `both → queue POST then /say (order asserted via fetch-stub call log)`, `say failure preserves text; success clears text+chip`, `'Send to agent' button gone from overlay`, `watch strip present when linked-terminal, absent for embedded/none states`, `poll tick drives setSessionState (placeholder changes)`.
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement.**
- [ ] **Step 4–5: verify + root gate.**
- [ ] **Step 6: commit** — `feat(client): send-everything composer verb; watch strip only when linked`

---

### Task 4 — feed divider + taller chat default

**Files:**
- Modify: `packages/the-forge/src/client/panel.ts`, `packages/the-forge/src/client/overlay.ts` (CSS)
- Test: `tests/client/panel.test.ts` (extend)

**Interfaces produced:**

```ts
// panel.ts
//  - feedDivider: HTMLElement                 // .feed-divider, appended between body and feedSlot
//  - static FEED_SPLIT_KEY = 'the-forge:feed-split'   // sessionStorage key
//  - feedSplit(): number                      // current feed height px (clamped)
```

**Contract:**
- `.feed-divider` sits between `body` (properties scroll area) and `feedSlot` in the append order. pointerdown arms document-level pointermove/pointerup (capture; disarmed on up — zero idle listeners); drag sets the feed area's flex-basis px, clamped ≥120px each side (against current panel height); double-click resets to the default split; value saved to sessionStorage under `FEED_SPLIT_KEY` on pointerup and restored on construction (invalid/absent → default). Default split gives chat ~45% of panel height (taller than today).
- jsdom can't do real layout: tests drive pointer events and assert style/flex-basis math + clamping + persistence calls (inject a fake Storage like lifecycle-store tests do), not rendered pixels.

- [ ] **Step 1: failing tests** — `divider element present between body and feed`, `drag updates feed flex-basis`, `clamps at 120px both ends`, `double-click resets`, `persists on pointerup and restores on construct (fake Storage)`, `no document listeners before pointerdown / none after pointerup (addEventListener spy — idle-zero)`.
- [ ] **Step 2: verify failure.**
- [ ] **Step 3: implement + CSS (visible grab affordance on hover).**
- [ ] **Step 4–5: verify + root gate.**
- [ ] **Step 6: commit** — `feat(client): draggable feed divider, taller chat default`

---

### Task 5 — stories, fake-E2E hooks, docs, gates, browser pass

**Files:**
- Modify: `packages/the-forge/stories/session-feed.stories.ts`, `scripts/e2e-embedded-feed.sh`, `CLAUDE.md`
- Test: script + visual verification (fix-forward commits)

- [ ] **Step 1: stories** — composer states: ready, busy-morphed (■), drafts pill (2 drafted), disclosure open with change rows, disabled reason.
- [ ] **Step 2: fake E2E** — extend assertions: `.chat-composer` present in served client bundle markup? (the script asserts via the HTTP stream, not DOM — instead assert the say round-trip still passes unchanged AND grep dist/client.js for the new class hooks as a build sanity: `chat-composer`, `draft-pill`, `feed-divider`). Keep ALL CHECKS PASSED.
- [ ] **Step 3: docs** — CLAUDE.md module rows: session-feed.ts description gains "composer (send-everything verb, drafts pill)", panel.ts gains "feed divider"; changelist.ts row notes it renders inside the composer's draft disclosure. One gotcha line: "the Changes list lives INSIDE the composer's draft disclosure since 2026-07-09 — .changes-section hooks unchanged, just reparented."
- [ ] **Step 4: gates** — root `npm test`; `./scripts/e2e-embedded-feed.sh` (kill stale 5173); `./scripts/check-prod-clean.sh` — report measured KB (must be ≤320; expect ~net-neutral).
- [ ] **Step 5: real-browser pass** — demo app: composer renders, morph works during a real turn (fake scenario fine via PATH trick if avoiding live turns), pill appears on draft + disclosure shows rows + send-both applies edit then answers, divider drags and persists across panel close/open, watch strip absent with no linked terminal. Screenshots into the report. Fix-forward commits for anything visual (spacing/z-index/scroll anchoring).
- [ ] **Step 6: commit** — `feat(client): composer stories, E2E hooks, docs (composer consolidation)`

---

## Self-review notes

- Spec §1 decisions → Tasks 1 (composer/morph/placeholder), 2 (pill/disclosure), 3 (send verb/watch strip), 4 (divider); §2 structure map → Tasks 1/2/4; §3 behavior contract lines each named in a task's Step 1; §4 constraints in Global; §5 testing → per-task Step 1 + Task 5; §6 exclusions honored (no server files touched anywhere).
- Type consistency: `onSend`/`getText`/`clearText`/`setSessionState` (Task 1) consumed in Task 3; `draftSlot`/`setDraftState` (Task 2) consumed in Tasks 2/3; `FEED_SPLIT_KEY`/`feedSplit` self-contained in Task 4.
- The one cross-file risk (design-mode suite breaking mid-sequence) is handled explicitly: Task 1 Step 4 wires onSend to the old text-only verb as a shim, Task 3 replaces it.

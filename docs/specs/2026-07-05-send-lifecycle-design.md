# Send lifecycle: visible draft → applying → done, and a panel that never vanishes

**Date:** 2026-07-05
**Status:** Approved design (brainstormed with user; see approval trail in session)

## Problem

Hitting **Send to agent** in a real consumer project (the user's portfolio: Vite 8 + React 19 +
Tailwind v4) makes the design panel disappear instantly. Beyond the bug, the send lifecycle has a
trust gap: the only feedback is a one-line gray status string ("2 queued — …"), per-change
progress is invisible, and agent failures — including `failed` items with
`needs confirmation: <why>` notes — are never surfaced. The user asked for: the panel must not
close on Send, and the **drafted → applying → done** stages must be easy to see and trust.

## Root cause (reproduced and verified 2026-07-05)

The panel never "closes" — the **page fully reloads** on Send:

1. Send POSTs `/__the-forge/queue`; the server writes the change request into
   `.the-forge/queue.json` at the resolved project root.
2. The consumer project's `.gitignore` has no `.the-forge/` entry — the plugin never writes one.
   (The Forge's own repo gitignores it manually, which is why fixtures never reproduced this.)
3. Tailwind v4's Vite plugin scans every non-gitignored file for class candidates. Change-request
   markdown is *made of* Tailwind class names, so `queue.json` enters the scan set — after which
   **any write to it triggers a full page reload**.
4. The reload wipes all in-memory overlay state: design mode off, panel gone, drafts gone,
   sent-status tracking gone. This also explains why the existing queued/applying/implemented
   states were never seen.

Evidence: in the portfolio project, `printf '\n' >> .the-forge/queue.json` alone (no Send, no
agent) reloads the page; a plain-text file written at the root does not; after adding
`.the-forge/` to `.gitignore` and restarting, queue writes no longer reload. The Next fixture
(App Router + Turbopack) never reloads — panel, selection, and drafts survive Send, agent apply,
and Fast Refresh with current code.

## Design overview

Three layers, one milestone:

1. **Fix layer** — stop `.the-forge/` writes from ever entering a consumer's watch/scan set.
2. **Lifecycle model** — the verifier emits structured per-element-change stage events instead of
   a single summary string.
3. **Changes list UI + reload resilience** — a per-change list in the panel driven by those
   events, with lifecycle state persisted in `sessionStorage` so even legitimate full reloads
   don't destroy it.

---

## 1. Fix layer

Both changes ride the existing idempotent install-side-effects path, so Vite and Next consumers
get them automatically.

### 1a. Gitignore entry at install (load-bearing fix)

`setupProjectConfig()` (`src/server/setup.ts`) gains `ensureGitignoreEntry(root)`:

- Appends to the git root's `.gitignore` (creating the file if absent):

  ```
  # The Forge runtime state (dev-only)
  .the-forge/
  ```

- Idempotent: skipped if any existing line already covers the directory (`.the-forge/`,
  `.the-forge`, `**/.the-forge/`, or `.the-forge/**` after trimming). No rewriting of user
  content, append-only, trailing-newline safe.
- Same I/O conventions as the other install side-effects: never crash the dev server on a
  read-only FS or permissions error — warn once and continue.
- Runs from both the Vite plugin and the Next sidecar (both already call `setupProjectConfig`).
- Rationale: Tailwind v4's scanner respects `.gitignore`; this removes `queue.json` (and endpoint
  files) from its candidate set. It also keeps runtime state out of the consumer's VCS — which
  was always the documented intent ("`.the-forge/` is gitignored runtime state") but was never
  enforced for consumers.

### 1b. Watcher exclusion (belt-and-braces)

- **Vite:** the plugin's `config()` hook merges `server.watch.ignored: ['**/.the-forge/**']`
  (additive — never clobbers user-supplied ignores; Vite deep-merges returned partial configs,
  arrays concatenated by our merge helper if needed).
- **Next / webpack:** append the same glob to `config.watchOptions.ignored` in the existing
  webpack hook (preserving existing string/array/RegExp forms).
- **Next / Turbopack:** no user-facing watch-ignore knob exists; the gitignore entry covers the
  Tailwind scan there, and the Turbopack fixture E2E confirmed queue writes don't trigger
  reloads. Accepted-untested beyond that, same YAGNI posture as the `turbopack.rules` gotcha.

## 2. Lifecycle model

One state machine per **element-change** — an element within a sent request. This matches the
granularity `SentRegistry` mappings and the verifier already track.

```
draft ──send──▶ sent ──claimed──▶ applying ──marked applied──▶ verifying ──▶ done ✓
                 │                    │                            ├──▶ mismatch ⚠  (computed ≠ expected; draft kept)
                 │                    │                            └──▶ unverified   (element not found post-refresh)
                 └────────────────────┴──marked failed──▶ failed ✗  (note surfaced verbatim)
```

Transition sources:

- `draft`: `DraftStore.onChange` (exists today).
- `draft → sent`: the Send click handler's existing `SentRegistry.add(id, mapping)`.
- `sent → applying → …`: the verifier's existing 2s `/status` poll. The server already reports
  `pending` / `claimed` / `applied` / `failed` per item; `claimed` maps to **applying**.
- `applying → sent` regression is legitimate (server re-queues stale claims after 5 min); the
  list simply reflects it.

### Verifier refactor (`src/client/verifier.ts`)

- Today the verifier reduces everything to one summary string. It instead emits **structured
  stage events**: `{ requestId, dcSource, stage, note?, expected?, actual? }` per element-change,
  plus the existing aggregate summary derived from the same data.
- The status strip's summary line and all existing commit/mismatch/unverified semantics —
  the most battle-tested logic in the client — are behavior-preserved: `renderSummary` stays,
  existing tests keep passing, drafts are still committed only when **all** of an element's
  changes verify.
- New consumers subscribe via a callback list on the verifier (same pattern as
  `drafts.onChange`), keeping it dependency-free.

## 3. Changes list UI

New module `src/client/changelist.ts` (+ CSS in `overlay.ts`'s design-system string). A
**Changes** section pinned between the property sections and the panel footer/status strip.
Hidden entirely when empty — zero footprint until the first edit.

- **Row = element-change, newest first:**
  `[stage chip] h1 · Header.tsx:105   pt-2 → pt-9`
  - Stage chip: colored dot + label. Draft = neutral dashed outline; Sent = gray; Applying =
    amber `#E2954A` with subtle pulse; Done = green `#62C073` ✓; Mismatch = amber ⚠;
    Failed = red ✗. Colors reuse the existing overlay design system.
  - Element identity: tag + short source (`file.tsx:line`), from the `data-dc-source` mapping.
  - Change summary in token vocabulary from the request builder (`pt-2 → pt-9`); multiple
    properties collapse to "3 edits", expandable to one line per property.
- **Interactions:**
  - Hover row → flash the element's outline on canvas (reuses existing outline plumbing).
  - Click row → select the element (drives `panel.show` through the normal selection path).
  - **Failed rows pin**: full note wrapped beneath the row (e.g. `needs confirmation: the h2 at
    About.tsx:112 is one call site…`), with **Re-send** (re-queues that element's changes as a
    fresh request — safe and unfiltered: a failed apply changed no source, and failed items have
    already left the sent-but-unverified set the duplicate filter checks) and **Dismiss**.
  - **Done rows linger** as compact one-line receipts for the session; a **Clear done** action
    sits in the section header. Nothing auto-disappears.
  - **Mismatch rows** expand to show expected vs actual computed values; the draft stays applied
    so nothing visually regresses.
- The status strip keeps its aggregate one-liner + watcher indicator: glanceable summary up top,
  full story in the list.
- All new class names are test hooks — extend, don't rename.
- Panel-pattern conventions (stable section order, Mixed-not-blank, spacing rows) are unaffected;
  the Changes section is additive at the bottom.

## 4. Reload resilience

Even with the fix layer, some frameworks legitimately full-reload (non-HMR-able edits, server
component boundaries). Lifecycle state must survive.

- **Storage:** `sessionStorage` key `the-forge:lifecycle` — tab-scoped, dies with the tab.
  Written only on state changes while design mode is on (zero idle cost preserved; nothing runs
  on ordinary page loads with design mode off).
- **Persisted shape** (versioned, `unknown` + manual checks at the I/O boundary, no schema libs):
  - `SentRegistry` mappings: request id + per-element `dcSource`, draft props, change list.
  - Un-sent drafts: `dcSource → { prop: cssValue }`.
  - `designModeOn: boolean` and the selected elements' `dcSource`s.
- **Restore on client boot:** if `designModeOn` was true — reactivate design mode, restore the
  registry, re-arm the verifier (element re-location by `data-dc-source` is the same mechanism it
  already uses post-HMR), re-apply draft inline styles to re-located elements, re-select. The
  panel comes back where it was: "the panel never disappears" holds even across real reloads.
- Elements that can't be re-located render their row greyed with "element not found" rather than
  silently dropping (the row's send/verify tracking continues server-side regardless).
- Corrupt or absent storage: try/catch, start clean — same convention as `loadPrefs()`.

## 5. Edge cases

- **Dev server restarted / unreachable:** verifier keeps its existing backoff (2s → 30s); rows
  hold their last known stage; the strip keeps the existing server-gone hint.
- **Duplicate send:** unchanged filter, now visible — the row simply stays `sent`.
- **Multi-select bundles:** one request, N element rows; each row advances independently
  (per-element verification already works this way).
- **Two dev servers on one project:** unchanged semantics (newest live endpoint wins for the MCP
  bin); the list reflects whatever server the browser is talking to.
- **Queue corruption:** already quarantined server-side; unchanged.

## 6. Testing

- **Unit (jsdom), mirroring `src/`:**
  - `tests/client/changelist.test.ts` — row rendering, stage transitions, failed-pin/re-send/
    dismiss/clear-done, empty-state hiding.
  - Verifier structured-event tests alongside the existing suite; existing summary/commit/
    mismatch tests must pass unchanged.
  - `tests/server/setup.test.ts` additions — `ensureGitignoreEntry` idempotency: no `.gitignore`,
    existing entry (all four covering forms), existing unrelated content, read-only FS warning
    path.
  - Vite `config()` watch-ignore merge (fresh config, user-supplied ignores preserved); webpack
    `watchOptions.ignored` append for string/array forms.
  - sessionStorage round-trip, versioning, corruption fallback.
- **Real-browser E2E before merge** (jsdom cannot see layout or computed styles):
  - Demo-app loop: edit → send → simulated agent apply → row reaches Done ✓; failed item's note
    renders; panel and list survive the whole pass.
  - **Regression for the root cause:** a Vite + Tailwind v4 fixture *without* a pre-seeded
    gitignore entry — first `theForge()` boot writes the entry; a send must not reload the page.
  - Next fixture smoke: sidecar writes the same gitignore entry; loop unchanged.

## Constraints honored

Zero new runtime dependencies; zero production footprint (all changes live in serve-mode client/
server code); zero idle overhead (list renders only when non-empty, storage writes only during
active design-mode state changes); deterministic token-first change requests unchanged; the MCP
contract and queue lifecycle are untouched (no server surface changes).

## Out of scope

On-canvas per-element status badges (user chose the panel list); server-backed history via an
extended `/status` (rejected: splits the list across two sources of truth); multi-tab
consistency; any change to dispatch or watch-mode behavior.

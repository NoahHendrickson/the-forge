# Lifecycle single-owner refactor (PR #7 review response)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Address all four blockers from Cursor's PR #7 review: collapse the three parallel sent-state stores into one owner, make `lifecycle-store` the canonical element resolver, extract the shared Send/Re-send ladder, and move persisted-state validation fully to the I/O boundary.

**Architecture:** New `src/client/lifecycle.ts` exports `LifecycleSession` — the single source of truth for in-flight sends: it owns the seed payloads (now carrying per-element `index` and `stage`), satisfies the verifier's registry dependency structurally, projects to/from persisted state, and is the only mutator the ChangeList renders from. `SentRegistry` is absorbed and deleted; `DesignMode` shrinks back to an orchestrator with one `registerQueuedSend` path shared by Send and Re-send.

**Behavior freeze:** ALL existing behavior contracts hold — verifier summary/commit semantics, ChangeList CSS class hooks and interaction contract, persistence round-trip, zero deps / zero prod footprint / zero idle overhead. Existing tests keep passing modulo import updates and the `sent.test.ts` port described in R2. The real-browser E2E loop must be re-run before push.

## Global Constraints

Same as docs/plans/2026-07-05-send-lifecycle.md Global Constraints (binding), plus: no `@modelcontextprotocol` or schema libs; `unknown` + manual checks at I/O boundaries; why-comments preserved verbatim when code moves ("never trim as verbose").

---

### Task R1: Foundations — canonical resolver, per-seed index, boundary validation

**Files:** Modify `src/client/lifecycle-store.ts`, `src/client/verifier.ts`, `src/client/changelist.ts` (SentSeed gains `index`), `src/client/index.ts` (seed construction), tests mirroring each.

**Contract:**
- `lifecycle-store.ts` adds the ONE canonical resolver used everywhere a disconnected element must be re-found:
  `resolveElement(el: TaggedElement | null, dcSource: string | null, index: number, doc = document): TaggedElement | null` — connected `el` wins; else `locateBySource(dcSource, index)` (escaped selector, index-then-first-match); else null.
- `SentSeed` gains `index: number` (position among `querySelectorAll` matches at send time, via `sourceIndex`). Seed construction in `onSendOk`/`resend`/`restoreLifecycle` populates it; `persist()` reads it instead of recomputing; `healPlaceholders` uses `seed.index` instead of the hardcoded 0 (delete the index-0 trade-off comment — the trade-off no longer exists).
- `verifier.locate()` becomes a thin delegate to `resolveElement` (entry elements carry `index`, default 0 for legacy callers). Existing verifier tests unchanged.
- `loadLifecycle` validates per ITEM (drafts, selection, sent elements: required fields with correct primitive types, `change` an object with `changes` array) and DROPS invalid items instead of failing the whole state. `boot()`'s try/catch stays as defense-in-depth with its comment updated to say so (no longer load-bearing).

**Test sketch:** resolver precedence (connected el / index match / first-match fallback / null); healing attaches the SECOND list instance when `index: 1` (the wrong-instance bug); loadLifecycle drops a corrupt `sent[0]` but keeps a valid `sent[1]` and valid drafts; persist→restore round-trip preserves indexes.

- [ ] Tests red → implement → `npx vitest run tests/client/` green → typecheck → commit `refactor(client): canonical element resolver, per-seed index, boundary-validated persistence`

### Task R2: LifecycleSession — single sent-state owner

**Files:** Create `src/client/lifecycle.ts` + `tests/client/lifecycle.test.ts`; modify `src/client/changelist.ts` (sent rows render from the session; row-local UI state only), `src/client/index.ts` (DesignMode holds one session; `sentSeeds` map deleted; `registerQueuedSend` + shared queue/dispatch helper), `src/client/verifier.ts` (constructor accepts the structural `SentStore` interface), delete `SentRegistry` class from `src/client/sent.ts` (keep `SentChange`/`SentEntry` types); port `tests/client/sent.test.ts` behaviors into the lifecycle suite.

**Contract:**
- `LifecycleSession` owns `Map<requestId, { seeds: SentSeed[] }>` where each seed carries `stage: LifecycleStage`, `note?`, `mismatches?` alongside payload. Single source of truth for verification, UI rows, and persistence projection.
- Implements the verifier's dependency structurally: `pendingIds()`, `get(id)`, `take(id)`, `size()` returning `SentEntry`-shaped views derived from seeds (changes derived from `seed.change.changes`); `isDuplicate(el, changes)` keeps the current semantics including the dcSource-fallback-for-disconnected-entries behavior (tests ported verbatim from sent.test.ts).
- API: `register(id, seeds)`, `applyStage(e: StageEvent): boolean` (moves from ChangeList; same idempotency/terminal rules), `removeSeed(seed)`, `clearResolved()` (Clear done), `healPlaceholders()` (moves from ChangeList, uses resolver + seed.index), `toPersistedSent()`, `restoreSent(persisted)`, `clear()`, `onChange` callback.
- `ChangeList` becomes a view over `(drafts, session)`: renders sent rows from session state; keeps ALL CSS class hooks, row anatomy, and the Task-8 interaction contract (hover/select/dismiss/re-send/clear-done tests pass with only import/constructor adaptations — assertions unchanged).
- `DesignMode`: one `private session: LifecycleSession`; `registerQueuedSend(id, seeds)` = session.register → verifier.start → persist (single path used by `onSendOk` AND `resend`); one shared `postQueue(request): Promise<id>` + fire-and-forget dispatch helper; `pairsToSeeds(pairs)` single construction point (the `mapping`/`seeds` dual-build collapses).
- Verifier constructor param type: `SentStore` structural interface (same five methods) — `LifecycleSession` passed in production; existing verifier tests keep constructing the same shapes (update their imports to build a `LifecycleSession` or a minimal literal — assertions unchanged).

**Test sketch (lifecycle.test.ts):** register→rows/pendingIds/persisted projection agree from ONE mutation; applyStage flips stage exactly once (idempotent, terminal-guard) and the projection reflects it; take() removes from all views atomically; ported isDuplicate trio; restore round-trip incl. placeholder + heal-by-index; clear() empties everything.

- [ ] Tests red → implement → full `npx vitest run tests/client/` + root `npm test` green → typecheck → commit `refactor(client): LifecycleSession single sent-state owner; Send/Re-send share one ladder`

### Task R3: Gate, browser E2E re-run, PR response

- [ ] Root `npm test`, `npm run build`, `./scripts/check-prod-clean.sh` (≤250KB) green
- [ ] Real-browser E2E re-run on demo-app: draft→sent→applying→done ✓; failed pin + Re-send; mid-flight reload restore (selection + draft + sent row); list-instance healing sanity
- [ ] Push; reply to the Cursor review point-by-point (what changed per blocker, commit refs); re-request review
- [ ] CLAUDE.md: module table gains `lifecycle.ts`; `sent.ts` row updated (types only)

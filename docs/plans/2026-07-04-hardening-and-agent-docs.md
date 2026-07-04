# Hardening + Agent Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the accepted findings from the 2026-07-04 project review: queue corruption recovery, verifier polling backoff, a package-size gate, the Stage-1 panel.ts extraction, and a root `CLAUDE.md` (+ HANDOFF slim-down, MCP contract doc).

**Architecture:** Four small independent code changes (disjoint files) plus one docs task. No new dependencies, no behavior changes beyond the two hardening fixes. panel.ts extraction is a verbatim move with re-exports so `tests/client/panel.test.ts` (the behavioral lock) is untouched.

**Tech Stack:** TypeScript (strict), vitest, bash, npm workspaces.

## Global Constraints

- Zero new runtime dependencies (`@babel/parser` + `magic-string` only, forever).
- Panel CSS class names are test hooks — never rename.
- Why-comments are load-bearing — preserve on any moved code, verbatim.
- `tests/client/panel.test.ts` must show zero diff in Task 4.
- All paths below relative to repo root; plugin source lives at `packages/vite-plugin/`.
- Work on branch `hardening-and-agent-docs`; do NOT merge to main (user decides).
- Each task's agent leaves changes uncommitted unless the task says commit (controller commits after review).

---

### Task 1: Queue corrupt-file quarantine

**Files:**
- Modify: `packages/vite-plugin/src/server/queue.ts` (constructor lines 65-77, `mergeWithDisk` lines 177-188)
- Test: `packages/vite-plugin/tests/server/queue.test.ts`

**Interfaces:**
- Produces: private method `readDiskItems(): QueueItem[]` used by both the constructor and `mergeWithDisk()`. No public API change.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe('Queue', ...)`; the file already has `dir` mkdtemp'd in `beforeEach` and imports `fs`, `path`, `Queue`)

```ts
it('quarantines a corrupt queue.json (renamed with timestamp) instead of silently discarding it', () => {
  fs.writeFileSync(path.join(dir, 'queue.json'), '{definitely not json')
  const q = new Queue(dir, () => 1751600000000)
  expect(q.list()).toEqual([])
  const corrupt = path.join(dir, 'queue.json.corrupt-1751600000000')
  expect(fs.existsSync(corrupt)).toBe(true)
  expect(fs.readFileSync(corrupt, 'utf8')).toBe('{definitely not json')
  expect(fs.existsSync(path.join(dir, 'queue.json'))).toBe(false)
})

it('treats parseable-but-non-array queue.json as corrupt (quarantined, not silently ignored)', () => {
  fs.writeFileSync(path.join(dir, 'queue.json'), '{"items": []}')
  const q = new Queue(dir, () => 1751600000000)
  expect(q.list()).toEqual([])
  expect(fs.existsSync(path.join(dir, 'queue.json.corrupt-1751600000000'))).toBe(true)
})

it('quarantines a file that becomes corrupt mid-session on the next persist (mergeWithDisk path)', () => {
  const q = new Queue(dir)
  q.add({}, 'a')
  fs.writeFileSync(path.join(dir, 'queue.json'), 'garbage-written-by-something-else')
  q.add({}, 'b')
  const names = fs.readdirSync(dir)
  expect(names.some((n) => /^queue\.json\.corrupt-\d+$/.test(n))).toBe(true)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'))
  expect(onDisk).toHaveLength(2)
})

it('a missing queue.json is NOT corruption — no quarantine file appears', () => {
  const q = new Queue(dir)
  expect(q.list()).toEqual([])
  expect(fs.readdirSync(dir).filter((n) => n.includes('corrupt'))).toEqual([])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/server/queue.test.ts` (from `packages/vite-plugin/`)
Expected: the 3 new quarantine tests FAIL (no corrupt-* file exists); missing-file test passes.

- [ ] **Step 3: Implement.** Replace the constructor's try/catch read and `mergeWithDisk`'s duplicate with one helper:

```ts
constructor(
  private dir: string,
  now: () => number = () => Date.now()
) {
  this.now = now
  this.file = path.join(dir, 'queue.json')
  this.items = this.readDiskItems()
}

/**
 * Reads queue.json, returning [] when the file doesn't exist (normal first run). A file that
 * exists but doesn't parse to an array is QUARANTINED — renamed to queue.json.corrupt-<ms> —
 * rather than silently discarded: it may hold pending user edits worth hand-recovering, and
 * leaving it in place would let the next persist() clobber the evidence.
 */
private readDiskItems(): QueueItem[] {
  let raw: string
  try {
    raw = fs.readFileSync(this.file, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as QueueItem[]
  } catch {
    // fall through to quarantine
  }
  const corruptPath = `${this.file}.corrupt-${this.now()}`
  try {
    fs.renameSync(this.file, corruptPath)
    console.warn(`[the-forge] queue.json was unreadable — moved to ${corruptPath}; starting with an empty queue`)
  } catch {
    // rename failed (permissions?) — leave the file for inspection; nothing else we can do
  }
  return []
}
```

In `mergeWithDisk()`, replace the whole try/catch that computes `onDisk` with:

```ts
const onDisk = this.readDiskItems()
```

(Keep the rest of `mergeWithDisk` — knownIds filter — unchanged.)

- [ ] **Step 4: Run full queue suite** — `npx vitest run tests/server/queue.test.ts` → all PASS. Then `npm run typecheck -w @the-forge/vite`.

---

### Task 2: Verifier polling backoff

**Files:**
- Modify: `packages/vite-plugin/src/client/verifier.ts` (timer fields + `start`/`stop`/`poll`, lines 116-171)
- Test: `packages/vite-plugin/tests/client/verifier.test.ts`

**Interfaces:**
- Public API unchanged (`start()`, `stop()`, constructor). New exported consts `PAUSE_AFTER_FAILURES = 5` and `MAX_POLL_MS = 30_000` for tests.
- Timer model changes from `setInterval` to chained `setTimeout` (required so the delay can change between polls). Existing tests drive time with `await vi.advanceTimersByTimeAsync(...)`, which flushes microtasks between timers — chained scheduling stays compatible; do not edit existing tests.

- [ ] **Step 1: Write the failing tests** (append to the existing Verifier polling describe block; follow the file's existing fixture style — `SentRegistry`, `DraftStore`, `vi.stubGlobal('fetch', fetchMock)`, fake timers already on in `beforeEach`). Look at the existing "polls /status" test for how a `SentEntry` is registered; reuse that helper/shape exactly.

```ts
it('backs off after 5 consecutive failed polls and surfaces a paused message', async () => {
  const registry = new SentRegistry()
  const d = el()
  registry.add({ id: 'q1', elements: [{ el: d, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }] })
  const updates: string[] = []
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'))
  vi.stubGlobal('fetch', fetchMock)
  const verifier = new Verifier(registry, new DraftStore(), (s) => updates.push(s))
  verifier.start()

  // failures 1-4: silent retries at the base 2s cadence, no paused message
  await vi.advanceTimersByTimeAsync(8000)
  expect(fetchMock).toHaveBeenCalledTimes(4)
  expect(updates).toEqual([])

  // failure 5: paused message surfaces, delay doubles to 4s
  await vi.advanceTimersByTimeAsync(2000)
  expect(fetchMock).toHaveBeenCalledTimes(5)
  expect(updates).toEqual(['verification paused — dev server unreachable'])

  // only 2s later: nothing (backoff in effect) …
  await vi.advanceTimersByTimeAsync(2000)
  expect(fetchMock).toHaveBeenCalledTimes(5)
  // … but at 4s the next (6th) poll fires and the delay doubles again to 8s
  await vi.advanceTimersByTimeAsync(2000)
  expect(fetchMock).toHaveBeenCalledTimes(6)
})

it('a successful poll resets the failure counter and restores the 2s cadence', async () => {
  const registry = new SentRegistry()
  const d = el()
  registry.add({ id: 'q1', elements: [{ el: d, dcSource: null, draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }] })
  const updates: string[] = []
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('down'))
    .mockRejectedValueOnce(new TypeError('down'))
    .mockRejectedValueOnce(new TypeError('down'))
    .mockRejectedValueOnce(new TypeError('down'))
    .mockRejectedValueOnce(new TypeError('down'))
    .mockResolvedValue({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }) })
  vi.stubGlobal('fetch', fetchMock)
  const verifier = new Verifier(registry, new DraftStore(), (s) => updates.push(s))
  verifier.start()

  await vi.advanceTimersByTimeAsync(10_000) // 5 failures → paused, delay 4s
  expect(updates).toContain('verification paused — dev server unreachable')
  await vi.advanceTimersByTimeAsync(4000) // 6th poll succeeds → reset
  const afterSuccess = fetchMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(2000) // base cadence restored
  expect(fetchMock.mock.calls.length).toBe(afterSuccess + 1)
})
```

(If `registry.add(...)`'s real signature differs from this sketch, match the existing tests in the file — the shape above mirrors the `SentEntry` fixtures already used there.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/client/verifier.test.ts` → new tests FAIL (no backoff exists; paused message never emitted).

- [ ] **Step 3: Implement** in `verifier.ts`:

```ts
const POLL_MS = 2000
/** After this many consecutive failed polls the verifier surfaces "paused" and starts backing off. */
export const PAUSE_AFTER_FAILURES = 5
/** Backoff ceiling — a dead dev server costs one request per 30s, not one per 2s forever. */
export const MAX_POLL_MS = 30_000
```

Replace the class's timer machinery (keep every line of the `.then(...)` body's existing logic — counters, manual-rung comment block, summary rendering — untouched):

```ts
private timer: ReturnType<typeof setTimeout> | null = null
private consecutiveFailures = 0
private delayMs = POLL_MS

start(): void {
  if (this.timer) return
  if (this.sent.size() === 0) return
  this.consecutiveFailures = 0
  this.delayMs = POLL_MS
  this.schedule()
}

stop(): void {
  if (this.timer) clearTimeout(this.timer)
  this.timer = null
}

/** Chained setTimeout instead of setInterval so the delay can stretch under backoff. */
private schedule(): void {
  this.timer = setTimeout(() => this.poll(), this.delayMs)
}

private poll(): void {
  const ids = this.sent.pendingIds()
  if (ids.length === 0) {
    this.stop()
    return
  }
  fetch(`/__the-forge/status?ids=${ids.join(',')}`)
    .then((res) => (res.ok ? res.json() : { items: [] }))
    .then((body: { items: Array<{ id: string; status: string; note: string | null }> }) => {
      this.consecutiveFailures = 0
      this.delayMs = POLL_MS
      // ... existing body EXACTLY as-is (handleApplied/handleFailed loop, claimed/pendingManual
      // computation with its manual-rung comment, stop-on-empty, onUpdate(renderSummary(...))) ...
    })
    .catch(() => {
      // Transient blips retry silently at the base cadence; a RUN of failures means the dev
      // server is gone — say so instead of freezing on a stale "applying…" line, and back off
      // so a dead server costs one request per MAX_POLL_MS, not one per 2s forever.
      this.consecutiveFailures++
      if (this.consecutiveFailures >= PAUSE_AFTER_FAILURES) {
        this.delayMs = Math.min(this.delayMs * 2, MAX_POLL_MS)
        this.onUpdate('verification paused — dev server unreachable')
      }
    })
    .finally(() => {
      // stop() (external, or stop-on-empty inside the then-branch) nulls the timer — only
      // chain the next poll if nobody stopped us while this one was in flight.
      if (this.timer !== null) this.schedule()
    })
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/client/verifier.test.ts` → ALL pass (old + new). Then typecheck.

---

### Task 3: Package-size gate in check-prod-clean.sh

**Files:**
- Modify: `scripts/check-prod-clean.sh`

- [ ] **Step 1: Append before the final `echo "PASS..."` line** (builds have already run above it):

```bash
# Package-size gate: the npm package ("files": ["dist"]) is the product's headline lightweight
# guarantee. Budget sits ~40% above today's ~180KB unpacked so only real regressions trip it.
MAX_UNPACKED_KB=250
PACK_JSON=$(npm pack --dry-run --json -w @the-forge/vite 2>/dev/null)
UNPACKED_KB=$(printf '%s' "$PACK_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(Math.ceil(j[0].unpackedSize/1024))})')
if [ "$UNPACKED_KB" -gt "$MAX_UNPACKED_KB" ]; then
  echo "FAIL: @the-forge/vite unpacked package is ${UNPACKED_KB}KB — exceeds the ${MAX_UNPACKED_KB}KB budget" >&2
  exit 1
fi
echo "PASS: package size ${UNPACKED_KB}KB (budget ${MAX_UNPACKED_KB}KB)"
```

- [ ] **Step 2: Verify both directions.** Run `./scripts/check-prod-clean.sh` → ends with both PASS lines. Then rerun with `MAX_UNPACKED_KB=1` temporarily (edit or `sed`) → FAIL line + exit 1. Restore 250.

---

### Task 4: panel.ts Stage-1 extraction (specs + readers)

**Files:**
- Create: `packages/vite-plugin/src/client/panel-specs.ts`
- Create: `packages/vite-plugin/src/client/panel-readers.ts`
- Modify: `packages/vite-plugin/src/client/panel.ts` (delete moved lines 19-351 minus what stays; add imports + re-exports)
- Test: NONE modified — `tests/client/panel.test.ts` must show zero diff.

**Interfaces:**
- `panel-readers.ts` exports (moved VERBATIM, comments included, from panel.ts): `px`, `fromPx` (53-54), `effectiveBackground` (147-162), `isFlex` (164-167), `normalizeJustify` (169-179), `normalizeAlign` (181-191), `hasDirectText` (193-196), `snapWeight` (210-218), `firstFamily` (220-224), `cssFamilyValue` (226-229), `documentFontFamilies` (231-241), `mainAxisProp` (348-351). Imports: `TaggedElement` from `./source`, `DraftStore` from `./drafts`, `parseColor as parseColorLocal` from `./tokens`. Export every moved name.
- `panel-specs.ts` exports (moved VERBATIM): `RowSpec`, `SectionSpec` interfaces (19-51), `RADIUS`, `BORDER_WIDTH_PROPS`, `BORDER_STYLE_PROPS`, `BORDER_COLOR_PROPS` (56-60), `GAP_SPEC` (62-66), `SPACING_SCALE` (68-75), `MULTI_PROP_SYNTHETIC` (77-91, may stay module-private), `utilityPrefixFor` (93-98), `RADIUS_PROP_SET` (100, may stay private), `tokenEntriesFor` (102-125), `styleForWidthProp` (127-130), `draftSolidIfNone` (132-145), `WEIGHTS` (198-208), `SECTIONS` (243-335). Imports: `TaggedElement` from `./source`, `DraftStore` from `./drafts`, `UTILITY_PREFIXES, type Theme, type Tokens` from `./tokens`, `type TokenEntry` from `./tokenpicker`, `hasDirectText` from `./panel-readers` (used by the Typography section's `visible`).
- STAYS in panel.ts: `BoundField`, `BoundSizeMode` interfaces (class bookkeeping) and the `Panel` class itself. `pillLabelFor` is a private method (line 1545) — it does NOT move (the review doc mis-listed it as module-level).
- panel.ts re-export block (the four names `panel.test.ts` imports):

```ts
export { tokenEntriesFor } from './panel-specs'
export { normalizeJustify, normalizeAlign, hasDirectText } from './panel-readers'
```

- [ ] **Step 1:** Create the two new files with the moved code verbatim (every comment intact). Dependency direction: readers ← specs ← panel; no cycles (readers imports nothing from specs).
- [ ] **Step 2:** In panel.ts delete the moved code, add `import { ... } from './panel-specs'` / `'./panel-readers'` for exactly the names the class body still references (typecheck will enumerate them — expect at minimum: `RowSpec`, `SectionSpec`, `SECTIONS`, `GAP_SPEC`, `BORDER_STYLE_PROPS`, `BORDER_COLOR_PROPS`, `tokenEntriesFor`, `utilityPrefixFor`, `px`, `fromPx`, `isFlex`, `normalizeJustify`, `normalizeAlign`, `hasDirectText`, `effectiveBackground`, `WEIGHTS`, `snapWeight`, `firstFamily`, `cssFamilyValue`, `documentFontFamilies`, `mainAxisProp`), plus the re-export block above.
- [ ] **Step 3:** `npm run typecheck -w @the-forge/vite` → clean (fix any missed import; do NOT change logic).
- [ ] **Step 4:** `npm test` (root) → full suite green. `git diff --stat tests/` → empty. `wc -l packages/vite-plugin/src/client/panel.ts` → ~1,350.

---

### Task 5: CLAUDE.md, AGENTS.md, HANDOFF slim-down, README status

**Files:**
- Create: `CLAUDE.md` (root)
- Create: `AGENTS.md` (symlink → CLAUDE.md)
- Modify: `docs/HANDOFF.md` (slim to process/session material)
- Modify: `README.md` (Status section only — M2b-2/M5/Track A shipped)

Content requirements for CLAUDE.md (controller writes this one — judgment-heavy):
1. One-paragraph what/why linking README + spec.
2. Commands block (root build/test, workspace test:watch/typecheck, demo dev, check-prod-clean incl. new size gate; tsup's 3 bundles).
3. Architecture loop map (transform → client drafts → request → queue endpoints → MCP bin → mark → verifier) + one-liner table of `src/client/` modules (verify each one-liner against the file's own header comment — do not guess) including the two new panel-* modules.
4. MCP contract section (P6): 2 tools with exact `mark_applied` arg shape; endpoint discovery (`setup.ts` resolves git root by walking up from vite root, writes `.the-forge/endpoint-<pid>.json` `{port, host, pid, secret}`; `discover.ts` filters live pids, newest mtime wins, legacy `endpoint.json` only when no per-pid files); `X-Forge-Secret` on POST `/pull` + `/mark`; auto-installed `.mcp.json` entry + `.claude/commands/forge-design.md` at git root; queue lifecycle (pending → claimed, 5-min stale-claim re-queue → applied/failed, 24h/200-item pruning); "do NOT replace the hand-rolled JSON-RPC server with the MCP SDK — zero-dependency stdio is a deliberate footprint feature."
5. Hard product constraints (verbatim spirit from HANDOFF §"Hard product constraints").
6. Conventions (dated plans; tests mirror src; class names are test hooks; why-comments load-bearing; SDD workflow pointer to HANDOFF; merge decision belongs to the user).
7. Gotchas (jsdom can't see flex/cascade/computed styles → real-browser E2E before merge; stale dev servers `lsof -iTCP:5173`; IPv6 `[::1]` bind; MCP bin resolves `.the-forge/` from `process.cwd()` → run the agent session at the git root).

HANDOFF.md after slim-down keeps ONLY: updated state line (M1–M5, M2b-1/2, Track A merged; test count via `npm test`), "Read `/CLAUDE.md` first", process conventions §1-6, working agreements. DELETE: read-first doc list (CLAUDE.md owns it), hard constraints (moved), the entire three-tracks overnight section (executed, obsolete — history lives in git).

- [ ] Write CLAUDE.md; `ln -s CLAUDE.md AGENTS.md`.
- [ ] Slim HANDOFF.md; update README Status.
- [ ] Verify: every command listed in CLAUDE.md actually runs; every file path referenced exists.

---

### Final gate (controller)

- [ ] `npm test` green at root; `./scripts/check-prod-clean.sh` passes end-to-end.
- [ ] Code-review pass over the whole branch diff; fix wave if needed.
- [ ] Present branch + summary to user for merge decision (do not merge).

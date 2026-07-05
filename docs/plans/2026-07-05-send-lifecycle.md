# Send Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `.the-forge/` writes from full-reloading consumer apps (the "panel closes on Send" bug), and make the draft → sent → applying → done/failed lifecycle visible per-change in the panel, surviving page reloads.

**Architecture:** Three layers per the approved spec ([docs/specs/2026-07-05-send-lifecycle-design.md](../specs/2026-07-05-send-lifecycle-design.md)): (1) install-time `.gitignore` entry + dev-watcher excludes on both frameworks; (2) the client `Verifier` emits structured per-element-change stage events alongside its existing summary string; (3) a new `ChangeList` panel section renders those events as rows, and a `sessionStorage` lifecycle store restores drafts/sent state/design mode across full reloads.

**Tech Stack:** TypeScript, vitest (jsdom for client tests), zero new runtime dependencies.

## Global Constraints

- Zero new runtime dependencies (`@babel/parser` + `magic-string` only).
- Zero production footprint: all changes live in serve-mode client/server code; `./scripts/check-prod-clean.sh` must stay green, package budget 250KB.
- Zero idle overhead: no listeners/observers/timers until design mode is on. The lifecycle store may do at most ONE synchronous `sessionStorage` read at client boot.
- `unknown` + manual checks at I/O boundaries — no schema libraries.
- Panel/overlay CSS class names are test hooks — extend, don't rename.
- Why-comments are load-bearing — preserve existing ones verbatim when moving code.
- Any plugin-written on-disk artifact installs at `resolveProjectRoot()` (the git root), never Vite's/Next's root.
- The verifier's existing commit/mismatch/unverified semantics and its `renderSummary` output are behavior-frozen: every existing test in `tests/client/verifier.test.ts` must pass unchanged.
- MCP contract, queue lifecycle, and dispatch are untouched — no server endpoint changes.
- All commands below run from `packages/the-forge/` unless noted. Single test file: `npx vitest run tests/client/foo.test.ts`. Root gate: `npm test` from the repo root.

---

### Task 1: `ensureGitignoreEntry` — the load-bearing fix

Every Send writes `.the-forge/queue.json` at the git root. In consumer projects without a `.gitignore` entry, Tailwind v4's Vite plugin scans that file (change-request markdown is full of Tailwind class names) and every subsequent queue write triggers a **full page reload**, wiping the overlay. Reproduced and verified 2026-07-05 in the user's portfolio project. Tailwind's scanner respects `.gitignore`, so an install-time entry is the fix.

**Files:**
- Modify: `packages/the-forge/src/server/setup.ts` (add `ensureGitignoreEntry`, call it from `setupProjectConfig` — which both the Vite plugin and the Next sidecar already call)
- Test: `packages/the-forge/tests/server/setup.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function ensureGitignoreEntry(root: string): void` — exported for tests; called inside `setupProjectConfig(root, ...)` before `ensureMcpEntry`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/server/setup.test.ts` (it already imports `fs`, `path`, `os` and uses temp dirs — follow its existing `mkdtempSync` pattern; add `ensureGitignoreEntry` to the existing import from `../../src/server/setup`):

```ts
describe('ensureGitignoreEntry', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gitignore-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates .gitignore with the entry when the file does not exist', () => {
    ensureGitignoreEntry(dir)
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
    expect(content).toContain('.the-forge/')
    expect(content).toContain('# The Forge runtime state (dev-only)')
  })

  it('appends to an existing .gitignore without touching existing content', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndist\n')
    ensureGitignoreEntry(dir)
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
    expect(content.startsWith('node_modules\ndist\n')).toBe(true)
    expect(content).toContain('.the-forge/')
  })

  it('adds a separating newline when the existing file lacks a trailing one', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules')
    ensureGitignoreEntry(dir)
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
    expect(content).toContain('node_modules\n')
    expect(content).not.toContain('node_modules#')
  })

  it.each(['.the-forge', '.the-forge/', '**/.the-forge/', '.the-forge/**'])(
    'is a no-op when an existing line already covers the dir (%s)',
    (line) => {
      const before = `node_modules\n${line}\n`
      fs.writeFileSync(path.join(dir, '.gitignore'), before)
      ensureGitignoreEntry(dir)
      expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(before)
    }
  )

  it('recognizes a covering line surrounded by whitespace', () => {
    const before = 'node_modules\n  .the-forge/  \n'
    fs.writeFileSync(path.join(dir, '.gitignore'), before)
    ensureGitignoreEntry(dir)
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(before)
  })

  it('is idempotent across repeated calls', () => {
    ensureGitignoreEntry(dir)
    const first = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
    ensureGitignoreEntry(dir)
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(first)
  })

  it('does not throw when the directory is not writable', () => {
    // Simulate a read-only project the same way the suite tests other warn-and-continue
    // paths: point at a path that cannot exist as a directory.
    const file = path.join(dir, 'not-a-dir')
    fs.writeFileSync(file, '')
    expect(() => ensureGitignoreEntry(path.join(file, 'nested'))).not.toThrow()
  })

  it('is called by setupProjectConfig', () => {
    setupProjectConfig(dir, '/fake/mcp.js')
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.the-forge/')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/setup.test.ts`
Expected: FAIL — `ensureGitignoreEntry` is not exported.

- [ ] **Step 3: Implement**

In `src/server/setup.ts`, above `setupProjectConfig`:

```ts
/** Lines that already keep `.the-forge/` out of scanners/VCS — any one of these means we
 * write nothing. Deliberately a small exact-match set (after trim), not a glob matcher:
 * false negatives just append one redundant-but-harmless line; false positives would skip
 * the load-bearing fix. */
const GITIGNORE_COVERING_LINES = new Set(['.the-forge', '.the-forge/', '**/.the-forge/', '.the-forge/**'])

/**
 * Ensures the project root's .gitignore covers `.the-forge/`. This is load-bearing, not
 * housekeeping: Tailwind v4's file scanner respects .gitignore, and an UNignored
 * `.the-forge/queue.json` (whose change-request markdown is made of Tailwind class names)
 * becomes a scan dependency — after which every Send's queue write triggers a full page
 * reload that wipes the overlay mid-session (root cause of "panel closes on Send",
 * reproduced 2026-07-05; see docs/specs/2026-07-05-send-lifecycle-design.md).
 * Append-only and idempotent, same warn-and-continue I/O posture as the other install
 * side-effects — a read-only FS must never break the dev server.
 */
export function ensureGitignoreEntry(root: string): void {
  const file = path.join(root, '.gitignore')
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    raw = '' // no .gitignore yet — create one below
  }
  const covered = raw.split(/\r?\n/).some((line) => GITIGNORE_COVERING_LINES.has(line.trim()))
  if (covered) return
  const sep = raw === '' ? '' : raw.endsWith('\n') ? '' : '\n'
  try {
    fs.writeFileSync(file, `${raw}${sep}\n# The Forge runtime state (dev-only)\n.the-forge/\n`)
  } catch {
    console.warn(
      '[the-forge] could not update .gitignore — add ".the-forge/" to it manually, or queue writes may trigger full page reloads in dev'
    )
  }
}
```

Then add the call as the FIRST line of `setupProjectConfig`'s body (before `ensureMcpEntry`):

```ts
  ensureGitignoreEntry(root)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/setup.test.ts`
Expected: PASS (all pre-existing tests in the file too).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/server/setup.ts packages/the-forge/tests/server/setup.test.ts
git commit -m "fix: install-time .gitignore entry for .the-forge/ — stops Tailwind-v4 full reloads on Send"
```

---

### Task 2: Vite watcher exclusion (belt-and-braces)

**Files:**
- Modify: `packages/the-forge/src/vite.ts` (add a `config()` hook to the returned plugin object)
- Test: `packages/the-forge/tests/plugin.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the plugin's `config()` hook returns `{ server: { watch: { ignored: ['**/.the-forge/**'] } } }` (Vite merges plugin config additively — user-supplied ignores survive; arrays are concatenated by Vite's `mergeConfig`).

- [ ] **Step 1: Write the failing test**

Append to `tests/plugin.test.ts` (follow its existing `theForge()` construction; the `config` hook may be a plain method — invoke it as a function):

```ts
describe('config hook', () => {
  it('excludes .the-forge/ from the dev watcher', () => {
    const plugin = theForge()
    const hook = plugin.config
    const result = (typeof hook === 'function' ? hook : hook!.handler).call(
      {} as never,
      {},
      { command: 'serve', mode: 'development' }
    )
    expect(result).toEqual({ server: { watch: { ignored: ['**/.the-forge/**'] } } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugin.test.ts`
Expected: FAIL — `plugin.config` is undefined.

- [ ] **Step 3: Implement**

In `src/vite.ts`, add to the returned plugin object, directly above `configResolved(config)`:

```ts
    config() {
      // Belt-and-braces with the install-time .gitignore entry (server/setup.ts): even in a
      // project with no .gitignore (or a scanner that ignores it), `.the-forge/` runtime
      // writes (queue.json on every Send) must never enter the dev watcher — an unignored
      // queue write full-reloads the page in Tailwind-v4 projects and wipes the overlay.
      // Returned as a partial config: Vite merges plugin config additively (mergeConfig
      // concatenates arrays), so user-supplied `server.watch.ignored` entries survive.
      return { server: { watch: { ignored: ['**/.the-forge/**'] } } }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/vite.ts packages/the-forge/tests/plugin.test.ts
git commit -m "fix(vite): exclude .the-forge/ from the dev watcher"
```

---

### Task 3: Next webpack watcher exclusion

Turbopack has no user-facing watch-ignore knob — the gitignore entry covers it there (fixture E2E confirmed Turbopack doesn't reload on queue writes). The webpack path gets an explicit exclude.

**Files:**
- Modify: `packages/the-forge/src/next/index.ts` (extend `chainWebpack`; add `watchOptions` to the `WebpackConfig` structural type)
- Test: `packages/the-forge/tests/next/with-forge.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the chained webpack function also sets `watchOptions.ignored` (append semantics: `undefined` → `['**/.the-forge/**']`; `string` → `[existing, glob]`; `string[]` → push if absent; `RegExp` → left untouched, globs can't be mixed with a RegExp).

- [ ] **Step 1: Write the failing tests**

Append to `tests/next/with-forge.test.ts` (follow its existing pattern of calling `withForge(...)('phase-development-server', { defaultConfig: {} })` and invoking the returned `config.webpack`):

```ts
describe('webpack watchOptions.ignored', () => {
  const GLOB = '**/.the-forge/**'
  async function chained(userConfig: Record<string, unknown> = {}) {
    const fn = withForge(userConfig)
    const cfg = await fn('phase-development-server', { defaultConfig: {} })
    return cfg.webpack!
  }

  it('adds the glob when watchOptions is absent', async () => {
    const webpack = await chained()
    const out = webpack({}, {}) as { watchOptions?: { ignored?: unknown } }
    expect(out.watchOptions?.ignored).toEqual([GLOB])
  })

  it('preserves an existing string ignore', async () => {
    const webpack = await chained({ webpack: (c: Record<string, unknown>) => ({ ...c, watchOptions: { ignored: '**/tmp/**' } }) })
    const out = webpack({}, {}) as { watchOptions?: { ignored?: unknown } }
    expect(out.watchOptions?.ignored).toEqual(['**/tmp/**', GLOB])
  })

  it('appends to an existing array without duplicating', async () => {
    const webpack = await chained({ webpack: (c: Record<string, unknown>) => ({ ...c, watchOptions: { ignored: ['**/tmp/**', GLOB] } }) })
    const out = webpack({}, {}) as { watchOptions?: { ignored?: unknown } }
    expect(out.watchOptions?.ignored).toEqual(['**/tmp/**', GLOB])
  })

  it('leaves a RegExp ignore untouched (globs cannot be mixed in)', async () => {
    const re = /tmp/
    const webpack = await chained({ webpack: (c: Record<string, unknown>) => ({ ...c, watchOptions: { ignored: re } }) })
    const out = webpack({}, {}) as { watchOptions?: { ignored?: unknown } }
    expect(out.watchOptions?.ignored).toBe(re)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/next/with-forge.test.ts`
Expected: FAIL — `watchOptions` is undefined in the first three cases.

- [ ] **Step 3: Implement**

In `src/next/index.ts`, extend the `WebpackConfig` type:

```ts
export interface WebpackConfig {
  module?: { rules?: unknown[] }
  watchOptions?: { ignored?: unknown; [key: string]: unknown }
  [key: string]: unknown
}
```

In `chainWebpack`, after the `out.module.rules.unshift({...})` block and before `return out`:

```ts
    // Same reload defense as the Vite plugin's config() hook: `.the-forge/` runtime writes
    // must never enter webpack's watcher. Append-only across the shapes watchOptions.ignored
    // legally takes; a RegExp is left untouched — webpack accepts globs OR a RegExp, never a
    // mix, and rewriting the user's RegExp would silently change what THEY ignore. (Turbopack
    // has no equivalent knob; the install-time .gitignore entry covers it there.)
    const FORGE_IGNORE_GLOB = '**/.the-forge/**'
    const ignored = out.watchOptions?.ignored
    if (ignored === undefined) {
      out.watchOptions = { ...out.watchOptions, ignored: [FORGE_IGNORE_GLOB] }
    } else if (typeof ignored === 'string') {
      out.watchOptions = { ...out.watchOptions, ignored: [ignored, FORGE_IGNORE_GLOB] }
    } else if (Array.isArray(ignored) && !ignored.includes(FORGE_IGNORE_GLOB)) {
      ignored.push(FORGE_IGNORE_GLOB)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/next/with-forge.test.ts`
Expected: PASS (all pre-existing tests too).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/next/index.ts packages/the-forge/tests/next/with-forge.test.ts
git commit -m "fix(next): exclude .the-forge/ from the webpack watcher"
```

---

### Task 4: `SentRegistry.get()` — non-removing accessor

The verifier's poll loop needs to read an entry's elements (for per-element stage events) without claiming it the way `take()` does.

**Files:**
- Modify: `packages/the-forge/src/client/sent.ts`
- Test: `packages/the-forge/tests/client/sent.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `get(id: string): SentEntry | undefined` on `SentRegistry` — read-only lookup; the entry stays registered.

- [ ] **Step 1: Write the failing test**

Append to `tests/client/sent.test.ts`:

```ts
describe('get', () => {
  it('returns the entry without removing it', () => {
    const reg = new SentRegistry()
    const el = document.createElement('div')
    reg.add('q1', [{ el, dcSource: 'a.tsx:1:1', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }])
    expect(reg.get('q1')?.id).toBe('q1')
    expect(reg.size()).toBe(1)
    expect(reg.get('missing')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/sent.test.ts`
Expected: FAIL — `get` is not a function.

- [ ] **Step 3: Implement**

In `src/client/sent.ts`, after `pendingIds()`:

```ts
  /** Read-only lookup — unlike take(), the entry stays registered. Used by the verifier's
   * poll loop to emit per-element stage events for entries that are still in flight. */
  get(id: string): SentEntry | undefined {
    return this.entries.get(id)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/sent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/sent.ts packages/the-forge/tests/client/sent.test.ts
git commit -m "feat(client): SentRegistry.get() non-removing accessor"
```

---

### Task 5: Verifier structured stage events

The verifier currently crushes everything into one summary string. It additionally emits per-element-change stage events. **Behavior freeze:** every existing test in `tests/client/verifier.test.ts` must pass unchanged — `renderSummary` output, commit/mismatch/unverified decisions, backoff, and generation semantics are untouched.

**Files:**
- Modify: `packages/the-forge/src/client/verifier.ts`
- Test: `packages/the-forge/tests/client/verifier.test.ts`

**Interfaces:**
- Consumes: `SentRegistry.get(id)` (Task 4).
- Produces:

```ts
export type LifecycleStage = 'sent' | 'applying' | 'done' | 'mismatch' | 'unverified' | 'failed'
export interface StageEvent {
  requestId: string
  /** Position within the entry's elements[] — the stable row key (dcSource can be null). */
  elIndex: number
  dcSource: string | null
  stage: LifecycleStage
  /** Failure note (stage 'failed'), cleaned the same way as the summary's notes. */
  note?: string
  /** Per-property detail (stage 'mismatch'). */
  mismatches?: Array<{ property: string; expected: string; actual: string }>
}
// on Verifier:
subscribe(fn: (e: StageEvent) => void): void
```

Emission rules: each successful poll emits `sent` or `applying` for every element of every still-registered entry (repeat emissions of the same stage are expected — consumers must be idempotent); `handleApplied` emits `done` / `mismatch` / `unverified` per element based on the existing per-element verification; `handleFailed` emits `failed` (with the cleaned note) for every element of the entry.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/verifier.test.ts` (uses the file's existing helpers: `el()`, `styleRule()`, fake timers, `vi.stubGlobal('fetch', ...)`):

```ts
describe('stage events', () => {
  function twoElEntry(sent: SentRegistry): { a: HTMLElement; b: HTMLElement } {
    const a = el()
    a.id = 'ev-a'
    const b = el()
    b.id = 'ev-b'
    sent.add('q1', [
      { el: a, dcSource: 'a.tsx:1:1', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] },
      { el: b, dcSource: 'b.tsx:2:2', draftProps: ['margin-top'], changes: [{ property: 'margin-top', afterCss: '8px' }] },
    ])
    return { a, b }
  }

  it('emits sent/applying per element from the poll', async () => {
    const sent = new SentRegistry()
    twoElEntry(sent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'claimed', note: null }] }),
    }))
    const verifier = new Verifier(sent, new DraftStore(), vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events).toEqual([
      { requestId: 'q1', elIndex: 0, dcSource: 'a.tsx:1:1', stage: 'applying' },
      { requestId: 'q1', elIndex: 1, dcSource: 'b.tsx:2:2', stage: 'applying' },
    ])
    verifier.stop()
  })

  it('emits pending items as sent, not applying', async () => {
    const sent = new SentRegistry()
    twoElEntry(sent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'pending', note: null }] }),
    }))
    const verifier = new Verifier(sent, new DraftStore(), vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events.map((e) => e.stage)).toEqual(['sent', 'sent'])
    verifier.stop()
  })

  it('emits done and mismatch per element on applied', async () => {
    const sent = new SentRegistry()
    const { a } = twoElEntry(sent)
    styleRule('ev-a', 'padding-top', '24px') // a verifies; b (no rule) mismatches
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    }))
    const drafts = new DraftStore()
    const verifier = new Verifier(sent, drafts, vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    const byIndex = new Map(events.map((e) => [e.elIndex, e]))
    expect(byIndex.get(0)?.stage).toBe('done')
    expect(byIndex.get(1)?.stage).toBe('mismatch')
    expect(byIndex.get(1)?.mismatches).toEqual([{ property: 'margin-top', expected: '8px', actual: '0px' }])
    expect(a.isConnected).toBe(true)
    verifier.stop()
  })

  it('emits unverified for an element that cannot be located', async () => {
    const sent = new SentRegistry()
    const gone = document.createElement('div') // never attached, no matching dcSource in DOM
    sent.add('q1', [{ el: gone, dcSource: 'gone.tsx:9:9', draftProps: ['padding-top'], changes: [{ property: 'padding-top', afterCss: '24px' }] }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }),
    }))
    const verifier = new Verifier(sent, new DraftStore(), vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events).toEqual([{ requestId: 'q1', elIndex: 0, dcSource: 'gone.tsx:9:9', stage: 'unverified' }])
    verifier.stop()
  })

  it('emits failed with the cleaned note for every element', async () => {
    const sent = new SentRegistry()
    twoElEntry(sent)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'q1', status: 'failed', note: '  needs   confirmation: shared\ncomponent  ' }] }),
    }))
    const verifier = new Verifier(sent, new DraftStore(), vi.fn())
    const events: StageEvent[] = []
    verifier.subscribe((e) => events.push(e))
    verifier.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events.map((e) => e.stage)).toEqual(['failed', 'failed'])
    expect(events[0].note).toBe('needs confirmation: shared component')
    verifier.stop()
  })
})
```

Add `StageEvent` to the file's import from `../../src/client/verifier`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/verifier.test.ts`
Expected: new describe FAILS (`subscribe` not a function); all pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `src/client/verifier.ts`:

1. Add the exported types after `VerifyResult`:

```ts
export type LifecycleStage = 'sent' | 'applying' | 'done' | 'mismatch' | 'unverified' | 'failed'

/** One per-element-change lifecycle transition, consumed by the panel's ChangeList. The
 * (requestId, elIndex) pair is the stable row key — dcSource can be null and, on lists,
 * non-unique. Poll-driven stages (sent/applying) re-emit every tick; consumers must be
 * idempotent. */
export interface StageEvent {
  requestId: string
  elIndex: number
  dcSource: string | null
  stage: LifecycleStage
  note?: string
  mismatches?: Array<{ property: string; expected: string; actual: string }>
}
```

2. In the `Verifier` class, add the listener list and API:

```ts
  private stageListeners: Array<(e: StageEvent) => void> = []

  subscribe(fn: (e: StageEvent) => void): void {
    this.stageListeners.push(fn)
  }

  private emitStage(e: StageEvent): void {
    for (const fn of this.stageListeners) fn(e)
  }
```

3. In `poll()`, inside the loop that computes `claimed`/`pendingManual` (it already iterates `this.sent.pendingIds()` and reads `statusById`), emit per element. Replace the existing loop body:

```ts
        for (const id of this.sent.pendingIds()) {
          const status = statusById.get(id)
          const stage: LifecycleStage = status === 'claimed' ? 'applying' : 'sent'
          if (status === 'claimed') claimed++
          else pendingManual++ // status === 'pending', or unknown/missing from the response
          const entry = this.sent.get(id)
          if (entry) {
            entry.elements.forEach((element, elIndex) =>
              this.emitStage({ requestId: id, elIndex, dcSource: element.dcSource, stage })
            )
          }
        }
```

4. In `handleApplied(id)`, the existing `for (const ev of verifyElements(entry))` loop decides per element — change it to a `forEach` with index and emit alongside each existing branch (the counter and commit logic stays byte-identical):

```ts
    verifyElements(entry).forEach((ev, elIndex) => {
      const dcSource = entry.elements[elIndex].dcSource
      if (ev.missing > 0) {
        this.counters.unverified += 1
        this.emitStage({ requestId: id, elIndex, dcSource, stage: 'unverified' })
      } else if (ev.mismatched.length > 0) {
        this.counters.mismatch += 1
        this.emitStage({ requestId: id, elIndex, dcSource, stage: 'mismatch', mismatches: ev.mismatched })
      } else {
        this.drafts.commit(ev.el, ev.draftProps)
        this.counters.implemented += 1
        this.emitStage({ requestId: id, elIndex, dcSource, stage: 'done' })
      }
    })
```

5. In `handleFailed(id, note)`, after the existing note-cleaning block, emit per element. The cleaned note must be computed once whether or not it enters `failedNotes` (extract the existing `const clean = ...` line above the dedupe check so both uses share it):

```ts
    const clean = note ? note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS) : ''
    if (clean && !this.counters.failedNotes.includes(clean) && this.counters.failedNotes.length < MAX_FAILED_NOTES) {
      this.counters.failedNotes.push(clean)
    }
    entry.elements.forEach((element, elIndex) =>
      this.emitStage({ requestId: id, elIndex, dcSource: element.dcSource, stage: 'failed', ...(clean ? { note: clean } : {}) })
    )
```

(Preserve the existing why-comment about agent-authored free text verbatim above the cleaning line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/verifier.test.ts`
Expected: PASS — new AND all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/verifier.ts packages/the-forge/tests/client/verifier.test.ts
git commit -m "feat(client): verifier emits structured per-element stage events"
```

---

### Task 6: Lifecycle sessionStorage store

Pure persistence module: serialize/restore helpers, no DOM ownership beyond element lookup by source attr.

**Files:**
- Create: `packages/the-forge/src/client/lifecycle-store.ts`
- Test: `packages/the-forge/tests/client/lifecycle-store.test.ts`

**Interfaces:**
- Consumes: `SentChange` from `./sent`, `ElementChange` from `./request`, `TaggedElement` from `./source`.
- Produces (exact shapes later tasks rely on):

```ts
export const LIFECYCLE_KEY = 'the-forge:lifecycle'
export interface PersistedSentElement {
  dcSource: string | null
  index: number            // position among querySelectorAll matches for dcSource at save time
  tag: string              // for a detached placeholder when the element can't be re-located
  draftProps: string[]
  changes: SentChange[]
  change: ElementChange    // full change payload — powers row summaries and Re-send after reload
}
export interface PersistedLifecycle {
  v: 1
  designModeOn: boolean
  selection: Array<{ dcSource: string; index: number }>
  drafts: Array<{ dcSource: string; index: number; props: Array<[prop: string, value: string]> }>
  sent: Array<{ id: string; elements: PersistedSentElement[] }>
}
export function sourceIndex(el: Element, dcSource: string, doc?: Document): number
export function locateBySource(dcSource: string, index: number, doc?: Document): TaggedElement | null
export function saveLifecycle(state: PersistedLifecycle, storage?: Storage): void
export function loadLifecycle(storage?: Storage): PersistedLifecycle | null
```

- [ ] **Step 1: Write the failing tests**

Create `tests/client/lifecycle-store.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  LIFECYCLE_KEY,
  saveLifecycle,
  loadLifecycle,
  sourceIndex,
  locateBySource,
  type PersistedLifecycle,
} from '../../src/client/lifecycle-store'

function state(overrides: Partial<PersistedLifecycle> = {}): PersistedLifecycle {
  return { v: 1, designModeOn: true, selection: [], drafts: [], sent: [], ...overrides }
}

beforeEach(() => {
  sessionStorage.clear()
  document.body.innerHTML = ''
})

describe('save/load round-trip', () => {
  it('round-trips a full state', () => {
    const s = state({
      selection: [{ dcSource: 'a.tsx:1:1', index: 0 }],
      drafts: [{ dcSource: 'a.tsx:1:1', index: 0, props: [['padding-top', '24px']] }],
      sent: [
        {
          id: 'q1',
          elements: [
            {
              dcSource: 'a.tsx:1:1',
              index: 0,
              tag: 'div',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: {
                tag: 'div',
                source: { file: 'a.tsx', line: 1, col: 1 },
                className: 'p-2',
                text: '',
                selector: 'div',
                changes: [
                  { property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: 'pt-2', afterUtility: 'pt-6', tokenExact: true },
                ],
              },
            },
          ],
        },
      ],
    })
    saveLifecycle(s)
    expect(loadLifecycle()).toEqual(s)
  })

  it('returns null when nothing is stored', () => {
    expect(loadLifecycle()).toBeNull()
  })

  it('returns null on corrupt JSON without throwing', () => {
    sessionStorage.setItem(LIFECYCLE_KEY, '{not json')
    expect(loadLifecycle()).toBeNull()
  })

  it('returns null on a wrong version or shape', () => {
    sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify({ v: 99, designModeOn: true }))
    expect(loadLifecycle()).toBeNull()
    sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify({ v: 1, designModeOn: 'yes' }))
    expect(loadLifecycle()).toBeNull()
    sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify({ v: 1, designModeOn: true, selection: 'nope', drafts: [], sent: [] }))
    expect(loadLifecycle()).toBeNull()
  })

  it('save never throws when storage is unavailable', () => {
    const broken = { setItem: () => { throw new Error('quota') } } as unknown as Storage
    expect(() => saveLifecycle(state(), broken)).not.toThrow()
  })
})

describe('sourceIndex / locateBySource', () => {
  it('disambiguates list items sharing one dcSource by DOM order', () => {
    document.body.innerHTML = `
      <li data-dc-source="li.tsx:5:5" id="first"></li>
      <li data-dc-source="li.tsx:5:5" id="second"></li>`
    const second = document.getElementById('second')!
    expect(sourceIndex(second, 'li.tsx:5:5')).toBe(1)
    expect(locateBySource('li.tsx:5:5', 1)?.id).toBe('second')
    expect(locateBySource('li.tsx:5:5', 0)?.id).toBe('first')
  })

  it('falls back to the first match when the saved index no longer exists', () => {
    document.body.innerHTML = `<li data-dc-source="li.tsx:5:5" id="only"></li>`
    expect(locateBySource('li.tsx:5:5', 7)?.id).toBe('only')
  })

  it('returns null when no element carries the source', () => {
    expect(locateBySource('gone.tsx:1:1', 0)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/lifecycle-store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/client/lifecycle-store.ts`:

```ts
import type { SentChange } from './sent'
import type { ElementChange } from './request'
import type { TaggedElement } from './source'

export const LIFECYCLE_KEY = 'the-forge:lifecycle'

export interface PersistedSentElement {
  dcSource: string | null
  /** Position among querySelectorAll('[data-dc-source="..."]') matches at save time — one
   * source location can render many DOM instances (list items); locate() alone would always
   * resolve the FIRST. */
  index: number
  /** Tag name for a detached placeholder when the element can't be re-located — the verifier's
   * locate() falls back to a dcSource lookup for any disconnected element, so a placeholder
   * self-heals once the element re-appears. */
  tag: string
  draftProps: string[]
  changes: SentChange[]
  change: ElementChange
}

export interface PersistedLifecycle {
  v: 1
  designModeOn: boolean
  selection: Array<{ dcSource: string; index: number }>
  drafts: Array<{ dcSource: string; index: number; props: Array<[prop: string, value: string]> }>
  sent: Array<{ id: string; elements: PersistedSentElement[] }>
}

function matches(dcSource: string, doc: Document): TaggedElement[] {
  // dcSource is our own file:line:col format — no quotes/backslashes — but escape anyway so a
  // hostile attribute value can't break out of the selector string.
  const escaped = dcSource.replace(/["\\]/g, '\\$&')
  return [...doc.querySelectorAll<TaggedElement>(`[data-dc-source="${escaped}"]`)]
}

export function sourceIndex(el: Element, dcSource: string, doc: Document = document): number {
  const i = matches(dcSource, doc).indexOf(el as TaggedElement)
  return i === -1 ? 0 : i
}

export function locateBySource(dcSource: string, index: number, doc: Document = document): TaggedElement | null {
  const els = matches(dcSource, doc)
  return els[index] ?? els[0] ?? null
}

export function saveLifecycle(state: PersistedLifecycle, storage: Storage = sessionStorage): void {
  try {
    storage.setItem(LIFECYCLE_KEY, JSON.stringify(state))
  } catch {
    // Persistence is a nicety — quota/privacy-mode failures must never break an edit session.
  }
}

/** unknown + manual checks at the I/O boundary — project convention, no schema libs. Any
 * shape violation returns null (start clean), same posture as dock.ts loadPrefs(). */
export function loadLifecycle(storage: Storage = sessionStorage): PersistedLifecycle | null {
  let raw: string | null = null
  try {
    raw = storage.getItem(LIFECYCLE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const s = parsed as Record<string, unknown>
  if (s.v !== 1) return null
  if (typeof s.designModeOn !== 'boolean') return null
  if (!Array.isArray(s.selection) || !Array.isArray(s.drafts) || !Array.isArray(s.sent)) return null
  return parsed as PersistedLifecycle
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/lifecycle-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/lifecycle-store.ts packages/the-forge/tests/client/lifecycle-store.test.ts
git commit -m "feat(client): sessionStorage lifecycle store with source-index element relocation"
```

---

### Task 7: ChangeList — rows, stages, CSS, panel slot

The Changes section: renders draft rows straight from the `DraftStore` and sent rows seeded at send time, advanced by `StageEvent`s. Hidden entirely when empty (zero footprint). This task builds rendering + stage transitions; Task 8 adds interactions.

**Files:**
- Create: `packages/the-forge/src/client/changelist.ts`
- Modify: `packages/the-forge/src/client/overlay.ts` (CSS additions at the end of the `CSS` template string)
- Modify: `packages/the-forge/src/client/panel.ts` (public `changesSlot` element in the root, between `body` and `footer`)
- Test: `packages/the-forge/tests/client/changelist.test.ts`

**Interfaces:**
- Consumes: `DraftStore` (`entries()`, values `{original, value}`), `StageEvent`/`LifecycleStage` from `./verifier`, `ElementChange` from `./request`, `TaggedElement` from `./source`.
- Produces:

```ts
export interface SentSeed {
  el: TaggedElement
  dcSource: string | null
  draftProps: string[]
  change: ElementChange
}
export interface ChangeListCallbacks {
  onHover: (el: TaggedElement | null) => void
  onSelect: (el: TaggedElement) => void
  onResend: (seed: SentSeed) => void
}
export class ChangeList {
  root: HTMLElement                               // '.changes-section'; hidden when no rows
  constructor(drafts: DraftStore, cb: ChangeListCallbacks)
  syncDrafts(): void                              // rebuild draft rows from the DraftStore
  addSent(id: string, seeds: SentSeed[]): void    // one row per seed, stage 'sent'
  applyStage(e: StageEvent): void                 // idempotent; unknown (requestId, elIndex) ignored
  clear(): void                                   // drop ALL rows (design-mode off)
}
```

Row rules (from the approved spec):
- Draft rows: one per element with drafts, EXCLUDING props currently covered by an in-flight (`sent`/`applying`) sent row for the same element — the same edit must not show twice. If nothing remains, no draft row.
- Sent rows: keyed `${requestId}:${elIndex}`. Stages advance per events; `applying → sent` regression is legal (stale claim re-queued).
- Terminal rows: `done`/`unverified` linger until "Clear done"; `mismatch` lingers (draft is kept by the verifier); `failed` pins with its note + Re-send/Dismiss (Task 8).
- Summary text: sent rows use the first `ChangeItem` — `pt-2 → pt-6` when both utilities exist, `add pt-6` when only after exists, else `padding-top: 8px → 24px` — plus ` +N more` when more changes exist (full list in `title`). Draft rows show `prop → value` from the draft store the same way.
- Element label: `tag · file:line` from `ElementChange` (sent) or `el.tagName.toLowerCase()` + parsed `data-dc-source` (draft); `(no source)` when untagged.

- [ ] **Step 1: Write the failing tests**

Create `tests/client/changelist.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChangeList, type SentSeed } from '../../src/client/changelist'
import { DraftStore } from '../../src/client/drafts'
import type { ElementChange } from '../../src/client/request'

function tagged(dcSource = 'src/App.tsx:8:11'): HTMLElement {
  const el = document.createElement('h1')
  el.setAttribute('data-dc-source', dcSource)
  document.body.appendChild(el)
  return el
}

function elementChange(overrides: Partial<ElementChange> = {}): ElementChange {
  return {
    tag: 'h1',
    source: { file: 'src/App.tsx', line: 8, col: 11 },
    className: 'pt-2',
    text: 'Vitality',
    selector: 'h1',
    changes: [
      { property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: 'pt-2', afterUtility: 'pt-6', tokenExact: true },
    ],
    ...overrides,
  }
}

function seed(el: HTMLElement, change = elementChange()): SentSeed {
  return { el: el as never, dcSource: el.getAttribute('data-dc-source'), draftProps: ['padding-top'], change }
}

const noop = { onHover: vi.fn(), onSelect: vi.fn(), onResend: vi.fn() }

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('empty state', () => {
  it('is hidden with no rows', () => {
    const list = new ChangeList(new DraftStore(), noop)
    expect(list.root.hidden).toBe(true)
    expect(list.root.className).toBe('changes-section')
  })
})

describe('draft rows', () => {
  it('shows a draft row per drafted element after syncDrafts', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, noop)
    drafts.apply(el as never, 'padding-top', '24px')
    list.syncDrafts()
    expect(list.root.hidden).toBe(false)
    const rows = list.root.querySelectorAll('.change-row')
    expect(rows.length).toBe(1)
    expect(rows[0].querySelector('.chip')!.className).toContain('chip-draft')
    expect(rows[0].querySelector('.change-el')!.textContent).toContain('h1')
    expect(rows[0].querySelector('.change-summary')!.textContent).toContain('padding-top')
    expect(rows[0].querySelector('.change-summary')!.textContent).toContain('24px')
  })

  it('removes the draft row when the draft is discarded', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, noop)
    drafts.apply(el as never, 'padding-top', '24px')
    list.syncDrafts()
    drafts.discard(el as never)
    list.syncDrafts()
    expect(list.root.hidden).toBe(true)
  })

  it('excludes props covered by an in-flight sent row for the same element', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, noop)
    drafts.apply(el as never, 'padding-top', '24px')
    list.addSent('q1', [seed(el)])
    list.syncDrafts()
    // padding-top is in flight — only the sent row shows
    const chips = [...list.root.querySelectorAll('.chip')].map((c) => c.className)
    expect(chips.filter((c) => c.includes('chip-draft'))).toHaveLength(0)
    expect(chips.filter((c) => c.includes('chip-sent'))).toHaveLength(1)
    // a second, un-sent prop on the same element gets its own draft row
    drafts.apply(el as never, 'margin-top', '8px')
    list.syncDrafts()
    const draftRow = [...list.root.querySelectorAll('.change-row')].find((r) => r.querySelector('.chip-draft'))
    expect(draftRow?.querySelector('.change-summary')?.textContent).toContain('margin-top')
    expect(draftRow?.querySelector('.change-summary')?.textContent).not.toContain('padding-top')
  })
})

describe('sent rows and stages', () => {
  it('renders sent rows with token-vocabulary summaries', () => {
    const list = new ChangeList(new DraftStore(), noop)
    list.addSent('q1', [seed(tagged())])
    const row = list.root.querySelector('.change-row')!
    expect(row.querySelector('.chip')!.className).toContain('chip-sent')
    expect(row.querySelector('.change-summary')!.textContent).toBe('pt-2 → pt-6')
    expect(row.querySelector('.change-el')!.textContent).toBe('h1 · App.tsx:8')
  })

  it('summarizes multi-change elements with +N more', () => {
    const change = elementChange({
      changes: [
        { property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: 'pt-2', afterUtility: 'pt-6', tokenExact: true },
        { property: 'margin-top', beforeCss: '0px', afterCss: '8px', beforeUtility: null, afterUtility: 'mt-2', tokenExact: true },
      ],
    })
    const list = new ChangeList(new DraftStore(), noop)
    list.addSent('q1', [seed(tagged(), change)])
    expect(list.root.querySelector('.change-summary')!.textContent).toBe('pt-2 → pt-6 +1 more')
  })

  it('advances stages idempotently and allows applying → sent regression', () => {
    const list = new ChangeList(new DraftStore(), noop)
    list.addSent('q1', [seed(tagged())])
    const chip = () => list.root.querySelector('.chip')!.className
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'applying' })
    expect(chip()).toContain('chip-applying')
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'applying' })
    expect(list.root.querySelectorAll('.change-row')).toHaveLength(1)
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'sent' })
    expect(chip()).toContain('chip-sent')
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'done' })
    expect(chip()).toContain('chip-done')
  })

  it('a terminal row no longer regresses on late poll events', () => {
    const list = new ChangeList(new DraftStore(), noop)
    list.addSent('q1', [seed(tagged())])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'done' })
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'sent' })
    expect(list.root.querySelector('.chip')!.className).toContain('chip-done')
  })

  it('renders the failed note', () => {
    const list = new ChangeList(new DraftStore(), noop)
    list.addSent('q1', [seed(tagged())])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: 'src/App.tsx:8:11', stage: 'failed', note: 'needs confirmation: shared component' })
    expect(list.root.querySelector('.chip')!.className).toContain('chip-failed')
    expect(list.root.querySelector('.change-note')!.textContent).toBe('needs confirmation: shared component')
  })

  it('ignores events for unknown rows', () => {
    const list = new ChangeList(new DraftStore(), noop)
    expect(() => list.applyStage({ requestId: 'zzz', elIndex: 3, dcSource: null, stage: 'done' })).not.toThrow()
    expect(list.root.hidden).toBe(true)
  })

  it('clear() drops everything', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, noop)
    drafts.apply(el as never, 'padding-top', '24px')
    list.syncDrafts()
    list.addSent('q1', [seed(tagged('src/B.tsx:1:1'))])
    list.clear()
    expect(list.root.hidden).toBe(true)
    expect(list.root.querySelectorAll('.change-row')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/changelist.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/client/changelist.ts`**

```ts
import type { DraftStore } from './drafts'
import type { StageEvent, LifecycleStage } from './verifier'
import type { ElementChange, ChangeItem } from './request'
import type { TaggedElement } from './source'
import { parseSourceAttr } from './source'

export interface SentSeed {
  el: TaggedElement
  dcSource: string | null
  draftProps: string[]
  change: ElementChange
}

export interface ChangeListCallbacks {
  onHover: (el: TaggedElement | null) => void
  onSelect: (el: TaggedElement) => void
  onResend: (seed: SentSeed) => void
}

/** Stages a row can no longer leave via poll events — a late 'sent'/'applying' tick for an
 * already-resolved id (races between take() and the next poll) must not resurrect a receipt. */
const TERMINAL: ReadonlySet<LifecycleStage> = new Set(['done', 'mismatch', 'unverified', 'failed'])

interface SentRow {
  seed: SentSeed
  stage: LifecycleStage
  note?: string
  mismatches?: StageEvent['mismatches']
}

function summarizeItem(c: ChangeItem): string {
  if (c.beforeUtility && c.afterUtility) return `${c.beforeUtility} → ${c.afterUtility}`
  if (c.afterUtility) return `add ${c.afterUtility}`
  return `${c.property}: ${c.beforeCss} → ${c.afterCss}`
}

function summarize(changes: ChangeItem[]): { text: string; full: string } {
  const all = changes.map(summarizeItem)
  const text = all.length > 1 ? `${all[0]} +${all.length - 1} more` : (all[0] ?? '')
  return { text, full: all.join('\n') }
}

function shortSource(dcSource: string | null): string {
  if (!dcSource) return '(no source)'
  const parsed = parseSourceAttr(dcSource)
  if (!parsed) return '(no source)'
  const slash = parsed.file.lastIndexOf('/')
  return `${slash === -1 ? parsed.file : parsed.file.slice(slash + 1)}:${parsed.line}`
}

export class ChangeList {
  root = document.createElement('div')

  private head = document.createElement('div')
  private clearButton = document.createElement('button')
  private list = document.createElement('div')
  private sentRows = new Map<string, SentRow>() // key: `${requestId}:${elIndex}`
  private dismissed = new Set<string>()

  constructor(
    private drafts: DraftStore,
    private cb: ChangeListCallbacks
  ) {
    this.root.className = 'changes-section'
    this.root.hidden = true
    this.head.className = 'changes-head'
    const title = document.createElement('span')
    title.textContent = 'Changes'
    this.clearButton.className = 'changes-clear'
    this.clearButton.textContent = 'Clear done'
    this.clearButton.addEventListener('click', () => this.clearDone())
    this.head.append(title, this.clearButton)
    this.list.className = 'changes-list'
    this.root.append(this.head, this.list)
  }

  syncDrafts(): void {
    this.render()
  }

  addSent(id: string, seeds: SentSeed[]): void {
    seeds.forEach((seed, i) => this.sentRows.set(`${id}:${i}`, { seed, stage: 'sent' }))
    this.render()
  }

  applyStage(e: StageEvent): void {
    const row = this.sentRows.get(`${e.requestId}:${e.elIndex}`)
    if (!row) return
    if (row.stage === e.stage) return // poll re-emissions are expected — no re-render churn
    if (TERMINAL.has(row.stage)) return
    row.stage = e.stage
    row.note = e.note
    row.mismatches = e.mismatches
    this.render()
  }

  clearDone(): void {
    for (const [key, row] of this.sentRows) {
      if (row.stage === 'done' || row.stage === 'unverified') this.sentRows.delete(key)
    }
    this.render()
  }

  clear(): void {
    this.sentRows.clear()
    this.dismissed.clear()
    this.render()
  }

  /** Props of `el` covered by an in-flight (sent/applying) row — those edits are already
   * represented; a draft row repeating them would show the same change twice. */
  private inFlightProps(el: TaggedElement): Set<string> {
    const props = new Set<string>()
    for (const row of this.sentRows.values()) {
      if (row.seed.el !== el) continue
      if (row.stage !== 'sent' && row.stage !== 'applying') continue
      for (const p of row.seed.draftProps) props.add(p)
    }
    return props
  }

  private render(): void {
    this.list.replaceChildren()
    let terminalOk = 0

    // Sent rows first (newest last in insertion order — reverse for newest-first display).
    const sentEntries = [...this.sentRows.entries()].reverse()
    for (const [, row] of sentEntries) {
      this.list.appendChild(this.renderSentRow(row))
      if (row.stage === 'done' || row.stage === 'unverified') terminalOk++
    }

    // Draft rows after sent rows: drafts are "not yet part of the story being told above".
    for (const [el, props] of this.drafts.entries()) {
      const inFlight = this.inFlightProps(el as TaggedElement)
      const remaining = [...props.entries()].filter(([prop]) => !inFlight.has(prop))
      if (remaining.length === 0) continue
      this.list.appendChild(this.renderDraftRow(el as TaggedElement, remaining))
    }

    this.clearButton.hidden = terminalOk === 0
    this.root.hidden = this.list.childElementCount === 0
  }

  private baseRow(stage: LifecycleStage | 'draft', el: TaggedElement | null): HTMLElement {
    const row = document.createElement('div')
    row.className = 'change-row'
    row.dataset.stage = stage
    const chip = document.createElement('span')
    chip.className = `chip chip-${stage}`
    chip.textContent = stage
    row.appendChild(chip)
    if (el) {
      const locatable = el.isConnected
      if (!locatable) row.classList.add('row-gone')
      row.addEventListener('mouseenter', () => this.cb.onHover(el.isConnected ? el : null))
      row.addEventListener('mouseleave', () => this.cb.onHover(null))
      row.addEventListener('click', () => {
        if (el.isConnected) this.cb.onSelect(el)
      })
    }
    return row
  }

  private label(tag: string, dcSource: string | null): [HTMLElement, HTMLElement] {
    const elLabel = document.createElement('span')
    elLabel.className = 'change-el'
    elLabel.textContent = `${tag} · ${shortSource(dcSource)}`
    const summary = document.createElement('span')
    summary.className = 'change-summary'
    return [elLabel, summary]
  }

  private renderDraftRow(el: TaggedElement, props: Array<[string, { original: string; value: string }]>): HTMLElement {
    const row = this.baseRow('draft', el)
    const dcSource = el.dataset?.dcSource ?? null
    const [elLabel, summary] = this.label(el.tagName.toLowerCase(), dcSource)
    const all = props.map(([prop, d]) => `${prop} → ${d.value}`)
    summary.textContent = all.length > 1 ? `${all[0]} +${all.length - 1} more` : all[0]
    summary.title = all.join('\n')
    row.append(elLabel, summary)
    return row
  }

  private renderSentRow(row: SentRow): HTMLElement {
    const dom = this.baseRow(row.stage, row.seed.el)
    const source = row.seed.change.source
    const dcSource = source ? `${source.file}:${source.line}:${source.col}` : row.seed.dcSource
    const [elLabel, summary] = this.label(row.seed.change.tag, dcSource)
    const { text, full } = summarize(row.seed.change.changes)
    summary.textContent = text
    summary.title = full
    dom.append(elLabel, summary)
    if (row.stage === 'mismatch' && row.mismatches?.length) {
      const note = document.createElement('div')
      note.className = 'change-note change-note-mismatch'
      note.textContent = row.mismatches.map((m) => `${m.property}: expected ${m.expected}, got ${m.actual}`).join('; ')
      dom.appendChild(note)
    }
    if (row.stage === 'failed') {
      if (row.note) {
        const note = document.createElement('div')
        note.className = 'change-note'
        note.textContent = row.note
        dom.appendChild(note)
      }
      dom.appendChild(this.failedActions(row))
    }
    return dom
  }

  private failedActions(row: SentRow): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'change-actions'
    const resend = document.createElement('button')
    resend.className = 'change-resend'
    resend.textContent = 'Re-send'
    resend.addEventListener('click', (e) => {
      e.stopPropagation() // row click selects the element — actions must not
      this.dismissRow(row)
      this.cb.onResend(row.seed)
    })
    const dismiss = document.createElement('button')
    dismiss.className = 'change-dismiss'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation()
      this.dismissRow(row)
    })
    actions.append(resend, dismiss)
    return actions
  }

  private dismissRow(row: SentRow): void {
    for (const [key, r] of this.sentRows) {
      if (r === row) this.sentRows.delete(key)
    }
    this.render()
  }
}
```

Note: `parseSourceAttr` and `ChangeItem` must be exported from `./source` / `./request` already — both are (see `source.ts`, `request.ts`).

- [ ] **Step 4: Add the CSS (overlay.ts) and the panel slot (panel.ts)**

In `src/client/overlay.ts`, append to the `CSS` template string, directly before the closing backtick:

```css
/* Changes lifecycle list (send-lifecycle spec) — chips reuse the design tokens above:
 * applying/mismatch share the ripple amber, done the watch-live green. */
.changes-section {
  flex: none; display: flex; flex-direction: column; max-height: 180px;
  border-top: 1px solid rgba(255,255,255,0.07);
}
.changes-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px 4px; font: 600 11px system-ui, sans-serif; color: #E8E8E8;
}
.changes-list { overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 2px; }
.changes-list::-webkit-scrollbar { width: 8px; }
.changes-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
.change-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 6px; font: 400 11px system-ui, sans-serif; color: #D4D4D4;
  cursor: default;
}
.change-row:hover { background: rgba(255,255,255,0.06); }
.change-row.row-gone { opacity: 0.5; }
.chip {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  font: 500 10px system-ui, sans-serif; border-radius: 999px; padding: 1px 7px;
}
.chip::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.chip-draft { color: #B8B8B8; border: 1px dashed rgba(255,255,255,0.25); }
.chip-sent { color: #B8B8B8; background: rgba(255,255,255,0.08); }
.chip-applying { color: #E2954A; background: rgba(226,149,74,0.12); }
@keyframes forge-chip-pulse { 50% { opacity: 0.4; } }
.chip-applying::before { animation: forge-chip-pulse 1.2s ease-in-out infinite; }
.chip-done { color: #62C073; background: rgba(98,192,115,0.12); }
.chip-mismatch { color: #E2954A; background: rgba(226,149,74,0.12); }
.chip-unverified { color: #B8B8B8; background: rgba(255,255,255,0.08); }
.chip-failed { color: #F87171; background: rgba(248,113,113,0.12); }
.change-el { flex: none; color: #F5F5F5; }
.change-summary {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #9A9A9A;
}
.change-note { flex-basis: 100%; color: #F87171; font-size: 10.5px; padding: 0 6px 2px 22px; white-space: normal; }
.change-note-mismatch { color: #E2954A; }
.change-actions { display: flex; gap: 4px; flex-basis: 100%; padding: 0 6px 2px 22px; }
```

In `src/client/panel.ts`, add a public field after `footer`:

```ts
  /** Mount slot for the Changes lifecycle list (changelist.ts) — owned/populated by
   * DesignMode, positioned here so it pins between the scrolling sections and the footer
   * and stays visible in the docked no-selection empty state (body hidden, footer kept). */
  changesSlot = document.createElement('div')
```

…and change the root assembly line in the constructor from:

```ts
    this.root.append(this.resizeHandle, this.head, this.actions, this.emptyEl, this.body, this.footer)
```

to:

```ts
    this.root.append(this.resizeHandle, this.head, this.actions, this.emptyEl, this.body, this.changesSlot, this.footer)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/client/changelist.test.ts tests/client/panel.test.ts tests/client/overlay.test.ts`
Expected: PASS — including the pre-existing panel/overlay suites (class names only added, none renamed).

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/changelist.ts packages/the-forge/src/client/overlay.ts packages/the-forge/src/client/panel.ts packages/the-forge/tests/client/changelist.test.ts
git commit -m "feat(client): ChangeList panel section — per-change lifecycle rows"
```

---

### Task 8: ChangeList interactions — hover, select, dismiss, re-send

The row callbacks are wired in Task 7's implementation; this task locks them in with tests (a reviewer can reject the interaction contract independently of rendering).

**Files:**
- Modify: `packages/the-forge/src/client/changelist.ts` (only if a test exposes a gap)
- Test: `packages/the-forge/tests/client/changelist.test.ts`

**Interfaces:**
- Consumes: Task 7's `ChangeList`.
- Produces: verified callback contract for Task 9's wiring — `onHover(el)` on mouseenter (null on mouseleave or when the element is gone), `onSelect(el)` on row click for connected elements only, `onResend(seed)` removes the failed row and hands the seed to the host.

- [ ] **Step 1: Write the failing/locking tests**

Append to `tests/client/changelist.test.ts`:

```ts
describe('interactions', () => {
  it('hover reports the element, mouseleave reports null', () => {
    const onHover = vi.fn()
    const list = new ChangeList(new DraftStore(), { ...noop, onHover })
    const el = tagged()
    list.addSent('q1', [seed(el)])
    const row = list.root.querySelector('.change-row')!
    row.dispatchEvent(new MouseEvent('mouseenter'))
    expect(onHover).toHaveBeenLastCalledWith(el)
    row.dispatchEvent(new MouseEvent('mouseleave'))
    expect(onHover).toHaveBeenLastCalledWith(null)
  })

  it('click selects a connected element', () => {
    const onSelect = vi.fn()
    const list = new ChangeList(new DraftStore(), { ...noop, onSelect })
    const el = tagged()
    list.addSent('q1', [seed(el)])
    list.root.querySelector('.change-row')!.dispatchEvent(new MouseEvent('click'))
    expect(onSelect).toHaveBeenCalledWith(el)
  })

  it('a disconnected element greys the row and never selects', () => {
    const onSelect = vi.fn()
    const onHover = vi.fn()
    const list = new ChangeList(new DraftStore(), { ...noop, onSelect, onHover })
    const el = tagged()
    const s = seed(el)
    el.remove()
    list.addSent('q1', [s])
    const row = list.root.querySelector('.change-row')!
    expect(row.className).toContain('row-gone')
    row.dispatchEvent(new MouseEvent('click'))
    expect(onSelect).not.toHaveBeenCalled()
    row.dispatchEvent(new MouseEvent('mouseenter'))
    expect(onHover).toHaveBeenLastCalledWith(null)
  })

  it('Dismiss removes a failed row', () => {
    const list = new ChangeList(new DraftStore(), noop)
    list.addSent('q1', [seed(tagged())])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'failed', note: 'nope' })
    ;(list.root.querySelector('.change-dismiss') as HTMLElement).click()
    expect(list.root.hidden).toBe(true)
  })

  it('Re-send removes the row and forwards the seed', () => {
    const onResend = vi.fn()
    const list = new ChangeList(new DraftStore(), { ...noop, onResend })
    const el = tagged()
    const s = seed(el)
    list.addSent('q1', [s])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'failed' })
    ;(list.root.querySelector('.change-resend') as HTMLElement).click()
    expect(onResend).toHaveBeenCalledWith(s)
    expect(list.root.hidden).toBe(true)
  })

  it('Clear done removes done and unverified rows, keeps failed and mismatch', () => {
    const list = new ChangeList(new DraftStore(), noop)
    list.addSent('q1', [seed(tagged('a.tsx:1:1')), seed(tagged('b.tsx:2:2')), seed(tagged('c.tsx:3:3')), seed(tagged('d.tsx:4:4'))])
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'done' })
    list.applyStage({ requestId: 'q1', elIndex: 1, dcSource: null, stage: 'unverified' })
    list.applyStage({ requestId: 'q1', elIndex: 2, dcSource: null, stage: 'failed' })
    list.applyStage({ requestId: 'q1', elIndex: 3, dcSource: null, stage: 'mismatch' })
    ;(list.root.querySelector('.changes-clear') as HTMLElement).click()
    const stages = [...list.root.querySelectorAll('.change-row')].map((r) => (r as HTMLElement).dataset.stage)
    expect(stages.sort()).toEqual(['failed', 'mismatch'])
  })

  it('the Clear done button is hidden while nothing is clearable', () => {
    const list = new ChangeList(new DraftStore(), noop)
    list.addSent('q1', [seed(tagged())])
    expect((list.root.querySelector('.changes-clear') as HTMLElement).hidden).toBe(true)
    list.applyStage({ requestId: 'q1', elIndex: 0, dcSource: null, stage: 'done' })
    expect((list.root.querySelector('.changes-clear') as HTMLElement).hidden).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/client/changelist.test.ts`
Expected: PASS if Task 7's implementation is complete; fix `changelist.ts` for any failure (the contract in these tests wins over Task 7's code).

- [ ] **Step 3: Commit**

```bash
git add packages/the-forge/src/client/changelist.ts packages/the-forge/tests/client/changelist.test.ts
git commit -m "test(client): lock ChangeList interaction contract (hover/select/dismiss/re-send/clear-done)"
```

---

### Task 9: DesignMode wiring — list construction, send seeding, re-send

**Files:**
- Modify: `packages/the-forge/src/client/index.ts`
- Test: `packages/the-forge/tests/client/design-mode.test.ts`

**Interfaces:**
- Consumes: `ChangeList`/`SentSeed` (Task 7), `Verifier.subscribe` (Task 5), `renderMarkdown`/`ChangeRequest` (existing), `readTheme` from `./tokens` (existing).
- Produces: `DesignMode` gains a private `changeList: ChangeList` mounted into `panel.changesSlot`, a private `sentSeeds = new Map<string, SentSeed[]>()` (the single owner of seed payloads — Task 10 persists from it), and a private `resend(seed: SentSeed): void`.

Wiring rules:
- Constructor: build `ChangeList` with callbacks `onHover` → `overlay.showOutline(el.getBoundingClientRect())` / `overlay.hideOutline()`, `onSelect` → `this.select(el)`, `onResend` → `this.resend(seed)`; append `this.changeList.root` to `this.panel.changesSlot`; `this.verifier.subscribe((e) => this.changeList.applyStage(e))`; extend the existing `drafts.onChange` handler to also call `this.changeList.syncDrafts()`.
- Send handler (`onSendOk`): build `seeds` from `pairs` (same data as the existing `mapping`), store in `sentSeeds`, call `this.changeList.addSent(id, seeds)`.
- `setActive(false)`: `this.changeList.clear()` and `this.sentSeeds.clear()` alongside the existing teardown (the session's story ends when design mode ends).
- `resend(seed)`: POST a fresh single-element request through the same queue → dispatch path as Send, register in `sent` + `sentSeeds` + `changeList`, start the verifier. Failure: flash the send button with `'Send failed'` (reuse `flashButton`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/design-mode.test.ts` (follow the file's existing DesignMode construction and fetch-stub patterns; it already builds `Overlay` + `DesignMode` in jsdom):

```ts
describe('change list wiring', () => {
  it('mounts the ChangeList inside the panel changes slot', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.attachPanel(mode.panelRoot)
    expect(mode.panelRoot.querySelector('.changes-section')).not.toBeNull()
  })

  it('seeds sent rows on a successful send and clears them on deactivate', async () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.attachPanel(mode.panelRoot)
    const el = document.createElement('div')
    el.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(el)
    mode.setActive(true)
    mode.select(el as never)
    // draft an edit, then click Send with a stubbed queue/dispatch
    ;(mode as never as { drafts: DraftStore }).drafts.apply(el as never, 'padding-top', '24px')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'q9', rung: 'manual' }) }))
    overlay.sendButton.click()
    await vi.waitFor(() => {
      expect(mode.panelRoot.querySelectorAll('.change-row').length).toBeGreaterThan(0)
    })
    expect(mode.panelRoot.querySelector('.chip-sent')).not.toBeNull()
    mode.setActive(false)
    mode.setActive(true)
    expect(mode.panelRoot.querySelectorAll('.change-row')).toHaveLength(0)
  })
})
```

(If the file runs fake timers globally, use its established async-flush helper instead of `vi.waitFor` — match the surrounding tests.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/design-mode.test.ts`
Expected: new tests FAIL (`.changes-section` missing); pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `src/client/index.ts`:

1. Imports:

```ts
import { ChangeList, type SentSeed } from './changelist'
import { readTheme } from './tokens'
```

(`resetTokensCache` is already imported from `./tokens` — merge into one import statement.)

2. Fields on `DesignMode`:

```ts
  private changeList: ChangeList
  /** Seed payloads per sent request id — the single owner ChangeList rows and (Task 10)
   * persistence read from; SentRegistry keeps only what verification needs. */
  private sentSeeds = new Map<string, SentSeed[]>()
```

3. In the constructor, after `this.verifier = new Verifier(...)`:

```ts
    this.changeList = new ChangeList(this.drafts, {
      onHover: (el) => (el ? this.overlay.showOutline(el.getBoundingClientRect()) : this.overlay.hideOutline()),
      onSelect: (el) => this.select(el),
      onResend: (seed) => this.resend(seed),
    })
    this.panel.changesSlot.appendChild(this.changeList.root)
    this.verifier.subscribe((e) => this.changeList.applyStage(e))
```

…and change the existing drafts hook at the bottom of the constructor to:

```ts
    this.drafts.onChange = () => {
      this.refreshStatus()
      this.changeList.syncDrafts()
    }
```

4. In `onSendOk` (send click handler), directly after `this.sent.add(id, mapping)`:

```ts
        const seeds: SentSeed[] = pairs.map(([el, change]) => ({
          el,
          dcSource: el.dataset.dcSource ?? null,
          draftProps: [...(this.drafts.entries().get(el)?.keys() ?? [])],
          change,
        }))
        this.sentSeeds.set(id, seeds)
        this.changeList.addSent(id, seeds)
```

(Note: `mapping` is built from the same pairs — leave it untouched; `draftProps` are read per structure to keep both paths identical.)

5. In `setActive`'s `else` branch (deactivation), alongside `this.verifier.stop()`:

```ts
      this.changeList.clear()
      this.sentSeeds.clear()
```

6. Add the `resend` method after `prepareSend`:

```ts
  /** Re-queues one failed element-change as a fresh request. Safe and unfiltered by design:
   * a failed apply changed no source, and failed items have already left the
   * sent-but-unverified set the duplicate filter checks. Reuses the queue → dispatch path
   * of Send; a dispatch failure degrades to manual copy exactly like Send does. */
  private resend(seed: SentSeed): void {
    const request: ChangeRequest = {
      createdAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      tailwind: readTheme().spacingBasePx !== null,
      elements: [seed.change],
    }
    const md = renderMarkdown(request)
    fetch('/__the-forge/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
      body: JSON.stringify({ request, markdown: md }),
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ id: string }>) : Promise.reject(new Error('queue failed'))))
      .then((body) => {
        this.sent.add(body.id, [
          {
            el: seed.el,
            dcSource: seed.dcSource,
            draftProps: seed.draftProps,
            changes: seed.change.changes.map((c) => ({ property: c.property, afterCss: c.afterCss })),
          },
        ])
        this.sentSeeds.set(body.id, [seed])
        this.changeList.addSent(body.id, [seed])
        this.verifier.start()
        fetch('/__the-forge/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
          body: JSON.stringify({}),
        }).catch(() => {
          /* request is safely queued — manual rung, same as Send */
        })
      })
      .catch(() => this.flashButton(this.overlay.sendButton, 'Send failed', 'Send to agent'))
  }
```

(`ChangeRequest` is already imported as a type in this file; `overlay` is the constructor's private field — reference as `this.overlay`, which requires changing the constructor parameter to `private overlay: Overlay` — it already is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/design-mode.test.ts tests/client/changelist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/index.ts packages/the-forge/tests/client/design-mode.test.ts
git commit -m "feat(client): wire ChangeList into DesignMode — send seeding, stage events, re-send"
```

---

### Task 10: Reload resilience — persist + restore

**Files:**
- Modify: `packages/the-forge/src/client/index.ts` (persist hooks + `restoreLifecycle` + boot()-time restore)
- Test: `packages/the-forge/tests/client/design-mode.test.ts`

**Interfaces:**
- Consumes: everything from Task 6 (`saveLifecycle`, `loadLifecycle`, `sourceIndex`, `locateBySource`, `PersistedLifecycle`), `sentSeeds` (Task 9).
- Produces: `DesignMode.restoreLifecycle(saved: PersistedLifecycle): void` (public — called from `boot()` and tests). Persist triggers: `setActive` (both directions), `setSelection`, the `drafts.onChange` handler, `onSendOk`, and every verifier stage event (registry contents changed). `boot()` performs at most ONE `loadLifecycle()` read; when `designModeOn` is false or nothing is stored, nothing else runs (zero idle overhead).

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/design-mode.test.ts`:

```ts
import { loadLifecycle, saveLifecycle, LIFECYCLE_KEY } from '../../src/client/lifecycle-store'

describe('lifecycle persistence', () => {
  beforeEach(() => sessionStorage.clear())

  it('persists design mode, drafts, and selection on change', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.attachPanel(mode.panelRoot)
    const el = document.createElement('div')
    el.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(el)
    mode.setActive(true)
    mode.select(el as never)
    ;(mode as never as { drafts: DraftStore }).drafts.apply(el as never, 'padding-top', '24px')
    const saved = loadLifecycle()
    expect(saved?.designModeOn).toBe(true)
    expect(saved?.selection).toEqual([{ dcSource: 'src/App.tsx:3:3', index: 0 }])
    expect(saved?.drafts).toEqual([{ dcSource: 'src/App.tsx:3:3', index: 0, props: [['padding-top', '24px']] }])
    mode.setActive(false)
    expect(loadLifecycle()?.designModeOn).toBe(false)
  })

  it('restoreLifecycle re-activates, re-applies drafts, re-arms the verifier, and re-selects', () => {
    document.body.innerHTML = `<div data-dc-source="src/App.tsx:3:3" id="target"></div>`
    const target = document.getElementById('target')!
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.attachPanel(mode.panelRoot)
    mode.restoreLifecycle({
      v: 1,
      designModeOn: true,
      selection: [{ dcSource: 'src/App.tsx:3:3', index: 0 }],
      drafts: [{ dcSource: 'src/App.tsx:3:3', index: 0, props: [['padding-top', '24px']] }],
      sent: [
        {
          id: 'q1',
          elements: [
            {
              dcSource: 'src/App.tsx:3:3',
              index: 0,
              tag: 'div',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: {
                tag: 'div',
                source: { file: 'src/App.tsx', line: 3, col: 3 },
                className: '',
                text: '',
                selector: 'div',
                changes: [{ property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: null, afterUtility: 'pt-6', tokenExact: true }],
              },
            },
          ],
        },
      ],
    })
    expect(mode.active).toBe(true)
    expect(target.style.getPropertyValue('padding-top')).toBe('24px') // draft preview re-applied
    expect(mode.selection).toHaveLength(1)
    expect(mode.sent.size()).toBe(1) // verifier re-armed against the restored registry
    expect(mode.panelRoot.querySelector('.chip-sent')).not.toBeNull()
  })

  it('a sent element that cannot be located gets a greyed row, not a crash', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.attachPanel(mode.panelRoot)
    mode.restoreLifecycle({
      v: 1,
      designModeOn: true,
      selection: [],
      drafts: [],
      sent: [
        {
          id: 'q1',
          elements: [
            {
              dcSource: 'gone.tsx:1:1',
              index: 0,
              tag: 'span',
              draftProps: [],
              changes: [{ property: 'color', afterCss: 'rgb(0, 0, 0)' }],
              change: { tag: 'span', source: { file: 'gone.tsx', line: 1, col: 1 }, className: '', text: '', selector: 'span', changes: [{ property: 'color', beforeCss: 'rgb(255, 255, 255)', afterCss: 'rgb(0, 0, 0)', beforeUtility: null, afterUtility: null, tokenExact: false }] },
            },
          ],
        },
      ],
    })
    const row = mode.panelRoot.querySelector('.change-row')!
    expect(row.className).toContain('row-gone')
  })

  it('boot restore is a no-op when design mode was off', () => {
    saveLifecycle({ v: 1, designModeOn: false, selection: [], drafts: [], sent: [] })
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.attachPanel(mode.panelRoot)
    const saved = loadLifecycle()
    if (saved?.designModeOn) mode.restoreLifecycle(saved) // mirrors boot()
    expect(mode.active).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/design-mode.test.ts`
Expected: new tests FAIL (`restoreLifecycle` not a function / nothing persisted).

- [ ] **Step 3: Implement**

In `src/client/index.ts`:

1. Imports:

```ts
import { saveLifecycle, loadLifecycle, sourceIndex, locateBySource, type PersistedLifecycle } from './lifecycle-store'
```

2. Add `persist()` to `DesignMode` (after `refreshStatus`):

```ts
  /** Serializes the full lifecycle to sessionStorage. Called only from state-change hooks
   * while the tool is in use — an ordinary page load with design mode off never writes.
   * Elements are addressed as (dcSource, index-among-matches) so list items sharing one
   * source location survive a reload individually (lifecycle-store.ts). */
  private persist(): void {
    const drafts: PersistedLifecycle['drafts'] = []
    for (const [el, props] of this.drafts.entries()) {
      const dcSource = (el as TaggedElement).dataset?.dcSource
      if (!dcSource) continue // untagged elements can't be re-located — preview-only, not persisted
      drafts.push({
        dcSource,
        index: sourceIndex(el as TaggedElement, dcSource),
        props: [...props.entries()].map(([p, d]) => [p, d.value] as [string, string]),
      })
    }
    const sent: PersistedLifecycle['sent'] = []
    for (const [id, seeds] of this.sentSeeds) {
      if (!this.sent.get(id)) continue // resolved — receipts are session-visual only, not persisted
      sent.push({
        id,
        elements: seeds.map((seed) => ({
          dcSource: seed.dcSource,
          index: seed.dcSource ? sourceIndex(seed.el, seed.dcSource) : 0,
          tag: seed.change.tag,
          draftProps: seed.draftProps,
          changes: seed.change.changes.map((c) => ({ property: c.property, afterCss: c.afterCss })),
          change: seed.change,
        })),
      })
    }
    saveLifecycle({
      v: 1,
      designModeOn: this.active,
      selection: this.selection.flatMap((el) => {
        const dcSource = el.dataset?.dcSource
        return dcSource ? [{ dcSource, index: sourceIndex(el, dcSource) }] : []
      }),
      drafts,
      sent,
    })
  }
```

3. Call `this.persist()` at the end of: `setActive` (after both branches), `setSelection`, the constructor's `drafts.onChange` handler, `onSendOk` (after `changeList.addSent`), and inside the verifier subscription:

```ts
    this.verifier.subscribe((e) => {
      this.changeList.applyStage(e)
      this.persist() // registry contents change on resolution — keep storage in step
    })
```

4. Add `restoreLifecycle` (public, after `setActive`):

```ts
  /** Rebuilds the session from a persisted lifecycle after a full page reload: re-activates
   * design mode, re-applies draft previews, re-registers in-flight requests (placeholder
   * elements stay detached so the verifier's locate() re-resolves them by dcSource on every
   * poll — self-healing when the DOM catches up), re-arms the verifier, and re-selects. */
  restoreLifecycle(saved: PersistedLifecycle): void {
    if (!saved.designModeOn) return
    this.setActive(true)
    for (const d of saved.drafts) {
      const el = locateBySource(d.dcSource, d.index)
      if (!el) continue
      for (const [prop, value] of d.props) this.drafts.apply(el, prop, value)
    }
    for (const s of saved.sent) {
      const seeds: SentSeed[] = s.elements.map((pe) => ({
        el: (pe.dcSource && locateBySource(pe.dcSource, pe.index)) || (document.createElement(pe.tag) as TaggedElement),
        dcSource: pe.dcSource,
        draftProps: pe.draftProps,
        change: pe.change,
      }))
      this.sent.add(
        s.id,
        seeds.map((seed, i) => ({ el: seed.el, dcSource: seed.dcSource, draftProps: seed.draftProps, changes: s.elements[i].changes }))
      )
      this.sentSeeds.set(s.id, seeds)
      this.changeList.addSent(s.id, seeds)
    }
    if (this.sent.size() > 0) this.verifier.start()
    const selected = saved.selection
      .map((sel) => locateBySource(sel.dcSource, sel.index))
      .filter((el): el is TaggedElement => el !== null)
    if (selected.length > 0) this.setSelection(selected)
    this.persist()
  }
```

5. In `boot()`, after `window.__THE_FORGE__ = { mode, secret, agent }`:

```ts
  // One synchronous sessionStorage read per page load — the only work done when design
  // mode was off (zero idle overhead). A stored active session survives full reloads:
  // some frameworks legitimately hard-reload (non-HMR-able edits), and losing every
  // draft/sent state to that was half of the original "panel closes on Send" trust bug.
  const saved = loadLifecycle()
  if (saved?.designModeOn) mode.restoreLifecycle(saved)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/design-mode.test.ts`
Expected: PASS — new AND pre-existing.

- [ ] **Step 5: Run the whole client suite for regressions**

Run: `npx vitest run tests/client/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/index.ts packages/the-forge/tests/client/design-mode.test.ts
git commit -m "feat(client): lifecycle persistence — drafts, sends, and design mode survive full reloads"
```

---

### Task 11: Full gate, real-browser E2E, docs

**Files:**
- Modify: `CLAUDE.md` (module table + install side-effects + gotcha)
- No source changes expected; fix regressions if the gate finds any.

- [ ] **Step 1: Root gate**

Run from the repo root: `npm test`
Expected: typecheck + full vitest suite PASS.

- [ ] **Step 2: Build + prod-clean + budget**

Run from the repo root: `npm run build && ./scripts/check-prod-clean.sh`
Expected: both PASS (client bundle grows — budget is 250KB; if exceeded, trim the ChangeList CSS/code, do not raise the budget).

- [ ] **Step 3: Real-browser E2E — the loop (jsdom cannot see computed styles)**

Kill stale dev servers first (`lsof -iTCP:5173 -sTCP:LISTEN`, also 5174/5175). After `npm run build`, RESTART any running demo server (Vite caches the virtual client module — reload is not enough). Then with `npm run dev -w demo-app`:

1. Toggle design mode → select an element → scrub padding → a **draft** row appears in the Changes section with a dashed chip.
2. Send to agent → the row flips to **sent** (gray chip); panel and selection stay put.
3. Simulate the agent: `curl` the pull/mark endpoints or run `/forge-design` in a session at the repo root; apply the edit to the fixture source; the row goes **applying** (amber pulse) → **done ✓** (green) after Fast Refresh/HMR, and the draft's inline style is committed away.
4. Mark a queued item `failed` with note `needs confirmation: test` → the row pins red with the note; Re-send and Dismiss both work.
5. Reload the page mid-flight (send, then reload before the agent applies) → design mode, panel, draft previews, and the sent row all come back; verification still resolves to done.

- [ ] **Step 4: Real-browser E2E — the root-cause regression**

In a scratch Vite + Tailwind v4 + React project (or the user's portfolio at `~/Developer/portfolio` with its `.gitignore` entry temporarily removed): fresh `theForge()` boot must write the `.gitignore` entry, and a Send must NOT full-reload the page (watch `window` state or the console for a reload). Restore any temporary edits afterward.

- [ ] **Step 5: Next fixture smoke**

`npm run dev -w next-demo` → the sidecar writes the same `.gitignore` entry at the repo root (idempotent — entry already exists here); the design-mode loop works; `npm run dev:webpack -w next-demo` boots with the webpack watchOptions exclude without warnings.

- [ ] **Step 6: Update CLAUDE.md**

- `src/client` module table: add rows for `changelist.ts` ("Changes lifecycle list: per-change rows draft → sent → applying → done/failed, re-send/dismiss") and `lifecycle-store.ts` ("sessionStorage persistence of drafts/sent/design-mode across full reloads").
- MCP contract "Install side-effects" bullet: add the `.gitignore` entry (`.the-forge/` at the git root) to the list of auto-written artifacts.
- Gotchas: add — "An unignored `.the-forge/` full-reloads Tailwind-v4 apps on every Send (the queue markdown is made of class names, so Tailwind's scanner tracks queue.json). The plugin now writes the `.gitignore` entry and watcher excludes itself; if a consumer still sees reload-on-send, check that `.gitignore` write didn't fail."

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: send-lifecycle modules, gitignore install side-effect, reload gotcha"
```

---

## Spec coverage check

| Spec section | Tasks |
| --- | --- |
| 1a Gitignore entry at install | 1 |
| 1b Watcher exclusion (Vite / webpack / Turbopack-accepted-untested) | 2, 3 |
| 2 Lifecycle model + verifier refactor (behavior-frozen summary) | 4, 5 |
| 3 Changes list UI (rows, chips, notes, interactions, panel placement, CSS) | 7, 8 |
| 3 Re-send path | 8 (contract), 9 (network) |
| 4 Reload resilience (storage, restore, placeholders, zero idle) | 6, 10 |
| 5 Edge cases (backoff unchanged, duplicate visible, stale-claim regression, multi-select rows) | 5, 7 |
| 6 Testing (unit mirrors src/, real-browser E2E incl. root-cause regression) | every task + 11 |

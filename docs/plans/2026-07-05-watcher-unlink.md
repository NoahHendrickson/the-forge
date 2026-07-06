# Watcher Unlink + Not-Linked State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an unlink ✕ to the overlay's watch indicator (stops the agent's `/forge-watch` loop from the browser) and an always-visible "○ Not linked" state so Send is never a surprise fallback.

**Architecture:** Extends the existing three-state watcher matrix (`live`/`asleep`/`none`) end to end: new `none` copy in the client's single copy home (`watch.ts`), a new secret-gated `POST /__the-forge/unwatch` endpoint calling a new `WatcherHub.unlink()`, and a new `unlinked` stop reason flowing through the MCP bin's canned-text table. Spec: [docs/specs/2026-07-05-watcher-unlink-design.md](../specs/2026-07-05-watcher-unlink-design.md).

**Tech Stack:** TypeScript, vitest (jsdom for client tests), zero new dependencies.

## Global Constraints

- Zero new runtime dependencies; the MCP server stays the hand-rolled JSON-RPC subset.
- All watcher copy lives in `src/client/watch.ts` (the one message-matrix home); the agent-facing stop text lives in `src/mcp/protocol.ts` and **never interpolates server data** (canned constants only, terse — per-tick token cost).
- New overlay buttons go through `src/client/ui/button.ts` (`createButton`) — never raw `document.createElement`. Stories in `packages/the-forge/stories/`.
- Panel/overlay CSS class names are test hooks — extend, don't rename. New hook: `watch-unlink`.
- Mutating endpoints require `X-Forge-Secret` — `/unwatch` joins `MUTATING_PATHS`.
- Why-comments are load-bearing — preserve verbatim when moving; revise (don't delete) the ones whose rationale this feature changes, citing the spec.
- Tests mirror `src/`; root `npm test` (typecheck + full vitest) is the gate.
- jsdom cannot prove overlay layout — Task 8's real-browser E2E is mandatory before merge.
- All commands below run from `packages/the-forge/` unless noted. Work happens on the current worktree branch (`claude/upbeat-dewdney-4fd84a`).

---

### Task 1: `watch.ts` — `none` copy row + `WatchIndicator` with `unlinkable`

**Files:**
- Modify: `src/client/watch.ts` (lines 17–62: matrix comment, `sentLabelFor`, `watchIndicatorFor`, `queuedLineFor`)
- Test: `tests/client/watch.test.ts` (describes at lines 135–200)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface WatchIndicator { text: string; live: boolean; unlinkable: boolean }`; `watchIndicatorFor(state: WatcherState, agent: AgentName): WatchIndicator` (no longer returns `undefined`). New `none` copy strings (exact strings below) used by Tasks 2 and 8.

- [ ] **Step 1: Update the existing copy-matrix tests to the new `none` behavior**

In `tests/client/watch.test.ts`, replace these existing expectations:

```ts
// REPLACE the it('manual rung with no watcher keeps the pre-watch-mode copy verbatim') body:
  it('manual rung with no watcher steers to /forge-watch (link CTA)', () => {
    expect(sentLabelFor('manual', 'claude-code')).toBe('Sent — queued. Type /forge-watch in Claude Code to link & apply')
    expect(sentLabelFor('manual', 'claude-code', 'none')).toBe(
      'Sent — queued. Type /forge-watch in Claude Code to link & apply'
    )
  })

// In it('unrecognized rungs still default to the manual family (allowlist regression)'),
// REPLACE the first expectation only (the 'asleep' one is unchanged):
    expect(sentLabelFor('totally-new-rung' as never, 'claude-code')).toBe(
      'Sent — queued. Type /forge-watch in Claude Code to link & apply'
    )

// In the queuedLineFor describe, REPLACE the 'none' expectation only:
    expect(queuedLineFor(1, 'Claude Code', 'none')).toBe('1 queued — type /forge-watch in Claude Code to link & apply')

// REPLACE the whole watchIndicatorFor describe:
describe('watchIndicatorFor', () => {
  it('live: linked pill with the live accent, unlinkable', () => {
    expect(watchIndicatorFor('live', 'claude-code')).toEqual({
      text: '● Linked to Claude Code',
      live: true,
      unlinkable: true,
    })
  })

  it('asleep: the wake instruction, not live-accented, dismissable', () => {
    expect(watchIndicatorFor('asleep', 'claude-code')).toEqual({
      text: 'Watcher asleep — type /forge-watch in Claude Code to wake it',
      live: false,
      unlinkable: true,
    })
  })

  it('none: the upfront not-linked hint (decision reversal — see 2026-07-05 spec), nothing to unlink', () => {
    expect(watchIndicatorFor('none', 'claude-code')).toEqual({
      text: '○ Not linked — type /forge-watch in Claude Code to link',
      live: false,
      unlinkable: false,
    })
  })
})
```

- [ ] **Step 2: Run the file — the changed expectations fail**

Run: `npx vitest run tests/client/watch.test.ts`
Expected: FAIL — old copy strings / `undefined` returned for `none`.

- [ ] **Step 3: Implement in `src/client/watch.ts`**

Replace the matrix banner comment (lines 17–25) with:

```ts
// ---------------------------------------------------------------------------
// Watcher copy — the ONE home for the live/asleep/none message matrix. The Send
// flash (sentLabelFor), the strip indicator (watchIndicatorFor), and the
// verifier's queued prefix (queuedLineFor) all encode the same rules: a live
// watcher means delivery (never an instruction to type), an asleep watcher
// means wake it with /forge-watch (the queued items deliver on wake — nothing
// is lost), and no watcher means the upfront "not linked" hint steering to
// /forge-watch (the 2026-07-05 watcher-unlink spec deliberately REVERSED the
// original "none renders nothing" rule — the user wants link state visible
// before Send, and /forge-watch as the one advertised flow). Keep all three
// here so the matrix can't drift across modules.
// ---------------------------------------------------------------------------
```

Replace `sentLabelFor`'s last line:

```ts
  return `Sent — queued. Type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to link & apply`
```

Replace `watchIndicatorFor` (and its doc comment) with:

```ts
export interface WatchIndicator {
  text: string
  live: boolean
  /** Whether the strip offers the unlink ✕ — live and asleep watchers can be
   * unlinked/dismissed; 'none' has nothing to unlink. */
  unlinkable: boolean
}

/** The persistent watch indicator's strip content per watcher state. Always returns an
 * indicator: 'none' renders the upfront not-linked hint (see the matrix comment above for
 * the recorded decision reversal), which also keeps the strip visible whenever design mode
 * is on. */
export function watchIndicatorFor(state: WatcherState, agent: AgentName): WatchIndicator {
  if (state === 'live') return { text: `● Linked to ${AGENT_DISPLAY_NAME[agent]}`, live: true, unlinkable: true }
  if (state === 'asleep')
    return {
      text: `Watcher asleep — type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to wake it`,
      live: false,
      unlinkable: true,
    }
  return { text: `○ Not linked — type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to link`, live: false, unlinkable: false }
}
```

Replace `queuedLineFor`'s last line:

```ts
  return `${count} queued — type /forge-watch in ${agentDisplayName} to link & apply`
```

- [ ] **Step 4: Run the file test, then typecheck**

Run: `npx vitest run tests/client/watch.test.ts` — Expected: PASS.
Run: `npm run typecheck -w the-forge` (from repo root) — Expected: clean. (`watchIndicatorFor`'s non-optional return is still assignable to `updateStatus`'s optional `watch` param; extra `unlinkable` prop is fine structurally until Task 2 consumes it.)

- [ ] **Step 5: Commit**

```bash
git add src/client/watch.ts tests/client/watch.test.ts
git commit -m "feat(client): none-state watcher copy — not-linked hint, /forge-watch CTA"
```

---

### Task 2: Overlay — unlink ✕ button + always-visible strip

**Files:**
- Modify: `src/client/overlay.ts` (CSS string near `#watch` rules ~line 86; class fields ~line 449; constructor ~line 475; `updateStatus` ~line 604)
- Test: `tests/client/overlay.test.ts`

**Interfaces:**
- Consumes: shape `{ text: string; live: boolean; unlinkable?: boolean }` (Task 1's `WatchIndicator` is assignable).
- Produces: `Overlay.unlinkButton: HTMLButtonElement` (public field, class `watch-unlink`) — Task 6 wires its click. `updateStatus`'s 4th param type widened to `watch?: { text: string; live: boolean; unlinkable?: boolean }`.

- [ ] **Step 1: Write failing tests** (append to `tests/client/overlay.test.ts`, inside the existing top-level describe, matching the file's `new Overlay()` style):

```ts
  it('updateStatus keeps the strip visible with zero drafts when a watch indicator is present (not-linked upfront)', () => {
    const overlay = new Overlay()
    overlay.updateStatus(0, false, undefined, { text: '○ Not linked — type /forge-watch in Claude Code to link', live: false, unlinkable: false })
    expect(overlay.status.hidden).toBe(false)
  })

  it('unlink ✕ is shown for unlinkable states and hidden for none', () => {
    const overlay = new Overlay()
    expect(overlay.unlinkButton.className).toContain('watch-unlink')
    overlay.updateStatus(0, false, undefined, { text: '● Linked to Claude Code', live: true, unlinkable: true })
    expect(overlay.unlinkButton.hidden).toBe(false)
    overlay.updateStatus(0, false, undefined, { text: '○ Not linked — type /forge-watch in Claude Code to link', live: false, unlinkable: false })
    expect(overlay.unlinkButton.hidden).toBe(true)
    overlay.updateStatus(1, false)
    expect(overlay.unlinkButton.hidden).toBe(true)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/client/overlay.test.ts`
Expected: FAIL — `unlinkButton` undefined.

- [ ] **Step 3: Implement in `src/client/overlay.ts`**

CSS — insert directly after the `#watch.live` rule (line 87):

```
#status button.watch-unlink { background: none; color: var(--watch-idle); padding: 4px 6px; }
#status button.watch-unlink:hover { background: var(--control); color: var(--text-primary); }
```

Class field — after `resetAllButton` (line 442):

```ts
  unlinkButton = createButton({ label: '✕', title: 'Unlink watcher session', className: 'watch-unlink' })
```

Constructor — hidden by default, appended right after the watch label (the ✕ belongs to the indicator it acts on). Replace the `this.status.append(...)` line (479):

```ts
    this.unlinkButton.hidden = true
    this.status.append(this.watchLabel, this.unlinkButton, this.statusLabel, this.sendButton, this.copyButton, this.compareAllButton, this.resetAllButton, this.sentLabel)
```

`updateStatus` — widen the signature and drive the ✕. Replace the signature (line 604) and the strip-visibility comment (605–609), and add the unlink line after the `watchLabel` updates (628):

```ts
  updateStatus(draftCount: number, comparingAll: boolean, sentText?: string, watch?: { text: string; live: boolean; unlinkable?: boolean }): void {
    // Strip is visible when there are drafts OR a non-empty summary OR a watch indicator.
    // Since the 2026-07-05 watcher-unlink spec, watchIndicatorFor always returns an
    // indicator (the 'none' state renders the upfront "not linked" hint — a deliberate
    // reversal of the original zero-UI-change rule), so in practice the strip is visible
    // whenever design mode is on. `watch` stays optional so callers without watch state
    // (tests, panel-only flows) keep today's hide-when-empty behavior.
```

```ts
    // Unlink ✕: only when the indicator says there is a watcher to unlink/dismiss.
    this.unlinkButton.hidden = watch?.unlinkable !== true
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/client/overlay.test.ts tests/client/watch.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/overlay.ts tests/client/overlay.test.ts
git commit -m "feat(client): watch-unlink button + always-visible link-state strip"
```

---

### Task 3: `WatcherHub.unlink()` + `unlinked` stop reason

**Files:**
- Modify: `src/server/watchers.ts` (`WaitResponse` line 20; fields ~line 76; `wait()` entry ~line 106; new method after `notify()`)
- Test: `tests/server/watchers.test.ts` (uses the existing `makeHub()` helper — `holdMs: 30`, injected clock)

**Interfaces:**
- Consumes: existing hub internals (`parked`, `watching`, `everWatched`, `replacedToken`, `settle`).
- Produces: `WatcherHub.unlink(): void`; `WaitResponse` stop reason union becomes `'idle' | 'replaced' | 'unlinked'`. Task 4 calls `unlink()`; Task 5 recognizes `'unlinked'` over the wire.

- [ ] **Step 1: Write failing tests** (append a describe to `tests/server/watchers.test.ts`):

```ts
describe('unlink (browser ✕ — 2026-07-05 watcher-unlink spec)', () => {
  it('settles a parked waiter with {stop, unlinked} and resets state to none', async () => {
    const { hub } = makeHub()
    const { promise } = hub.wait('tok-a')
    hub.unlink()
    await expect(promise).resolves.toEqual({ stop: true, reason: 'unlinked' })
    expect(hub.state()).toBe('none')
  })

  it('a parked-unlinked token re-arms cleanly on its next wait (trusted like the idle stop)', async () => {
    const { hub } = makeHub()
    const first = hub.wait('tok-a')
    hub.unlink()
    await first.promise
    const second = hub.wait('tok-a') // deliberate /forge-watch re-run
    expect(hub.state()).toBe('live')
    second.cancel()
  })

  it('denies the NEXT wait of a live-but-not-parked watcher once, then re-arms (mid-apply / between cycles)', async () => {
    const { hub, setApplying } = makeHub()
    const first = hub.wait('tok-a')
    await first.promise // hold expires (holdMs 30) — between cycles now
    setApplying(true)
    expect(hub.state()).toBe('live') // mid-apply liveness
    hub.unlink()
    expect(hub.state()).toBe('none')
    await expect(hub.wait('tok-a').promise).resolves.toEqual({ stop: true, reason: 'unlinked' }) // one-shot denial
    const rearm = hub.wait('tok-a') // wait after the denial is a deliberate re-run
    expect(hub.state()).toBe('live')
    rearm.cancel()
  })

  it('dismisses an asleep watcher back to none without denying its next wait', async () => {
    const { hub, advance } = makeHub()
    const first = hub.wait('tok-a')
    first.cancel() // bin vanished — watching flips off
    advance(6_000) // past freshMs (5s)
    expect(hub.state()).toBe('asleep')
    hub.unlink()
    expect(hub.state()).toBe('none')
    const rearm = hub.wait('tok-a')
    expect(hub.state()).toBe('live') // no one-shot stop for a dismissed-asleep token
    rearm.cancel()
  })

  it('is a no-op when nothing ever watched', () => {
    const { hub } = makeHub()
    hub.unlink()
    expect(hub.state()).toBe('none')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/server/watchers.test.ts`
Expected: FAIL — `hub.unlink is not a function`.

- [ ] **Step 3: Implement in `src/server/watchers.ts`**

`WaitResponse` (line 20):

```ts
export type WaitResponse =
  | { stop: true; reason: 'idle' | 'replaced' | 'unlinked' }
  | { stop: false; items: QueueItem[] }
```

New fields next to `replacedToken` (~line 79):

```ts
  /** Last token seen at wait entry — who to deny when unlink() finds nothing parked. */
  private lastToken: string | null = null
  /** One-shot: the token whose next wait gets {stop,'unlinked'} because unlink() had no
   * parked response to deliver the stop through (between cycles / mid-apply). */
  private unlinkedToken: string | null = null
```

At the very top of `wait()` (before the `replacedToken` block — unlink is the newer, more specific denial):

```ts
    // One-shot unlink denial: the browser unlinked while this loop was between cycles or
    // mid-apply, so no response could carry the stop — this wait IS that response. Consumed
    // immediately: the wait after this one is by definition the user deliberately re-running
    // /forge-watch, which must re-arm normally.
    if (token !== undefined && token === this.unlinkedToken) {
      this.unlinkedToken = null
      return { promise: Promise.resolve({ stop: true, reason: 'unlinked' }), cancel: () => {} }
    }
```

Record the token — insert immediately after the `this.lastSeen = nowMs` line (~138):

```ts
    if (token !== undefined) this.lastToken = token
```

New method after `notify()`:

```ts
  /** Browser-initiated stop (POST /__the-forge/unwatch — the strip's ✕). Ends a live loop,
   * dismisses an asleep one, and resets the hub to 'none' so every polling browser converges
   * on the not-linked indicator. Never touches the queue: claimed items finish applying and
   * mark normally; pending items deliver to whoever links next. */
  unlink(): void {
    if (this.parked) {
      // Parked: the loop hears this stop directly through its in-flight /wait — same trust
      // model as the idle stop, so no token denial (one would bounce a legitimate later
      // /forge-watch re-run from this same session exactly once — worse than trusting it).
      const waiter = this.parked
      this.parked = null
      this.settle(waiter, { stop: true, reason: 'unlinked' })
    } else if (this.watching && this.lastToken !== null) {
      // Live but not parked (between cycles / mid-apply): nothing can carry the stop, so
      // deny that token's NEXT wait instead — without this, flipping `watching` off would
      // make its next /wait read as a legitimate /forge-watch re-arm and silently re-link.
      // A tokenless legacy bin can't be denied and re-arms on its next wait (accepted —
      // same advisory-only degradation as replacedToken's tokenless fallback).
      this.unlinkedToken = this.lastToken
    }
    this.watching = false
    this.everWatched = false
    this.replacedToken = null
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/server/watchers.test.ts` — Expected: PASS (new + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/server/watchers.ts tests/server/watchers.test.ts
git commit -m "feat(server): WatcherHub.unlink — direct stop when parked, one-shot token denial otherwise"
```

---

### Task 4: `POST /__the-forge/unwatch` endpoint

**Files:**
- Modify: `src/server/endpoints.ts` (`MUTATING_PATHS` line 116; new handler after the `/wait` block ending line 270)
- Test: `tests/server/endpoints.test.ts` (uses existing `fakeReq(method, path, body, headers)` / `fakeRes()` / `run(mw, req, res)` helpers and the `SECRET` constant)

**Interfaces:**
- Consumes: `WatcherHub.unlink(): void`, `WatcherHub.state(): WatcherState` (Task 3). Hub injectable as `createForgeMiddleware`'s 5th param.
- Produces: `POST /__the-forge/unwatch` → 200 `{ watcher: 'none' }` (secret-gated, 405 on GET). Task 6's client calls it.

- [ ] **Step 1: Write failing tests** (append a describe, following the file's existing secret-test pattern at lines 314–345):

```ts
describe('POST /__the-forge/unwatch', () => {
  it('rejects GET with 405', async () => {
    const res = fakeRes()
    await run(mw, fakeReq('GET', '/__the-forge/unwatch', undefined, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('requires the secret when one is configured', async () => {
    const secured = createForgeMiddleware(queue, [], SECRET)
    const res = fakeRes()
    await run(secured, fakeReq('POST', '/__the-forge/unwatch', {}, { host: 'localhost:5173' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('unlinks a parked watcher: its /wait resolves {stop, unlinked} and /status reports none', async () => {
    const hub = new WatcherHub({ claim: () => queue.pull() })
    const mwWithHub = createForgeMiddleware(queue, [], SECRET, { agent: 'claude-code', channelsFlag: false }, hub)
    const { promise } = hub.wait('tok-e2e')
    const res = fakeRes()
    await run(
      mwWithHub,
      fakeReq('POST', '/__the-forge/unwatch', {}, { host: 'localhost:5173', 'x-forge-secret': SECRET }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ watcher: 'none' })
    await expect(promise).resolves.toEqual({ stop: true, reason: 'unlinked' })
    const statusRes = fakeRes()
    await run(mwWithHub, fakeReq('GET', '/__the-forge/status?ids=', undefined, { host: 'localhost:5173' }), statusRes)
    expect(JSON.parse(statusRes.body).watcher).toBe('none')
  })
})
```

(Add `WatcherHub` to the file's existing dynamic imports alongside `createForgeMiddleware` if not already imported: `const { WatcherHub } = await import('../../src/server/watchers')`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/server/endpoints.test.ts`
Expected: FAIL — unwatch route 404s (`unknown forge endpoint`).

- [ ] **Step 3: Implement in `src/server/endpoints.ts`**

Add to `MUTATING_PATHS` (line 116):

```ts
  '/__the-forge/unwatch',
```

New handler after the `/wait` block (line 270):

```ts
    if (pathname === '/__the-forge/unwatch') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      // The strip's ✕ (2026-07-05 watcher-unlink spec). No body — the hub knows its own
      // watcher. Returns the post-unlink state so the client can render without re-polling.
      watcherHub.unlink()
      return send(res, 200, { watcher: watcherHub.state() })
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/server/endpoints.test.ts tests/server/watchers.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/endpoints.ts tests/server/endpoints.test.ts
git commit -m "feat(server): POST /__the-forge/unwatch — secret-gated browser unlink"
```

---

### Task 5: MCP — `unlinked` canned stop text + bin reason mapping

**Files:**
- Modify: `src/mcp/protocol.ts` (`WaitOutcome` line 14; `WAIT_STOP_TEXTS` line 71)
- Modify: `src/mcp/index.ts` (reason mapping line 109)
- Test: `tests/mcp/protocol.test.ts` (uses existing `backend()` + `waitCallText(be)` helpers)

**Interfaces:**
- Consumes: HTTP `{ stop: true, reason: 'unlinked' }` from Task 4's server.
- Produces: agent-facing canned text for `unlinked`; bin recognizes `'unlinked'`, still degrades unknown reasons to `'idle'`.

- [ ] **Step 1: Write failing test** (append to the wait-loop describe in `tests/mcp/protocol.test.ts`):

```ts
  it('stop/unlinked tells the agent the user unlinked from the panel', async () => {
    const text = await waitCallText(backend({ wait: async () => ({ kind: 'stop', reason: 'unlinked' }) }))
    expect(text).toBe(
      'Watching stopped — the user unlinked this session from the design panel. Run /forge-watch to re-link if asked. Do not call wait_for_design_edits again unless the user asks.'
    )
  })
```

(If the file's `backend()` helper doesn't take overrides, follow whatever pattern its existing `stop`/`replaced` tests use — the assertion string is the contract.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mcp/protocol.test.ts`
Expected: FAIL — type error / undefined text for reason `'unlinked'`.

- [ ] **Step 3: Implement**

`src/mcp/protocol.ts` — widen the union (line 14):

```ts
  | { kind: 'stop'; reason: 'idle' | 'replaced' | 'no-server' | 'unlinked' }
```

Add to `WAIT_STOP_TEXTS` (line 71 — update the Record key union too):

```ts
const WAIT_STOP_TEXTS: Record<'idle' | 'replaced' | 'no-server' | 'unlinked', string> = {
  ...existing three entries unchanged...
  unlinked:
    'Watching stopped — the user unlinked this session from the design panel. Run /forge-watch to re-link if asked. Do not call wait_for_design_edits again unless the user asks.',
}
```

`src/mcp/index.ts` — replace the reason mapping (line 109), keeping the unknown→idle comment's intent:

```ts
        // Unknown reason values (a newer server?) degrade to 'idle' — its text is the safe
        // one: watching paused, /forge-watch to resume.
        const reason = data.reason === 'replaced' || data.reason === 'unlinked' ? data.reason : 'idle'
        return { kind: 'stop', reason }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mcp/protocol.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/protocol.ts src/mcp/index.ts tests/mcp/protocol.test.ts
git commit -m "feat(mcp): unlinked stop reason — canned text + bin mapping"
```

---

### Task 6: Client wiring — ✕ click → POST `/unwatch` → immediate re-poll

**Files:**
- Modify: `src/client/index.ts` (new listener after the `copyButton` listener block, ~line 210)
- Test: `tests/client/design-mode.test.ts` (uses existing `fullSetup()` helper; real timers)

**Interfaces:**
- Consumes: `Overlay.unlinkButton` (Task 2), `POST /__the-forge/unwatch` (Task 4), existing `forgeSecretHeaders()` (index.ts:31) and `this.watch` (`WatchStatus`).
- Produces: end-user behavior only.

- [ ] **Step 1: Write failing test** (append to `tests/client/design-mode.test.ts`):

```ts
describe('watcher unlink wiring', () => {
  it('✕ POSTs /unwatch with the secret header, then re-polls watcher state immediately', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__ = { secret: 's3cret', agent: 'claude-code' }
    try {
      const { overlay, mode } = fullSetup()
      mode.setActive(true) // watch poller only runs while design mode is on
      overlay.unlinkButton.click()
      await new Promise((r) => setTimeout(r, 5)) // fetch .then chain + the re-poll's 0ms timer
      expect(fetchMock).toHaveBeenCalledWith('/__the-forge/unwatch', {
        method: 'POST',
        headers: { 'X-Forge-Secret': 's3cret' },
      })
      // Re-poll: at least one status probe AFTER the unwatch call (setActive fired the first).
      const calls = fetchMock.mock.calls.map((c) => c[0])
      const unwatchIndex = calls.indexOf('/__the-forge/unwatch')
      expect(calls.slice(unwatchIndex + 1)).toContain('/__the-forge/status?ids=')
    } finally {
      delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/client/design-mode.test.ts`
Expected: FAIL — no fetch to `/__the-forge/unwatch` (button has no listener).

- [ ] **Step 3: Implement in `src/client/index.ts`** — add after the `copyButton` listener block:

```ts
    overlay.unlinkButton.addEventListener('click', () => {
      // The strip's ✕ (2026-07-05 watcher-unlink spec): stop the linked /forge-watch loop
      // (or dismiss the asleep hint) server-side. Fire-and-forget with a same-shape catch —
      // a failed unlink leaves the indicator as-is and the next 5s poll re-syncs anyway.
      void fetch('/__the-forge/unwatch', { method: 'POST', headers: forgeSecretHeaders() })
        .then((res) => {
          if (!res.ok || !this.active) return
          // Immediate re-poll instead of waiting out WATCH_POLL_MS: stop() resets the cached
          // state to 'none' and start() probes on a 0ms tick, so the strip flips to
          // "Not linked" right away and the server confirms within the same tick.
          this.watch.stop()
          this.watch.start()
          this.refreshStatus()
        })
        .catch(() => {})
    })
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/client/design-mode.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/index.ts tests/client/design-mode.test.ts
git commit -m "feat(client): wire watch-unlink ✕ to POST /unwatch with immediate re-poll"
```

---

### Task 7: Storybook story for the unlink button

**Files:**
- Modify: `stories/button.stories.ts`

**Interfaces:** none — visual catalog only (convention: stories render the real controls).

- [ ] **Step 1: Add the story** (after `CopyForAgent`, mirroring its pattern):

```ts
// #status strip watch-unlink ✕ — stops the linked /forge-watch session (overlay.ts).
export const WatchUnlink: Story = {
  render: () => mountInShadow(createButton({ label: '✕', title: 'Unlink watcher session', className: 'watch-unlink' }), 'status'),
}
```

- [ ] **Step 2: Verify Storybook builds** (fastest check that the story compiles):

Run (repo root): `npm run storybook -w the-forge -- --smoke-test` — Expected: exits 0. (If the smoke-test flag is unsupported by this Storybook version, `npx vitest run tests/client/ui.test.ts` plus a visual check in Task 8 suffices.)

- [ ] **Step 3: Commit**

```bash
git add stories/button.stories.ts
git commit -m "docs(stories): watch-unlink button story"
```

---

### Task 8: Docs, full gate, real-browser E2E

**Files:**
- Modify: `CLAUDE.md` (repo root — MCP contract bullets)
- No src changes expected; fixes discovered here fold back into the owning task's files.

- [ ] **Step 1: Update CLAUDE.md's MCP contract**

In the `wait_for_design_edits` bullet, extend the stop list: "…the server tells the loop to stop after 20 idle minutes (idle auto-stop), on preemption by another watch session, when the user unlinks it from the overlay's watch indicator (`POST /__the-forge/unwatch`), or when no dev server is found."
In the Auth bullet, add `/unwatch` to the mutating-endpoints list.

- [ ] **Step 2: Full gate** (repo root)

Run: `npm test`
Expected: typecheck clean, full vitest suite green (was 1209 tests across 44 files before this feature; now higher).

- [ ] **Step 3: Rebuild and restart the demo server**

Run (repo root): `npm run build`
Then restart the running demo dev server — Vite caches the virtual client module, so a browser reload alone serves the OLD bundle (CLAUDE.md gotcha). Check for stale servers first: `lsof -iTCP:5173`.

- [ ] **Step 4: Real-browser E2E checklist** (demo app at `http://localhost:5173/`, jsdom rule — mandatory before merge)

1. Toggle design mode on with no watcher → strip shows `○ Not linked — type /forge-watch in Claude Code to link`, no ✕.
2. Start a watch loop (a real `/forge-watch`, or curl the `/wait` endpoint with the endpoint file's secret and an `X-Forge-Watcher: test-token` header in a loop) → strip flips to `● Linked to Claude Code` with ✕ within ~5s.
3. Click ✕ → strip flips to Not linked immediately; the parked `/wait` returns `{"stop":true,"reason":"unlinked"}`.
4. Re-arm the watch loop → strip re-links (no lingering denial).
5. With nothing linked, edit an element and Send → flash reads `Sent — queued. Type /forge-watch in Claude Code to link & apply`; item lands in `.the-forge/queue.json`.
6. Unlink while the "watcher" is between cycles (kill the curl loop, unlink, then curl `/wait` once with the same token) → that wait returns `{"stop":true,"reason":"unlinked"}`; the next one re-arms.

- [ ] **Step 5: Prod-clean gate + commit docs**

Run (repo root): `./scripts/check-prod-clean.sh` — Expected: all gates pass (client-only strings don't ship in prod output).

```bash
git add CLAUDE.md
git commit -m "docs: record unwatch endpoint + unlinked stop reason in agent guide"
```

---

## Self-review notes

- **Spec coverage:** §1 UI → Tasks 1/2/6; §2 server → Tasks 3/4; §3 copy → Tasks 1/5; §4 edges → encoded in Task 3's trust-model comments and Task 6's failure handling; §5 tests → each task's test steps + Task 8 E2E. Decision-reversal recording → comments in Tasks 1/2 + CLAUDE.md in Task 8.
- **Type consistency:** `WatchIndicator` (Task 1) is consumed structurally by Task 2's widened `updateStatus` param; `unlink(): void` (Task 3) consumed by Task 4; reason literal `'unlinked'` is identical across Tasks 3/4/5.
- **Ordering:** 1→2→6 (client chain), 3→4 (server chain), 5 anytime after 3; 7 after 2; 8 last. Tasks 3–5 are independent of 1–2 and can interleave.

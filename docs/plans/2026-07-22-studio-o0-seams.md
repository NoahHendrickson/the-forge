# Studio O0 — Seams Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the transport seam and split `src/client/index.ts`'s chat wiring into `chat-wiring.ts` — zero behavior change — so the studio shell (O1) can re-host the chat surface against a hub transport.

**Architecture:** A `ForgeTransport` interface (base URL + lazy secret headers + get/post/postJson) becomes the single way client modules reach the runtime's HTTP surface; today's default instance reproduces current behavior exactly (relative URLs, `globalThis.__THE_FORGE__` secret, global `fetch` at call time). The chat cluster construction (SessionFeed + ComposerSend + ChangeList + their endpoint hookups) moves from the `DesignMode` constructor into a `buildChatWiring()` factory parameterized on the transport and a `ChatHostHooks` interface; `DesignMode` keeps the host-coupled halves (selection, drafts leg, ripple, verifier plumbing) and supplies the hooks.

**Tech Stack:** TypeScript, vitest + jsdom (existing suites), tsup build. No new dependencies (hard constraint).

**Spec:** [docs/specs/2026-07-22-studio-o0-o1-design.md](../specs/2026-07-22-studio-o0-o1-design.md) §3. Work happens on branch `feat/studio-o0-seams` cut from `idea/orchestrator-pivot`.

## Global Constraints

- Zero new runtime dependencies; zero behavior change (this is a pure seams refactor).
- Existing test files change **imports only** — no assertion edits. New behavior gets new test files.
- Budgets unchanged: 320KB package, 250KB `dist/client.js` (`./scripts/check-prod-clean.sh` must pass).
- Why-comments are load-bearing — when moving code, move its comments verbatim.
- Overlay/panel CSS class names are test hooks — none change in this plan.
- All commands run from repo root unless noted; single test files run from `packages/the-forge/`.
- TS class-field gotcha this plan works around: parameter properties assign in the ctor body, so a **field initializer must not read a ctor param** — Task 3 moves the `watch`/`feed` initializers into the ctor body for exactly this reason.

---

### Task 1: `transport.ts` — the ForgeTransport seam

**Files:**
- Create: `packages/the-forge/src/client/transport.ts`
- Test: `packages/the-forge/tests/client/transport.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; reads `globalThis.__THE_FORGE__` and global `fetch`).
- Produces: `interface ForgeTransport { base: string; secretHeaders(): Record<string,string>; get(path: string): Promise<Response>; post(path: string): Promise<Response>; postJson(path: string, body?: unknown): Promise<Response> }`, `function forgeSecretHeaders(): Record<string,string>` (moved verbatim from index.ts), `function createTransport(base?: string, secretHeaders?: () => Record<string,string>): ForgeTransport`. Tasks 2–5 depend on these exact names.

- [ ] **Step 1: Write the failing test**

```ts
// packages/the-forge/tests/client/transport.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTransport, forgeSecretHeaders } from '../../src/client/transport'

describe('createTransport', () => {
  const realFetch = globalThis.fetch
  let calls: Array<{ input: string; init?: RequestInit }>
  beforeEach(() => {
    calls = []
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      return Promise.resolve(new Response('{}'))
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
  })

  it('get() prefixes base and sends no headers', async () => {
    const t = createTransport('http://localhost:4610/p/abc')
    await t.get('/__the-forge/status?ids=')
    expect(calls[0].input).toBe('http://localhost:4610/p/abc/__the-forge/status?ids=')
    expect(calls[0].init).toBeUndefined()
  })

  it('default base is empty — current relative-URL behavior', async () => {
    await createTransport().get('/__the-forge/status?ids=')
    expect(calls[0].input).toBe('/__the-forge/status?ids=')
  })

  it('postJson() sends JSON body, content-type, and lazily-read secret', async () => {
    const t = createTransport()
    // secret set AFTER construction — must still be picked up (lazy read per request)
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 's3cr3t' }
    await t.postJson('/__the-forge/queue', { a: 1 })
    const init = calls[0].init!
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Forge-Secret']).toBe('s3cr3t')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.body).toBe('{"a":1}')
  })

  it('post() sends secret headers and no body', async () => {
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 's' }
    await createTransport().post('/__the-forge/unwatch')
    const init = calls[0].init!
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Forge-Secret']).toBe('s')
    expect(init.body).toBeUndefined()
  })

  it('custom secretHeaders override the global read', async () => {
    const t = createTransport('', () => ({ 'X-Forge-Secret': 'hub' }))
    await t.post('/x')
    expect((calls[0].init!.headers as Record<string, string>)['X-Forge-Secret']).toBe('hub')
  })

  it('forgeSecretHeaders returns {} with no bootstrap present', () => {
    expect(forgeSecretHeaders()).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/the-forge/`): `npx vitest run tests/client/transport.test.ts`
Expected: FAIL — `Cannot find module '../../src/client/transport'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/the-forge/src/client/transport.ts
/** ForgeTransport — the ONE seam between client UI modules and a forge runtime's HTTP
 * surface (O0 seams pass, docs/specs/2026-07-22-studio-o0-o1-design.md §3.1). Today every
 * consumer talks to the same-origin dev-server runtime: base '' (relative URLs) and the
 * bootstrap-injected secret. The studio shell (O1) constructs one per project with an
 * absolute `/p/<id>`-prefixed base and a hub-delivered secret instead — no consumer changes.
 * Global `fetch` is read at CALL time (not captured at construction) so tests that stub
 * globalThis.fetch keep working unchanged. */
export interface ForgeTransport {
  /** Prefix prepended to every path ('' today; 'http://localhost:<hub>/p/<id>' in the shell). */
  base: string
  /** Auth headers, read lazily per request — see forgeSecretHeaders below for why lazy. */
  secretHeaders(): Record<string, string>
  /** GET returning the raw Response — callers keep their own res.ok/.json handling. */
  get(path: string): Promise<Response>
  /** Bodyless POST with secret headers (interrupt/unwatch shape). */
  post(path: string): Promise<Response>
  /** JSON POST with secret headers (queue/dispatch/config/decide/say shape). */
  postJson(path: string, body?: unknown): Promise<Response>
}

/** Belt-and-braces against cross-origin/DNS-rebinding bypasses of the server's Origin/Host
 * checks — same-origin page scripts are the user's own app and not the adversary. The secret
 * is injected by the server into `globalThis.__THE_FORGE__` (see index.ts load()); read it
 * lazily on each send so a value set after this module first evaluates is still picked up. */
export function forgeSecretHeaders(): Record<string, string> {
  const secret = (globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__?.secret
  return secret ? { 'X-Forge-Secret': secret } : {}
}

export function createTransport(
  base = '',
  secretHeaders: () => Record<string, string> = forgeSecretHeaders
): ForgeTransport {
  return {
    base,
    secretHeaders,
    get: (path) => fetch(base + path),
    post: (path) => fetch(base + path, { method: 'POST', headers: secretHeaders() }),
    postJson: (path, body) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...secretHeaders() },
        body: JSON.stringify(body),
      }),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/transport.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/transport.ts packages/the-forge/tests/client/transport.test.ts
git commit -m "feat(client): ForgeTransport seam — base-URL + lazy-secret HTTP surface (O0)"
```

---

### Task 2: Inject the transport into WatchStatus and Verifier

**Files:**
- Modify: `packages/the-forge/src/client/watch.ts:225` (the `fetch(` call in `poll()`) and the `WatchStatus` constructor (~line 151)
- Modify: `packages/the-forge/src/client/verifier.ts:235` (the `fetch(` call in `poll()`) and the `Verifier` constructor (~line 193)
- Test: `packages/the-forge/tests/client/transport-injection.test.ts` (new; existing `watch.test.ts`/`verifier.test.ts` stay untouched — the default transport delegates to global fetch, which is what they stub)

**Interfaces:**
- Consumes: `ForgeTransport`, `createTransport` from Task 1.
- Produces: `WatchStatus` constructor gains a 4th optional param `transport: ForgeTransport = createTransport()`; `Verifier` constructor gains a 4th optional param `transport: ForgeTransport = createTransport()`. Task 3 passes both explicitly.

- [ ] **Step 1: Write the failing test**

```ts
// packages/the-forge/tests/client/transport-injection.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WatchStatus } from '../../src/client/watch'
import { Verifier } from '../../src/client/verifier'
import { LifecycleSession } from '../../src/client/lifecycle'
import { DraftStore } from '../../src/client/drafts'
import type { ForgeTransport } from '../../src/client/transport'

function recordingTransport(): { transport: ForgeTransport; gets: string[] } {
  const gets: string[] = []
  const transport: ForgeTransport = {
    base: 'http://hub/p/x',
    secretHeaders: () => ({}),
    get: (path) => {
      gets.push(path)
      return Promise.resolve(new Response(JSON.stringify({ items: [], watcher: 'none' })))
    },
    post: () => Promise.resolve(new Response('{}')),
    postJson: () => Promise.resolve(new Response('{}')),
  }
  return { transport, gets }
}

describe('transport injection', () => {
  it('WatchStatus polls through the injected transport', async () => {
    vi.useFakeTimers()
    const { transport, gets } = recordingTransport()
    const ws = new WatchStatus(() => {}, undefined, undefined, transport)
    ws.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(gets).toEqual(['/__the-forge/status?ids='])
    ws.stop()
    vi.useRealTimers()
  })

  it('Verifier polls through the injected transport', async () => {
    vi.useFakeTimers()
    const { transport, gets } = recordingTransport()
    const session = new LifecycleSession()
    const v = new Verifier(session, new DraftStore(), () => {}, transport)
    // one registered entry so start() arms the poll loop
    session.register('req-1', [])
    v.start()
    await vi.advanceTimersByTimeAsync(2001)
    expect(gets[0]).toBe('/__the-forge/status?ids=req-1')
    v.stop()
    vi.useRealTimers()
  })
})
```

Note for the implementer: check `LifecycleSession.register`'s real signature in `src/client/lifecycle.ts` before running — if registering with an empty seeds array leaves `pendingIds()` empty (making the verifier stop before fetching), register one minimal seed instead, copying the seed shape used in `tests/client/verifier.test.ts`. The assertion that matters is the `gets[0]` path string.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/transport-injection.test.ts`
Expected: FAIL — constructors don't accept a 4th argument / `fetch` is not stubbed (network error), depending on evaluation order. Either failure is the red state.

- [ ] **Step 3: Modify watch.ts**

Add the import at the top:

```ts
import { createTransport, type ForgeTransport } from './transport'
```

Extend the constructor (keep the existing three params and their doc comments verbatim; add the 4th):

```ts
  constructor(
    private onChange: (state: WatcherState) => void,
    private onSessionChange?: (s: SessionState) => void,
    /** (existing onTick doc comment stays verbatim) */
    private onTick?: () => void,
    /** O0 seam: how this poller reaches the runtime — defaults to today's relative-URL
     * same-origin transport, so existing call sites and tests are unchanged. */
    private transport: ForgeTransport = createTransport()
  ) {}
```

In `poll()` replace exactly:

```ts
    fetch('/__the-forge/status?ids=')
```

with:

```ts
    this.transport.get('/__the-forge/status?ids=')
```

- [ ] **Step 4: Modify verifier.ts**

Add the same import; extend the constructor:

```ts
  constructor(
    private sent: SentStore,
    private drafts: DraftStore,
    private onUpdate: (summary: string) => void,
    /** O0 seam: same default-transport pattern as WatchStatus. */
    private transport: ForgeTransport = createTransport()
  ) {}
```

In `poll()` replace exactly:

```ts
    fetch(`/__the-forge/status?ids=${ids.join(',')}`)
```

with:

```ts
    this.transport.get(`/__the-forge/status?ids=${ids.join(',')}`)
```

- [ ] **Step 5: Run the new test and both existing suites**

Run: `npx vitest run tests/client/transport-injection.test.ts tests/client/watch.test.ts tests/client/verifier.test.ts`
Expected: PASS all — existing suites pass **unchanged** because the default transport still hits global `fetch` at call time.

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/watch.ts packages/the-forge/src/client/verifier.ts packages/the-forge/tests/client/transport-injection.test.ts
git commit -m "refactor(client): WatchStatus/Verifier poll via injected ForgeTransport (O0)"
```

---

### Task 3: index.ts adopts the transport for every endpoint call

**Files:**
- Modify: `packages/the-forge/src/client/index.ts` (imports; fields ~114–125; constructor ~194–263; `queueRequest` ~434; `postDispatch` ~455; `postJson` ~468; unwatch handler ~301)

**Interfaces:**
- Consumes: `createTransport`, `forgeSecretHeaders`, `ForgeTransport` from Task 1 (note: `forgeSecretHeaders` now lives in transport.ts — index.ts's local copy is DELETED).
- Produces: `DesignMode` gains a 5th optional ctor param `transport?: ForgeTransport`; all `/__the-forge/*` fetches in index.ts route through `this.transport`. Task 4's `buildChatWiring` receives this same instance.

- [ ] **Step 1: Update imports and delete the local helper**

In `index.ts`, delete the whole `forgeSecretHeaders` function (lines 37–44 including its doc comment — the comment moved verbatim into transport.ts in Task 1) and add:

```ts
import { createTransport, type ForgeTransport } from './transport'
```

- [ ] **Step 2: Convert `watch`/`feed` field initializers to ctor-body assignments**

The `watch` (line 114) and `feed` (line 121) field initializers must become ctor-body assignments — field initializers run before parameter properties assign, so they cannot read the new `transport` param (Global Constraints note). Replace the two initializers with bare declarations, keeping their doc comments in place:

```ts
  /** (existing watch doc comment stays verbatim) */
  private watch: WatchStatus
  /** (existing feed doc comment stays verbatim) */
  private feed: SessionFeed
```

Extend the constructor signature:

```ts
  constructor(
    private overlay: Overlay,
    panel?: Panel,
    drafts?: DraftStore,
    dock?: Dock,
    transport?: ForgeTransport
  ) {
```

and at the TOP of the ctor body (before anything reads them):

```ts
    this.transport = transport ?? createTransport()
    this.watch = new WatchStatus(
      () => this.refreshStatus(),
      () => this.refreshStatus(),
      () => this.refreshStatus(),
      this.transport
    )
    this.feed = new SessionFeed({ headers: this.transport.secretHeaders })
```

plus the field declaration near the other privates:

```ts
  private transport: ForgeTransport
```

- [ ] **Step 3: Route every endpoint call through the transport**

Apply these mechanical replacements, keeping every surrounding comment and `.then/.catch` chain byte-identical (the send tests count microtask ticks — do not flatten chains):

1. Verifier construction (~line 194): `new Verifier(this.session, this.drafts, (summary) => {...})` → add 4th arg `this.transport` after the callback.
2. `feed.onInterrupt` (~222): body becomes `void this.transport.post('/__the-forge/session/interrupt').catch(() => {})`
3. `feed.onDecide` (~226): body becomes `void this.transport.postJson('/__the-forge/approval/decide', { id, allow }).catch(() => {})`
4. `feed.onConfig` (~247): the fetch becomes `this.transport.postJson('/__the-forge/session/config', cfg)` — the `.then(res => { if (!res.ok) this.feed.revertConfig() }).catch(...)` chain and its comment stay verbatim.
5. unwatch handler (~305): `void fetch('/__the-forge/unwatch', { method: 'POST', headers: forgeSecretHeaders() })` → `void this.transport.post('/__the-forge/unwatch')` — the `.then` chain below it stays verbatim.
6. `queueRequest` (~434): the `fetch('/__the-forge/queue', {...})` call becomes `this.transport.postJson('/__the-forge/queue', { request, markdown })` — nested `.then` shape stays.
7. `postDispatch` (~455): becomes `this.transport.postJson('/__the-forge/dispatch', {})` — chain stays.
8. `postJson` private method (~468): body becomes `return this.transport.postJson(path, body)` (keep the method and its doc comment — ComposerSend's injection point is unchanged in this task).

- [ ] **Step 4: Typecheck and run the full client suite**

Run: `npm run typecheck -w forge-mode && npx vitest run tests/client/`
Expected: PASS — zero assertion edits anywhere. If `design-mode.test.ts` fails on fetch-call counts or tick timing, the chains were altered — restore the exact `.then` nesting.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/index.ts
git commit -m "refactor(client): DesignMode routes all endpoint calls through ForgeTransport (O0)"
```

---

### Task 4: Extract `chat-wiring.ts`

**Files:**
- Create: `packages/the-forge/src/client/chat-wiring.ts`
- Modify: `packages/the-forge/src/client/index.ts` (constructor ~202–263: ChangeList/feed-mount/ComposerSend/handler block moves out)
- Test: `packages/the-forge/tests/client/chat-wiring.test.ts`

**Interfaces:**
- Consumes: `ForgeTransport` (Task 1); `SessionFeed`/`SessionFeedOpts` (`session-feed.ts`); `ComposerSend` (`composer-send.ts`); `ChangeList` (`changelist.ts`); `DraftStore`; `LifecycleSession`; `SentSeed` (`lifecycle.ts`); `TaggedElement` (`source.ts`).
- Produces (Task 5 of O1 will re-consume in the shell):

```ts
export interface ChatHostHooks {
  sendDraftsLeg(): Promise<boolean>
  hasDrafts(): boolean
  chatAvailable(): boolean
  onChangeHover(el: TaggedElement | null): void
  onChangeSelect(el: TaggedElement): void
  onResend(seed: SentSeed): void
}
export interface ChatWiring { feed: SessionFeed; composerSend: ComposerSend; changeList: ChangeList }
export function buildChatWiring(
  transport: ForgeTransport,
  drafts: DraftStore,
  session: LifecycleSession,
  hooks: ChatHostHooks,
  feedOpts?: SessionFeedOpts
): ChatWiring
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/the-forge/tests/client/chat-wiring.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildChatWiring, type ChatHostHooks } from '../../src/client/chat-wiring'
import { DraftStore } from '../../src/client/drafts'
import { LifecycleSession } from '../../src/client/lifecycle'
import type { ForgeTransport } from '../../src/client/transport'

function noopHooks(): ChatHostHooks {
  return {
    sendDraftsLeg: () => Promise.resolve(true),
    hasDrafts: () => false,
    chatAvailable: () => true,
    onChangeHover: () => {},
    onChangeSelect: () => {},
    onResend: () => {},
  }
}

function recordingTransport(res: Response = new Response('{}')): {
  transport: ForgeTransport
  posts: Array<{ path: string; body: unknown }>
} {
  const posts: Array<{ path: string; body: unknown }> = []
  return {
    posts,
    transport: {
      base: '',
      secretHeaders: () => ({}),
      get: () => Promise.resolve(res.clone()),
      post: (path) => {
        posts.push({ path, body: undefined })
        return Promise.resolve(res.clone())
      },
      postJson: (path, body) => {
        posts.push({ path, body })
        return Promise.resolve(res.clone())
      },
    },
  }
}

describe('buildChatWiring', () => {
  it('mounts the ChangeList inside the feed draft disclosure', () => {
    const { transport } = recordingTransport()
    const w = buildChatWiring(transport, new DraftStore(), new LifecycleSession(), noopHooks())
    expect(w.changeList.root.parentElement).toBe(w.feed.draftSlot)
  })

  it('wires onDecide to POST /approval/decide through the transport', () => {
    const { transport, posts } = recordingTransport()
    const w = buildChatWiring(transport, new DraftStore(), new LifecycleSession(), noopHooks())
    w.feed.onDecide('ap-1', true)
    expect(posts).toEqual([{ path: '/__the-forge/approval/decide', body: { id: 'ap-1', allow: true } }])
  })

  it('wires onInterrupt to POST /session/interrupt', () => {
    const { transport, posts } = recordingTransport()
    const w = buildChatWiring(transport, new DraftStore(), new LifecycleSession(), noopHooks())
    w.feed.onInterrupt()
    expect(posts).toEqual([{ path: '/__the-forge/session/interrupt', body: undefined }])
  })

  it('reverts the config pickers on a non-ok /session/config response', async () => {
    const { transport } = recordingTransport(new Response('busy', { status: 409 }))
    const w = buildChatWiring(transport, new DraftStore(), new LifecycleSession(), noopHooks())
    const revert = vi.spyOn(w.feed, 'revertConfig')
    w.feed.onConfig({ harness: 'claude-code' })
    await vi.waitFor(() => expect(revert).toHaveBeenCalledOnce())
  })

  it('routes feed.onSend through ComposerSend', () => {
    const { transport } = recordingTransport()
    const w = buildChatWiring(transport, new DraftStore(), new LifecycleSession(), noopHooks())
    const send = vi.spyOn(w.composerSend, 'send')
    w.feed.onSend()
    expect(send).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/chat-wiring.test.ts`
Expected: FAIL — `Cannot find module '../../src/client/chat-wiring'`

- [ ] **Step 3: Create chat-wiring.ts**

Move the chat-cluster block out of `DesignMode`'s constructor. Every comment in the moved block travels verbatim (they're marked in index.ts today between lines ~202 and ~263). The module:

```ts
// packages/the-forge/src/client/chat-wiring.ts
import { SessionFeed, type SessionFeedOpts } from './session-feed'
import { ComposerSend } from './composer-send'
import { ChangeList } from './changelist'
import type { DraftStore } from './drafts'
import type { LifecycleSession, SentSeed } from './lifecycle'
import type { TaggedElement } from './source'
import type { ForgeTransport } from './transport'

/** The ~15 host callbacks the chat cluster needs from whoever hosts it (O0 seams pass,
 * spec §3.2). In the overlay, DesignMode supplies live implementations (drafts leg,
 * outline hover, selection); the studio shell (O1) supplies no-op/host-appropriate ones.
 * This interface — not a DesignMode reference — is the whole boundary, so the cluster
 * can be constructed without a host document. */
export interface ChatHostHooks {
  /** DesignMode#sendDrafts — see ComposerSendOpts#sendDraftsLeg's doc for the contract. */
  sendDraftsLeg(): Promise<boolean>
  /** drafts.elementCount() > 0 at gesture time. */
  hasDrafts(): boolean
  /** watch.sessionEnabled() !== false at gesture time. */
  chatAvailable(): boolean
  /** ChangeList row hover — host shows/hides the element outline (null = hide). */
  onChangeHover(el: TaggedElement | null): void
  /** ChangeList row click — host selects the element. */
  onChangeSelect(el: TaggedElement): void
  /** ChangeList Re-send — host re-queues the seed (DesignMode#resend). */
  onResend(seed: SentSeed): void
}

export interface ChatWiring {
  feed: SessionFeed
  composerSend: ComposerSend
  changeList: ChangeList
}

/** Builds the chat cluster — SessionFeed + ComposerSend + ChangeList — and wires every
 * endpoint hookup through the given transport. Extracted verbatim from DesignMode's
 * constructor (O0): behavior is identical; the only new degree of freedom is WHICH
 * transport and WHICH hooks arrive. */
export function buildChatWiring(
  transport: ForgeTransport,
  drafts: DraftStore,
  session: LifecycleSession,
  hooks: ChatHostHooks,
  feedOpts?: SessionFeedOpts
): ChatWiring {
  const feed = new SessionFeed({ headers: transport.secretHeaders, ...feedOpts })
  const changeList = new ChangeList(drafts, session, {
    onHover: (el) => hooks.onChangeHover(el),
    onSelect: (el) => hooks.onChangeSelect(el),
    onResend: (seed) => hooks.onResend(seed),
  })
  // (move the "ChangeList now mounts inside the SessionFeed's own drafts disclosure…"
  // comment from index.ts here verbatim)
  feed.draftSlot.appendChild(changeList.root)
  // (move the onInterrupt fire-and-forget comment verbatim)
  feed.onInterrupt = () => {
    void transport.post('/__the-forge/session/interrupt').catch(() => {})
  }
  feed.onDecide = (id: string, allow: boolean) => {
    void transport.postJson('/__the-forge/approval/decide', { id, allow }).catch(() => {})
  }
  // (move the ComposerSend construction comment verbatim)
  const composerSend = new ComposerSend({
    feed,
    postJson: (path, body) => transport.postJson(path, body),
    sendDraftsLeg: () => hooks.sendDraftsLeg(),
    hasDrafts: () => hooks.hasDrafts(),
    chatAvailable: () => hooks.chatAvailable(),
  })
  feed.onSend = () => composerSend.send()
  feed.onConfig = (cfg) => {
    void transport
      .postJson('/__the-forge/session/config', cfg)
      .then((res) => {
        // (move the revertConfig rationale comment verbatim)
        if (!res.ok) feed.revertConfig()
      })
      .catch(() => feed.revertConfig())
  }
  return { feed, composerSend, changeList }
}
```

Exactness notes for the implementer: (a) the moved comments are load-bearing — copy them from index.ts, don't paraphrase; (b) `ChangeList`'s real constructor signature is at `changelist.ts:64` — mirror its option names (`onHover`/`onSelect`/`onResend`) exactly as index.ts passes them today; (c) `SessionFeedOpts` spread order `{ headers: transport.secretHeaders, ...feedOpts }` lets tests inject `fetchFn` while the transport supplies headers.

- [ ] **Step 4: Rewire DesignMode's constructor**

In `index.ts`, replace the moved block (ChangeList construction ~202, draftSlot mount ~210, onInterrupt ~222, onDecide ~226, ComposerSend ~239, `feed.onSend` ~246, `feed.onConfig` ~247–263) with:

```ts
    const wiring = buildChatWiring(this.transport, this.drafts, this.session, {
      sendDraftsLeg: () => this.sendDrafts(),
      hasDrafts: () => this.drafts.elementCount() > 0,
      chatAvailable: () => this.watch.sessionEnabled() !== false,
      onChangeHover: (el) => (el ? this.overlay.showOutline(el.getBoundingClientRect()) : this.overlay.hideOutline()),
      onChangeSelect: (el) => this.select(el),
      onResend: (seed) => this.resend(seed),
    })
    this.feed = wiring.feed
    this.composerSend = wiring.composerSend
    this.changeList = wiring.changeList
    this.panel.feedSlot.appendChild(this.feed.root)
```

Ordering constraints: this block needs `this.transport`, `this.drafts`, `this.session`, `this.watch` already assigned (Task 3 put transport/watch at the ctor top) and must run before `this.session.onChange(...)` / `this.verifier.subscribe(...)` register (they reference `this.changeList`). Delete the Task-3-era `this.feed = new SessionFeed(...)` line from the ctor top — the feed now comes from the wiring. Keep `this.panel.feedSlot.appendChild(this.feed.root)` host-side (the panel is host-coupled; the wiring must stay mountable anywhere). Remove now-unused imports (`SessionFeed`, `ComposerSend`, `ChangeList` if no other references remain); the `private postJson` method on DesignMode is now dead — delete it (its doc comment described the ComposerSend injection, which moved).

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck -w forge-mode && npx vitest run tests/`
Expected: PASS everything — `design-mode.test.ts`, `composer-send.test.ts`, `changelist.test.ts`, `session-feed.test.ts` all unchanged and green.

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/chat-wiring.ts packages/the-forge/src/client/index.ts packages/the-forge/tests/client/chat-wiring.test.ts
git commit -m "refactor(client): extract buildChatWiring — chat cluster behind ChatHostHooks (O0)"
```

---

### Task 5: Gates, docs, and E2E smoke

**Files:**
- Modify: `CLAUDE.md` (src/client module table: add `transport.ts` and `chat-wiring.ts` rows)
- No source changes — verification only.

- [ ] **Step 1: Full root gate**

Run: `npm test`
Expected: typecheck + full vitest suite PASS (2114+ tests).

- [ ] **Step 2: Build + budgets**

Run: `npm run build && env -u FORCE_COLOR ./scripts/check-prod-clean.sh`
Expected: PASS, package ≤320KB, `dist/client.js` ≤250KB (this refactor adds ~1KB of interface plumbing; if the client budget trips, the extraction duplicated code instead of moving it — diff for leftover copies).

- [ ] **Step 3: Real-browser E2E smoke**

Start `npm run dev -w demo-app` (kill any stale server on 5173 first: `lsof -iTCP:5173`). In the browser: toggle Design on → click an element → scrub padding → press ↑ in the composer → verify the draft row appears in the drafts pill disclosure, the send reaches `.the-forge/queue.json`, and the composer/chat surface behaves as before (chip, placeholder, config pickers render). This is the "byte-identical overlay behavior" gate from spec §3.5 — jsdom can't prove it.

- [ ] **Step 4: Update CLAUDE.md module table**

Add two rows to the `### src/client modules` table:

```markdown
| `transport.ts` | `ForgeTransport` — the one seam to a runtime's HTTP surface (base URL + lazy secret headers + get/post/postJson); `createTransport()` reproduces today's same-origin behavior, the studio shell passes a hub-prefixed one (O0 seams pass) |
| `chat-wiring.ts` | `buildChatWiring` — constructs the chat cluster (SessionFeed + ComposerSend + ChangeList) against a `ForgeTransport` + `ChatHostHooks`; DesignMode supplies live host hooks, the studio shell (O1) supplies its own (O0 seams pass) |
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md module table — transport.ts + chat-wiring.ts (O0 seams)"
```

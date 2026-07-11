import fs from 'node:fs'
import path from 'node:path'
import type { SessionAdapter, SessionEvent } from './adapter'
import { type HarnessId, EMBEDDED_HARNESSES, HARNESS_VOCAB } from '../../shared/chat-constants'

// ---------------------------------------------------------------------------
// Exported types and constants
// ---------------------------------------------------------------------------

export type SessionState = 'idle' | 'starting' | 'ready' | 'busy' | 'failed'

export interface FeedEvent {
  seq: number
  at: string
  event: SessionEvent
}

/** No stdout event for this long while busy → kill + respawn + re-pull. */
export const WATCHDOG_MS = 120_000

/** Watchdog leash used right after the user ALLOWS a gated tool. An approved Bash command
 * (build, test suite) emits nothing on stdout until its tool_result, so the normal leash
 * would kill the session mid-command and the recovery pull would re-run the same command —
 * an approval → kill → re-approve loop. Ten minutes covers realistic builds while still
 * catching a genuinely hung CLI (#53584). */
export const POST_APPROVAL_WATCHDOG_MS = 600_000

/** Max events retained in the ring buffer. */
export const RING_CAPACITY = 200

/** Consecutive ended-before-started crashes tolerated before giving up (state → failed).
 * A child that keeps dying pre-init (broken install, corrupted state) must not respawn
 * forever; a later Send retries with a fresh budget. Reset on every successful `started`. */
export const MAX_START_FAILURES = 3

/** The one constant turn ever sent in milestone A. Per-tick token-cost rule: terse, zero
 * interpolation — request content never travels through the turn text (same rule as the
 * canned watch texts in src/mcp/protocol.ts). */
export const PULL_TURN_TEXT: string =
  'New design edits are queued. Call the the-forge MCP tool pull_design_edits, apply each request exactly as written, then call mark_applied. An edit needing the user\'s confirmation (e.g. a shared component rendered elsewhere) is "failed" with note "needs confirmation: <reason>". Do not run the app, take screenshots, or preview the result.'

/** Max chat turns parked while busy/starting. A single slot suffices for the pull nudge
 * (pull claims everything), but chat is free-form user text — unbounded queueing would let
 * a fast-typing user pile up an unbounded backlog the CLI has to work through one at a time.
 * 20 is generous headroom for a burst of quick messages without being unbounded. */
export const CHAT_QUEUE_CAP = 20

/** say() result — queue-full is the only rejection (composing/sending never fails locally). */
export type SayResult = { ok: true } | { ok: false; reason: 'queue-full' }

/** setConfig() result — effort changes while a turn is live are rejected rather than killing
 * it; the endpoint turns this into a 409 so the caller can retry once the turn completes. */
export type SetConfigResult = { ok: true } | { ok: false; reason: 'busy' }

/** Pre-validated by the endpoint — the element the user had selected when they sent a chat
 * message, rendered as a trailing line in the composed turn text. */
export interface ElementRef {
  source: string
  tag: string
}

export interface SessionManagerOpts {
  /** Injectable factory — tests pass a fake, production passes (opts) => new
   * ClaudeAdapter(undefined, opts). `opts.effort` threads the spike-confirmed spawn-flag-only
   * effort level (see ClaudeAdapter's constructor why-comment) into each fresh spawn.
   * `opts.harness` (Task 2, C1) is REQUIRED — every spawn is FOR a specific harness, never
   * ambiguous; Task 4's factory keys off it to construct a ClaudeAdapter vs a CodexAdapter. */
  makeAdapter: (opts: { harness: HarnessId; effort?: string }) => SessionAdapter
  /** .the-forge/ dir — session.json home. Created lazily (mkdirSync recursive). */
  forgeDir: string
  /** resolveProjectRoot() — child process cwd. */
  cwd: string
  /** From the plugin's `agent` option; 'claude-code' when absent. Only takes effect when
   * session.json has no (valid) persisted `selected` — see harness() below. */
  defaultHarness?: HarnessId
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number
  /** Watchdog timeout override for tests (real default: WATCHDOG_MS). */
  watchdogMs?: number
  /** Post-approval leash override for tests (real default: POST_APPROVAL_WATCHDOG_MS). */
  postApprovalWatchdogMs?: number
}

// ---------------------------------------------------------------------------
// session.json shape
//
// { "selected": "codex", "sessions": { "claude-code": {sessionId, updatedAt},
//   "codex": {sessionId, updatedAt} } } — one slot per embedded harness, so switching
// harnesses (setConfig({harness})) never clobbers the OTHER harness's resume id. Legacy
// flat `{sessionId, updatedAt}` files (pre-Task-2) are read as the claude-code slot with no
// `selected` — one-release read-compat; the first write migrates the file to this shape.
// ---------------------------------------------------------------------------

interface SessionSlot {
  sessionId: string
  updatedAt: string
}

interface SessionFile {
  selected?: HarnessId
  sessions: Partial<Record<HarnessId, SessionSlot>>
}

function isHarnessId(v: unknown): v is HarnessId {
  return typeof v === 'string' && (EMBEDDED_HARNESSES as readonly string[]).includes(v)
}

function isSessionSlot(v: unknown): v is SessionSlot {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).sessionId === 'string'
}

/** Reads the whole file and normalizes it to the current shape, migrating the legacy flat
 * form in memory (the on-disk file itself is only rewritten on the next actual write).
 * Corrupt/missing → fresh `{sessions: {}}`, never throw — unchanged posture from the
 * pre-Task-2 single-slot reader. */
function readSessionFile(forgeDir: string): SessionFile {
  try {
    const raw = fs.readFileSync(path.join(forgeDir, 'session.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { sessions: {} }
    const obj = parsed as Record<string, unknown>

    // Legacy shape: a bare {sessionId, updatedAt} pair, always the claude-code slot (Task 2
    // is the first release with more than one embedded harness).
    if (typeof obj['sessionId'] === 'string') {
      const updatedAt = typeof obj['updatedAt'] === 'string' ? obj['updatedAt'] : ''
      return { sessions: { 'claude-code': { sessionId: obj['sessionId'], updatedAt } } }
    }

    const sessions: Partial<Record<HarnessId, SessionSlot>> = {}
    const rawSessions = obj['sessions']
    if (typeof rawSessions === 'object' && rawSessions !== null) {
      for (const h of EMBEDDED_HARNESSES) {
        const slot = (rawSessions as Record<string, unknown>)[h]
        if (isSessionSlot(slot)) sessions[h] = slot
      }
    }
    // Unknown persisted `selected` (a newer build's harness read by an older one) is
    // dropped here — the caller falls back to opts.defaultHarness, never throws.
    const selected = isHarnessId(obj['selected']) ? obj['selected'] : undefined
    return { selected, sessions }
  } catch {
    return { sessions: {} }
  }
}

function readSlot(forgeDir: string, harness: HarnessId): SessionSlot | undefined {
  return readSessionFile(forgeDir).sessions[harness]
}

function readSelectedHarness(forgeDir: string): HarnessId | undefined {
  return readSessionFile(forgeDir).selected
}

/** Stale-resume retry needs to drop only the CURRENT harness's slot — the other harness's
 * resume id (from a session that was never touched this run) must survive untouched. */
function clearSessionSlot(forgeDir: string, harness: HarnessId): void {
  try {
    const current = readSessionFile(forgeDir)
    if (!(harness in current.sessions)) return // nothing to clear
    delete current.sessions[harness]
    fs.mkdirSync(forgeDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(forgeDir, 'session.json'), JSON.stringify(current), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Best-effort — a stale file that survives only re-triggers the fresh-retry path.
  }
}

function writeSessionSlot(forgeDir: string, harness: HarnessId, sessionId: string, updatedAt: string): void {
  try {
    // forgeDir may not exist yet (mirrors writeEndpointFile in src/server/endpoints.ts,
    // including the owner-only 0700/0600 perms — see the why-comment there).
    fs.mkdirSync(forgeDir, { recursive: true, mode: 0o700 })
    const current = readSessionFile(forgeDir)
    current.sessions[harness] = { sessionId, updatedAt }
    fs.writeFileSync(path.join(forgeDir, 'session.json'), JSON.stringify(current), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // I/O failure is non-fatal — resume just won't work next time.
  }
}

/** setConfig({harness}) persists the switch here — a read-modify-write so an in-flight
 * harness's session slot is never disturbed by a selection change alone. */
function writeSelectedHarness(forgeDir: string, harness: HarnessId): void {
  try {
    fs.mkdirSync(forgeDir, { recursive: true, mode: 0o700 })
    const current = readSessionFile(forgeDir)
    current.selected = harness
    fs.writeFileSync(path.join(forgeDir, 'session.json'), JSON.stringify(current), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // I/O failure is non-fatal — the in-memory selection (this._harness) still wins for the
    // rest of this process; only a restart would silently forget the choice.
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private _state: SessionState = 'idle'
  private _opts: SessionManagerOpts
  private _clock: () => number
  private _watchdogMs: number
  private _postApprovalWatchdogMs: number
  // Resolved ONCE at construction (see harness()'s doc comment below) — every _start()/
  // _respawn() and every session.json slot read/write keys off this, never re-resolved.
  private _harness: HarnessId

  // Count of approvals parked in the overlay. While > 0 the watchdog is fully suspended —
  // a human deciding is not a hung CLI. The ApprovalRegistry's own hold timer guarantees
  // every request eventually resolves (allow/deny/timeout), so the count always converges.
  private _pendingApprovals = 0

  // The live adapter (non-null while starting/ready/busy).
  private _adapter: SessionAdapter | null = null
  // Last sessionId seen from the adapter (persisted to session.json).
  private _lastSessionId: string | undefined = undefined
  // The resumeId the CURRENT start attempt was launched with (undefined = fresh start).
  // Distinguishes "stale resume id rejected in-band" (retry fresh) from a fresh start
  // failing the same way (park in failed — retrying fresh again would loop).
  private _lastStartResumeId: string | undefined = undefined
  // Whether the CURRENT spawn ever emitted `started`. The turn is written before init
  // arrives (lazy-boot CLI), so state alone can't distinguish "failed during boot" from
  // "failed mid-turn" — error/crash handling keys on this instead of state==='starting'.
  private _sawStarted = false
  // Consecutive ended-before-started crashes; reset on started, capped by MAX_START_FAILURES.
  private _startFailures = 0

  // Single-slot pending nudge. True = one PULL_TURN_TEXT is queued to be
  // sent on the next turn-complete or on started. A single slot is sufficient
  // because pull_design_edits claims ALL pending queue items — N Sends need
  // at most one follow-up pull turn.
  private _nudgePending = false

  // FIFO of composed chat turns parked while busy/starting (say(), CHAT_QUEUE_CAP-bounded).
  // A plain field, deliberately untouched by _start()/_respawn() — it survives a respawn
  // (watchdog fire, ended-while-busy, stale-resume retry); only stop() clears it.
  private _chatQueue: string[] = []

  // The exact turn text most recently written to the adapter's stdin. Recovery paths
  // (watchdog fire, ended-while-busy, stale-resume retry) re-send THIS, not always
  // PULL_TURN_TEXT — a chat turn that dies mid-flight must come back as itself, or a
  // user's message silently turns into an unrelated pull nudge on the retry.
  private _inflightTurn: string = PULL_TURN_TEXT

  // The --effort level threaded into every future makeAdapter() call. Set by setConfig();
  // consumed by _start()/_respawn(). Effort has no control-request on the CLI (spike,
  // Task 1) — it's spawn-flag-only, so this is the ONLY way an effort change takes hold.
  private _spawnEffort: string | undefined = undefined

  // Last model/permissionMode applied via setConfig() (final-review fix 2) — re-applied to
  // every fresh adapter on its `started` event. Unlike effort, model/permissionMode are live
  // control-request writes with no spawn flag, so a respawned child (watchdog fire,
  // ended-while-busy, stale-resume retry — anywhere `--permission-mode default` is pinned in
  // spawn args) otherwise silently reverts to defaults while the UI keeps showing the user's
  // last choice. Cleared only by stop() — a respawn must inherit them, a fresh session must not.
  private _lastSetModel: string | undefined = undefined
  private _lastSetPermissionMode: string | undefined = undefined

  // Ring buffer: fixed-capacity circular store.
  private _ring: FeedEvent[] = []
  private _seq = 0

  // Subscribers for live event fan-out.
  private _subscribers: Set<(e: FeedEvent) => void> = new Set()

  // Watchdog timer handle (armed only while busy).
  private _watchdog: ReturnType<typeof setTimeout> | null = null

  constructor(opts: SessionManagerOpts) {
    this._opts = opts
    this._clock = opts.now ?? (() => Date.now())
    this._watchdogMs = opts.watchdogMs ?? WATCHDOG_MS
    this._postApprovalWatchdogMs = opts.postApprovalWatchdogMs ?? POST_APPROVAL_WATCHDOG_MS
    // session.json's persisted `selected` wins over the plugin's `agent` option default —
    // an unrecognized value (a newer build's harness read by an older one) is already
    // filtered out by readSessionFile, so this never throws on a future/unknown id.
    this._harness = readSelectedHarness(opts.forgeDir) ?? opts.defaultHarness ?? 'claude-code'
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  state(): SessionState {
    return this._state
  }

  /** The embedded harness this session is (or will be, on the next auto-start) driving.
   * Resolved ONCE at construction — session.json's `selected` if it names a still-known
   * harness, else opts.defaultHarness, else 'claude-code'. Changed only via
   * setConfig({harness}), never re-derived from disk afterward (this._harness is the single
   * source of truth for the rest of this process's lifetime). */
  harness(): HarnessId {
    return this._harness
  }

  /** Auto-start + deliver: the /dispatch 'embedded' rung.
   * - idle/failed → start adapter (with resumeId from session.json) and send the pull
   *   turn IMMEDIATELY. Verified live (CLI 2.1.201): `claude -p --input-format
   *   stream-json` emits NOTHING — not even init — until the first stdin line arrives,
   *   so waiting for `started` before sending deadlocks (manager waits for init, CLI
   *   waits for input). The CLI buffers stdin during boot; sending first is safe.
   * - ready → sendTurn immediately.
   * - busy → park nudge (single slot; pull claims everything, so N Sends need ≤1 follow-up). */
  notifyDesignEdits(): void {
    switch (this._state) {
      case 'idle':
      case 'failed':
        // Park the nudge BEFORE starting — an adapter that emits `started`
        // synchronously inside start() flushes it there (ready branch); the guard
        // below then finds an empty slot and skips the duplicate send.
        this._nudgePending = true
        this._start()
        if (this._nudgePending) {
          this._nudgePending = false
          this._sendTurnText(PULL_TURN_TEXT)
        }
        break
      case 'starting':
        // Transient (only observable if start() re-enters) — park; flushes on started.
        this._nudgePending = true
        break
      case 'ready':
        this._sendTurnText(PULL_TURN_TEXT)
        break
      case 'busy':
        // Park exactly one nudge; extra calls are deduplicated.
        this._nudgePending = true
        break
      default: {
        const _: never = this._state
        void _
      }
    }
  }

  interrupt(): void {
    this._adapter?.interrupt()
  }

  /** Composes text + an optional element line, rings it as `user-text` immediately (the
   * message appears in every panel now, whatever the state), then either sends it right
   * away or parks it in the chat FIFO:
   * - `ready` → send immediately.
   * - `busy`/`starting` → cap-checked enqueue in `_chatQueue` (rejected calls ring
   *   NOTHING — the cap check runs BEFORE the ring push, so a queue-full reply is a true
   *   no-op from the caller's perspective).
   * - `idle`/`failed` → auto-start + send immediately, same lazy-boot send-at-spawn
   *   pattern as notifyDesignEdits (the CLI emits nothing until the first stdin line, so
   *   writing the turn before `started` arrives is safe). */
  say(text: string, element?: ElementRef): SayResult {
    const composed =
      text + (element ? `\n\n[Selected element: ${element.source} <${element.tag}>]` : '')

    switch (this._state) {
      case 'busy':
      case 'starting':
        if (this._chatQueue.length >= CHAT_QUEUE_CAP) {
          return { ok: false, reason: 'queue-full' }
        }
        this._push({ kind: 'user-text', text, element })
        this._chatQueue.push(composed)
        return { ok: true }

      case 'ready':
        this._push({ kind: 'user-text', text, element })
        this._sendTurnText(composed)
        return { ok: true }

      case 'idle':
      case 'failed':
        this._push({ kind: 'user-text', text, element })
        this._start()
        this._sendTurnText(composed)
        return { ok: true }

      default: {
        const _: never = this._state
        void _
        return { ok: false, reason: 'queue-full' }
      }
    }
  }

  /** Applies model/permissionMode via live control-request writes (safe mid-turn — the CLI
   * acks these regardless of busy state); effort and harness are capability-aware via
   * HARNESS_VOCAB (src/shared/chat-constants.ts):
   *
   * - effort on a `liveEffort: false` harness (claude-code): the pre-existing
   *   respawn-on-next-turn scheme (spike, Task 1: no set_effort control request exists —
   *   it's spawn-flag-only). Rejected outright while busy (`{ok:false, reason:'busy'}`, the
   *   endpoint's 409) rather than killing a live turn. While NOT busy this does NOT eagerly
   *   respawn: the lazy-boot CLI emits nothing until the first stdin line, so spawning right
   *   now would boot a silently parked child with no turn to send. Instead: stop the live
   *   adapter (state -> idle) if one exists, record the new level in `_spawnEffort`, and let
   *   the NEXT say()/notifyDesignEdits auto-start with `--effort <level>` through the normal
   *   send-at-spawn path — `--resume <id>` (persisted in session.json) keeps the
   *   conversation intact.
   * - effort on a `liveEffort: true` harness (Task 4's Codex): a live per-turn param — no
   *   stop, no busy rejection (safe mid-turn, applies starting the next turn). `_spawnEffort`
   *   is still recorded (kept in BOTH branches) so a later respawn re-applies it.
   * - harness: busy is rejected the same way a non-live effort change is (a switch must not
   *   kill a live turn); otherwise the live adapter is stopped (state -> idle), the new
   *   harness is recorded and persisted to session.json's `selected`, and the NEXT
   *   say()/notifyDesignEdits auto-starts THAT harness, resuming from its OWN slot. */
  setConfig(cfg: { model?: string; permissionMode?: string; effort?: string; harness?: HarnessId }): SetConfigResult {
    if (cfg.harness !== undefined && this._state === 'busy') {
      return { ok: false, reason: 'busy' }
    }
    const liveEffort = HARNESS_VOCAB[this._harness].liveEffort
    if (cfg.effort !== undefined && !liveEffort && this._state === 'busy') {
      return { ok: false, reason: 'busy' }
    }

    if (cfg.model !== undefined) {
      // Recorded regardless of whether an adapter is live — an idle/failed session (no
      // adapter to call yet) must still remember the choice so the NEXT started re-applies
      // it (see _lastSetModel's why-comment above).
      this._lastSetModel = cfg.model
      this._adapter?.setModel(cfg.model)
    }
    if (cfg.permissionMode !== undefined) {
      this._lastSetPermissionMode = cfg.permissionMode
      this._adapter?.setPermissionMode(cfg.permissionMode)
    }
    if (cfg.effort !== undefined) {
      this._spawnEffort = cfg.effort
      if (liveEffort) {
        this._adapter?.setEffort(cfg.effort)
      } else if (this._adapter) {
        this._cancelWatchdog()
        this._discardAdapter()?.stop()
        this._state = 'idle'
      }
    }
    if (cfg.harness !== undefined) {
      this._cancelWatchdog()
      this._discardAdapter()?.stop()
      this._state = 'idle'
      this._harness = cfg.harness
      writeSelectedHarness(this._opts.forgeDir, cfg.harness)
    }

    this._push({ kind: 'config-changed', ...cfg })
    return { ok: true }
  }

  /** An approval is parked in the overlay — suspend the watchdog entirely. A human
   * deciding is not a hung CLI; the registry's hold timer bounds how long this lasts.
   * Wired from the ApprovalRegistry's onChange in src/server/runtime.ts (the registry
   * must not import this module). */
  onApprovalPending(): void {
    this._pendingApprovals++
    this._cancelWatchdog()
  }

  /** The parked approval resolved. Once none remain, re-arm: an ALLOWED tool gets the
   * long post-approval leash (builds/tests emit nothing until tool_result); a denied
   * one resumes the normal leash — the turn continues without a long-running tool. */
  onApprovalResolved(allow: boolean): void {
    this._pendingApprovals = Math.max(0, this._pendingApprovals - 1)
    if (this._pendingApprovals === 0 && this._state === 'busy') {
      this._armWatchdog(allow ? this._postApprovalWatchdogMs : this._watchdogMs)
    }
  }

  stop(): void {
    this._cancelWatchdog()
    this._nudgePending = false
    // Dev-server close — any chat backlog belongs to the session we're tearing down; a
    // fresh session must not silently replay a stranger's queued messages.
    this._chatQueue = []
    // Reset to the empty string, not PULL_TURN_TEXT — that constant is a specific real turn,
    // not a "nothing in flight" sentinel; every live path overwrites this before it's ever
    // read again (the next _sendTurnText call, from whichever send path runs next).
    this._inflightTurn = ''
    // Outstanding approvals belong to the child we just killed; their eventual registry
    // resolutions must not leave a fresh session's watchdog permanently suspended.
    this._pendingApprovals = 0
    // Dev-server close = fresh posture (same rationale as the chat-queue clear above) — a
    // NEW session must not silently inherit a stranger's remembered model/permissionMode.
    this._lastSetModel = undefined
    this._lastSetPermissionMode = undefined
    this._discardAdapter()?.stop()
    this._state = 'idle'
  }

  eventsSince(seq: number): FeedEvent[] {
    return this._ring.filter((e) => e.seq > seq)
  }

  subscribe(fn: (e: FeedEvent) => void): () => void {
    this._subscribers.add(fn)
    return () => this._subscribers.delete(fn)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Detach the current adapter's onEvent and drop the reference, so a discarded
   * adapter can never re-enter the state machine (stale started/ended events from
   * a killed child are the double-respawn race). Returns the old adapter so callers
   * that also need to kill the process can chain `.stop()`. */
  private _discardAdapter(): SessionAdapter | null {
    const old = this._adapter
    if (old) {
      old.onEvent = () => {}
      this._adapter = null
    }
    return old
  }

  private _start(fresh = false): void {
    // A restart from `failed` reaches here with the previous adapter still attached AND
    // its child possibly alive — in-band error turns (rate limit, auth) end with exit
    // code 0 *later*, if ever. Detach + kill it first, or every failed→restart cycle
    // leaks a live child whose stray `ended` would discard the new adapter (the same
    // stale-event race _onWatchdogFired defends against).
    this._discardAdapter()?.stop()
    const resumeId = fresh ? undefined : readSlot(this._opts.forgeDir, this._harness)?.sessionId
    this._lastStartResumeId = resumeId
    this._sawStarted = false
    const adapter = this._opts.makeAdapter({ harness: this._harness, effort: this._spawnEffort })
    this._adapter = adapter
    adapter.onEvent = (e) => this._onAdapterEvent(e)
    // State before start(): an adapter emitting `started` synchronously inside
    // start() must not have its ready/busy transition clobbered afterwards.
    this._state = 'starting'
    adapter.start({ cwd: this._opts.cwd, resumeId })
  }

  /** Generalized send: writes `text` to the adapter, records it as the in-flight turn (so
   * a recovery respawn re-sends THIS turn, not always the pull nudge — see `_inflightTurn`),
   * and arms the busy watchdog. The pull path calls this with PULL_TURN_TEXT; say() calls
   * it with the composed chat turn. */
  private _sendTurnText(text: string): void {
    this._adapter?.sendTurn(text)
    this._inflightTurn = text
    this._state = 'busy'
    this._armWatchdog()
  }

  private _onAdapterEvent(event: SessionEvent): void {
    // Re-arm the watchdog on any event while busy — prevents spurious expiry
    // when the session is actively producing output.
    if (this._state === 'busy') {
      this._armWatchdog()
    }

    if (event.kind === 'activity') {
      // Pure liveness (hook/system chatter during boot) — the watchdog re-arm above is
      // the whole point; never pushed to the ring, never rendered.
      return
    }

    if (event.kind === 'assistant-delta') {
      // Ephemeral token-by-token preview — fans to live subscribers only, seq 0 marks it
      // as not-ring-backed (never lands in eventsSince()/replay, unlike every other event
      // kind). Clients must not regress `lastSeq` on a seq-0 event — the final complete
      // assistant-text still arrives separately with a real seq once the block finishes.
      const fe: FeedEvent = { seq: 0, at: new Date(this._clock()).toISOString(), event }
      for (const fn of this._subscribers) {
        fn(fe)
      }
      return
    }

    this._push(event)

    switch (event.kind) {
      case 'started':
        this._lastSessionId = event.sessionId
        this._sawStarted = true
        this._startFailures = 0
        writeSessionSlot(this._opts.forgeDir, this._harness, event.sessionId, new Date(this._clock()).toISOString())
        // Re-apply the last user-chosen model/permissionMode to every fresh adapter — a
        // respawn (watchdog fire, ended-while-busy, stale-resume retry) otherwise silently
        // reverts to spawn defaults while the UI still shows the old choice (final-review
        // fix 2). A harmless no-op re-send on the FIRST started of a session that never
        // called setConfig (both undefined).
        if (this._lastSetModel !== undefined) {
          this._adapter?.setModel(this._lastSetModel)
        }
        if (this._lastSetPermissionMode !== undefined) {
          this._adapter?.setPermissionMode(this._lastSetPermissionMode)
        }
        if (this._state === 'starting') {
          // Explicit-start path (no turn written yet) — become ready and flush.
          this._state = 'ready'
          if (this._nudgePending) {
            this._nudgePending = false
            this._sendTurnText(PULL_TURN_TEXT)
          }
        }
        // While busy (the normal path: pull turn written at spawn, init arrives
        // mid-turn): bookkeeping only — no state change, no flush.
        break

      case 'turn-complete':
        this._cancelWatchdog()
        if (event.isError) {
          if (!this._sawStarted && this._lastStartResumeId !== undefined) {
            // Stale resume id (observed live, CLI 2.1.201): `--resume <unknown-id>` emits
            // result/error_during_execution BEFORE any init event — session.json goes stale
            // legitimately (CLI session store pruned, project moved). Clear it and retry
            // fresh ONCE; the retry has no resumeId, so a second failure parks in `failed`.
            // Clears only the CURRENT harness's slot — the other harness's resume id (a
            // session this run never touched) must survive untouched.
            clearSessionSlot(this._opts.forgeDir, this._harness)
            this._lastSessionId = undefined
            this._push({ kind: 'session-error', text: 'stale session id — starting fresh' })
            // Same nudge-preservation rule as _respawn(): only a resent PULL turn makes a
            // separately parked nudge redundant. A resent CHAT turn leaves a real parked
            // nudge alone — it flushes on this retry's own completion.
            if (this._inflightTurn === PULL_TURN_TEXT) {
              this._nudgePending = false
            }
            this._start(true)
            // Re-send whichever turn actually died (pull OR chat) — not unconditionally
            // PULL_TURN_TEXT, or a user's chat message would silently turn into a pull nudge.
            this._sendTurnText(this._inflightTurn)
            break
          }
          // Error turn → failed. A later Send retries via auto-start — no retry loop here
          // (retrying automatically on error could thrash under rate limits or auth failure).
          this._state = 'failed'
        } else {
          this._state = 'ready'
          if (this._nudgePending) {
            this._nudgePending = false
            this._sendTurnText(PULL_TURN_TEXT)
          } else if (this._chatQueue.length > 0) {
            // Flush order: the parked pull nudge always wins (pull claims everything, so
            // it's the time-sensitive one) — only once no nudge is pending does the next
            // queued chat turn go out. One turn per completion, same as the nudge.
            const next = this._chatQueue.shift() as string
            this._sendTurnText(next)
          }
        }
        break

      case 'session-error':
        if (!this._sawStarted) {
          // Spawn failure path (child 'error' event before any init) → failed; the
          // trailing `ended` sees failed and keeps it — no pointless respawn of a
          // binary that isn't there / can't start.
          this._state = 'failed'
        }
        // While mid-turn: the watchdog or ended handler manages recovery; let this
        // event through to the ring (already pushed above) without state change here.
        break

      case 'ended':
        this._cancelWatchdog()
        // The adapter that just ended is dead either way — detach it so any
        // further stray events from it can't reach the manager.
        this._discardAdapter()
        if (this._state === 'failed') {
          // session-error already drove us to failed; ended is just the adapter
          // signalling the process is gone — don't overwrite the failed state.
        } else if (!this._sawStarted) {
          // Died before ever emitting started — a pre-init crash. Bounded: a child that
          // keeps dying pre-init (broken install, corrupted state) must not respawn forever.
          this._startFailures++
          if (this._startFailures >= MAX_START_FAILURES) {
            this._startFailures = 0 // a later Send retries with a fresh budget
            this._push({ kind: 'session-error', text: 'session failed to start repeatedly — giving up until the next Send' })
            this._state = 'failed'
          } else {
            this._respawn()
          }
        } else if (this._state === 'busy') {
          // Unexpected exit during a live turn → recover (unbounded on purpose: each
          // cycle passed init and burned a real turn, so this is genuine recovery, not
          // a tight crash loop; the watchdog path is the same).
          this._respawn()
        } else {
          // Clean exit between turns (ready) → idle, no respawn.
          this._state = 'idle'
        }
        break

      case 'assistant-text':
      case 'tool-started':
      case 'tool-finished':
        // Already pushed to ring above; no state transition needed.
        break

      case 'user-text':
        // Defensive only — the manager itself produces every user-text event (say() pushes
        // it directly), never the adapter. An adapter emitting this would be unexpected
        // (real adapters only echo assistant/tool output), so this arm exists purely to
        // keep the switch exhaustive; it's already been pushed to the ring above.
        break

      case 'config-changed':
        // setConfig() pushes this event directly (manager-produced, mirrors user-text) —
        // an adapter emitting it would be unexpected. Already pushed to the ring above;
        // this arm only keeps the switch exhaustive.
        break

      default: {
        const _: never = event
        void _
      }
    }
  }

  /** Watchdog expiry: kill the stalled adapter, synthesize a recovery row, and respawn.
   * Re-pulling (when the in-flight turn was a pull) is safe: unclaimed items and
   * stale-claim items re-deliver, so no edits are lost. A stalled CHAT turn re-sends
   * itself instead — see `_inflightTurn` and `_respawn`. */
  private _onWatchdogFired(): void {
    this._watchdog = null
    // Detach BEFORE stop(): a real process adapter emits `ended` asynchronously
    // after kill; with the closure still attached that late `ended` would land
    // while state is 'starting' and trigger a second respawn, orphaning the
    // child we're about to spawn.
    this._discardAdapter()?.stop()
    this._push({ kind: 'session-error', text: 'session recovered after stall' })
    this._respawn()
  }

  /** Spawn a fresh adapter (re-using the last sessionId for --resume) and re-send
   * `_inflightTurn` immediately (lazy-boot CLI — see notifyDesignEdits). Used by both
   * the watchdog and the ended-while-busy path. */
  private _respawn(): void {
    const resumeId = this._lastSessionId ?? readSlot(this._opts.forgeDir, this._harness)?.sessionId
    this._lastStartResumeId = resumeId
    this._sawStarted = false
    const adapter = this._opts.makeAdapter({ harness: this._harness, effort: this._spawnEffort })
    this._adapter = adapter
    // The parked nudge is cleared ONLY when the turn we're about to re-send is itself the
    // pull turn — a fresh pull already covers everything a nudge would ask for, same as
    // before Task 3. If the in-flight turn was a CHAT turn (say()) instead, a separately
    // parked nudge is a distinct, still-legitimate pull request — clearing it here would
    // silently drop queued design edits; it survives and flushes on the resent turn's own
    // completion (the normal nudge-before-chat-queue flush order in the turn-complete arm).
    if (this._inflightTurn === PULL_TURN_TEXT) {
      this._nudgePending = false
    }
    adapter.onEvent = (e) => this._onAdapterEvent(e)
    // State before start() — same synchronous-started ordering rule as _start().
    this._state = 'starting'
    adapter.start({ cwd: this._opts.cwd, resumeId })
    // Recovery send goes out immediately — the lazy-boot CLI emits nothing until the
    // first stdin line, so waiting for started would deadlock the respawn too.
    this._sendTurnText(this._inflightTurn)
  }

  private _push(event: SessionEvent): void {
    const seq = ++this._seq
    const fe: FeedEvent = { seq, at: new Date(this._clock()).toISOString(), event }
    if (this._ring.length >= RING_CAPACITY) {
      // Drop oldest entry to maintain the capacity cap.
      this._ring.shift()
    }
    this._ring.push(fe)
    for (const fn of this._subscribers) {
      fn(fe)
    }
  }

  private _armWatchdog(ms: number = this._watchdogMs): void {
    // Suspended while any approval is parked — a stray adapter event mid-approval must
    // not sneak a normal-leash timer past onApprovalPending's cancellation.
    if (this._pendingApprovals > 0) return
    this._cancelWatchdog()
    this._watchdog = setTimeout(() => this._onWatchdogFired(), ms)
  }

  private _cancelWatchdog(): void {
    if (this._watchdog !== null) {
      clearTimeout(this._watchdog)
      this._watchdog = null
    }
  }
}

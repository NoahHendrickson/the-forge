import type { SentEntry, SentStore } from './lifecycle'
import type { DraftStore } from './drafts'
import { parseSourceAttr, type TaggedElement } from './source'
import { AGENT_DISPLAY_NAME, currentAgent } from './agent'
import { parseSessionState, parseWatcherState, queuedLineFor, type SessionState, type WatcherState } from './watch'
import { resolveElement } from './lifecycle-store'

const POLL_MS = 2000
/** After this many consecutive failed polls the verifier surfaces "paused" and starts backing off. */
export const PAUSE_AFTER_FAILURES = 5
/** Backoff ceiling — a dead dev server costs one request per 30s, not one per 2s forever. */
export const MAX_POLL_MS = 30_000

/**
 * Units: `verified` and `missing` are per-element counts (how many elements in the
 * entry fully matched, or could not be located). `mismatched` is per-property — a
 * single element with three drafted properties that all fail to match contributes
 * three entries here, not one.
 */
export interface VerifyResult {
  verified: number
  mismatched: Array<{ property: string; expected: string; actual: string }>
  missing: number
}

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

/** Thin delegate to lifecycle-store's canonical resolveElement — that module owns the one
 * connected-el-wins / index-then-first-match precedence rule now; this function used to
 * hand-roll a raw first-match querySelector here, which silently ignored which list instance an
 * entry actually referred to. `index` defaults to 0 for legacy callers/tests whose elements[]
 * entries predate the per-element index field — the same first-match behavior as before. */
function locate(el: TaggedElement, dcSource: string | null, doc: Document, index = 0): TaggedElement | null {
  return resolveElement(el, dcSource, index, doc)
}

/** Bound for text-mismatch expected/actual strings headed for the panel UI. */
const MAX_TEXT_CHARS = 120

/** Tracks whether a dev-server code update reached this page since a given cursor.
 *
 * Why it exists (Figma pivot P1, spec §4): the css verifier's false-done guard is
 * neutralize-inline-then-measure — the cascade underneath our override is the code's truth.
 * Text has no cascade: if the drafted node survived HMR, its textContent IS our own draft, and
 * equality with the expected value proves nothing. The style trick has no text analog, so the
 * guard becomes "only trust equality on a surviving node once a code update demonstrably
 * reached the page" — Vite fires 'vite:afterUpdate' on window for exactly this. On Next there
 * is no page-visible update event at all, so trustSince() returns true there (documented
 * residual false-done risk; a full Fast-Refresh remount instead replaces the node, which the
 * caller's identity check catches without needing this signal).
 *
 * Vite detection: onVite latches ONLY once a listener demonstrably attached (the hot-context
 * import resolved) or a vite event was actually observed — never from the script-tag sniff
 * alone. The sniff used to latch it, which broke the degrade promise: any setup where the tag
 * matches but the probe can't attach (non-root `base`: tag src '/app/@vite/client' matches the
 * substring, the hardcoded absolute import 404s) gated every text verify on a signal that
 * could never arrive — permanent 'unverified' (PR #44 review). A failed probe on an exotic
 * Vite setup now degrades to the legacy accept-equality behavior, never to a stuck row. */
const MAX_UPDATE_LOG = 200

/** Pulls the touched module paths out of a vite:afterUpdate payload — hot-context payloads
 * carry {updates: [{path, acceptedPath}]}; window CustomEvents may carry the same under
 * .detail; anything else yields [] (an update with unknown shape trusts globally, the
 * pre-path-scoping behavior). */
function extractUpdatePaths(payload: unknown): string[] {
  const body = isObj(payload) && 'detail' in payload ? (payload as { detail?: unknown }).detail : payload
  if (!isObj(body) || !Array.isArray((body as { updates?: unknown }).updates)) return []
  const paths: string[] = []
  for (const u of (body as { updates: unknown[] }).updates) {
    if (!isObj(u)) continue
    for (const v of [(u as { acceptedPath?: unknown }).acceptedPath, (u as { path?: unknown }).path]) {
      if (typeof v === 'string') paths.push(v)
    }
  }
  return paths
}

function isObj(v: unknown): v is object {
  return typeof v === 'object' && v !== null
}

/** Vite update paths are dev-server-absolute ('/src/App.tsx', possibly '?t='-suffixed);
 * data-dc-source files are whatever the tagger recorded (project-relative or absolute).
 * Suffix-match either way after stripping query strings and leading slashes. */
function pathMatchesFile(updatePath: string, file: string): boolean {
  const norm = (s: string): string => s.split('?')[0].replace(/^\/+/, '')
  const a = norm(updatePath)
  const b = norm(file)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export class HmrSignal {
  private count = 0
  private onVite = false
  private listening = false
  /** seq (count value AFTER the update) + touched module paths, bounded to MAX_UPDATE_LOG.
   * Paths let trustSince scope trust to the edited element's OWN file: a page-global counter
   * let any unrelated element's hot update vouch for a failed text edit in the same request —
   * false Implemented, and commitStructural then destroys the draft (PR #44 review). */
  private updates: Array<{ seq: number; paths: string[] }> = []
  private hot: { on(e: string, cb: (p?: unknown) => void): void; off?(e: string, cb: (p?: unknown) => void): void } | null = null
  private handler = (payload?: unknown): void => {
    this.count++
    this.onVite = true
    this.updates.push({ seq: this.count, paths: extractUpdatePaths(payload) })
    if (this.updates.length > MAX_UPDATE_LOG) this.updates.shift()
  }

  start(doc: Document = document): void {
    if (this.listening) return
    this.listening = true
    // Belt (tests + any future page-level dispatch) …
    window.addEventListener('vite:afterUpdate', this.handler)
    // … and braces (the path that actually fires on real Vite, caught by the P1 E2E):
    // 'vite:afterUpdate' is NOT a DOM event — client.mjs's notifyListeners only invokes
    // import.meta.hot listeners, and this bundle is served raw (never Vite-transformed), so
    // it has no import.meta.hot. Mint our own hot context by importing the HMR client and
    // calling createHotContext — the exact preamble Vite injects into transformed modules.
    // The specifier comes from the injected client tag's own src when present — a hardcoded
    // '/@vite/client' 404s on any non-root `base` (PR #44 review) — and lives in a variable
    // so esbuild leaves the import dynamic instead of trying to resolve a dev-server-only
    // path at build time. On Next the import rejects and we stay in trust-always mode
    // (spec §4's documented Next behavior).
    const viteClientPath = doc.querySelector('script[src*="/@vite/client"]')?.getAttribute('src') ?? '/@vite/client'
    import(viteClientPath).then(
      (mod: { createHotContext?: (path: string) => { on(e: string, cb: (p?: unknown) => void): void } }) => {
        if (!this.listening || typeof mod.createHotContext !== 'function') return
        this.onVite = true
        this.hot = mod.createHotContext('/__the-forge/hmr-signal')
        this.hot.on('vite:afterUpdate', this.handler)
      },
      () => {} // not Vite (or client unreachable) — the window listener remains the only ear
    )
  }

  stop(): void {
    if (!this.listening) return
    this.listening = false
    window.removeEventListener('vite:afterUpdate', this.handler)
    this.hot?.off?.('vite:afterUpdate', this.handler)
    this.hot = null
  }

  /** Monotonic cursor — record at send time, test with trustSince at verify time. */
  mark(): number {
    return this.count
  }

  /** True when a code update demonstrably reached the page since `cursor` — scoped to `file`
   * (the element's own data-dc-source file) when both it and the updates' path info are
   * available. Non-Vite pages (no listener ever attached) trust unconditionally. */
  trustSince(cursor: number, file?: string | null): boolean {
    if (!this.onVite) return true
    const since = this.updates.filter((u) => u.seq > cursor)
    if (since.length === 0) return false
    if (!file) return true
    return since.some((u) => u.paths.length === 0 || u.paths.some((p) => pathMatchesFile(p, file)))
  }
}

/** Decides whether a text-op equality on `target` is trustworthy — see HmrSignal. Injected
 * into verifyElements so the pure verify math stays testable without a live Verifier.
 * `dcSource` is the element's own source tag, letting the trust decision scope to its file. */
type TextTrust = (sentEl: TaggedElement, target: TaggedElement, dcSource: string | null) => boolean

/** Per-element verification outcome, used to decide whether that element's drafts can be committed. */
interface ElementVerification {
  el: TaggedElement
  /** the DraftStore keys actually held for this element at send time — the only ones eligible
   * for a targeted commit. NOT the (possibly collapsed shorthand) `changes` property list —
   * those names may not exist as DraftStore keys at all (see SentEntry.draftProps). */
  draftProps: string[]
  verified: number
  mismatched: Array<{ property: string; expected: string; actual: string }>
  missing: number
}

function verifyElements(entry: SentEntry, doc: Document = document, textTrusted: TextTrust = () => true): ElementVerification[] {
  return entry.elements.map((el) => {
    const target = locate(el.el, el.dcSource, doc, el.index ?? 0)
    const ops = el.ops ?? []

    // DELETE — inverted polarity: the element being GONE is success; every other outcome
    // model below treats a locate miss as failure. No neutralization needed — our
    // display:none preview affects rendering, not connectivity, and deletion can only reach
    // the DOM through a file edit → HMR → re-render, which disconnects the node. Known edge
    // (spec §4, accepted): after the JSX is removed, a following sibling can shift onto the
    // deleted element's exact file:line:col and read as "still present" — that surfaces as a
    // mismatch the user can dismiss, never as a false success.
    if (ops.some((o) => o.kind === 'delete')) {
      if (!target) return { el: el.el, draftProps: el.draftProps, verified: 1, mismatched: [], missing: 0 }
      return {
        el: el.el,
        draftProps: el.draftProps,
        verified: 0,
        mismatched: [{ property: 'element', expected: 'deleted', actual: 'still present' }],
        missing: 0,
      }
    }

    if (!target) return { el: el.el, draftProps: el.draftProps, verified: 0, mismatched: [], missing: el.changes.length + ops.length }

    // TEXT — getComputedStyle can't see text, so this runs outside the css measure block.
    // Equality on a REPLACED node (or with an HMR update observed — textTrusted) is the
    // code's truth; equality on a surviving node without either signal could be our own
    // draft echoing back, and counts as `missing` (→ 'unverified'), never as a false done.
    const textMismatched: ElementVerification['mismatched'] = []
    let textVerified = 0
    let textUnproven = 0
    for (const op of ops) {
      if (op.kind !== 'text') continue
      // U+00A0-normalize BOTH sides: contenteditable rebalances collapsible spaces to nbsp,
      // and finishTextEdit normalizes the committed value — but a pre-normalization
      // persisted send (or nbsp genuinely in the page's own source) must still compare as
      // the visually-identical text it is, never as an undiagnosable terminal 'mismatch'
      // whose expected/actual render the same (PR #44 review).
      const denbsp = (s: string): string => s.replace(/\u00a0/g, ' ')
      const actual = target.textContent ?? ''
      if (denbsp(actual) === denbsp(op.after)) {
        if (textTrusted(el.el, target, el.dcSource)) textVerified++
        else textUnproven++
      } else {
        textMismatched.push({ property: 'text', expected: op.after.slice(0, MAX_TEXT_CHARS), actual: actual.slice(0, MAX_TEXT_CHARS) })
      }
    }
    // Fail CLOSED on op kinds this function has no verify branch for (P3's move before its
    // branch lands, a version-skewed restore): they count as unproven → 'unverified'. Without
    // this, an element carrying only an unknown op returns all-zeros, which handleApplied's
    // else-arm reads as fully verified — commit + 'done' with zero checks performed
    // (PR #44 review). (Delete never reaches here — its branch early-returns above.)
    const unknownOps = ops.filter((o) => o.kind !== 'text' && o.kind !== 'delete').length

    // Neutralize the draft's inline styles before measuring — inline styles win the
    // cascade, so if the sent draft is still applied as inline style (e.g. the DOM
    // node survived Fast Refresh), getComputedStyle would just read back what WE put
    // there, reporting "implemented" even if the underlying code never adopted the
    // value. Stash and strip each sent property (plus transition, to avoid measuring
    // mid-transition values), measure, then restore in a finally.
    //
    // Strip the UNION of el.changes[].property and el.draftProps, not just el.changes:
    // `changes` carries request.ts's COLLAPSE names (padding-block, border-radius, …) used
    // for the change-request markdown, but the DraftStore's actual inline styles are the
    // longhands the panel edits (padding-top/padding-bottom, …) — draftProps is exactly
    // those real keys (see SentEntry.elements[].draftProps docs in lifecycle.ts).
    // removeProperty('padding-block') does not strip an inline padding-top, so a DOM node
    // that survived HMR with its draft still inline would be measured against the client's
    // OWN draft value — a false "done", followed by commit() visibly snapping the page back.
    // draftProps exists for exactly this divergence and commit() already uses it (see
    // handleApplied below); this neutralize loop was the one place that got missed.
    const inlineTransition = target.style.getPropertyValue('transition')
    target.style.setProperty('transition', 'none')
    const stashed = new Map<string, string>()
    const toStrip = new Set<string>([...el.changes.map((c) => c.property), ...el.draftProps])
    for (const prop of toStrip) {
      stashed.set(prop, target.style.getPropertyValue(prop))
      target.style.removeProperty(prop)
    }

    const mismatched: ElementVerification['mismatched'] = []
    let verified = 0
    try {
      const computed = getComputedStyle(target)
      for (const change of el.changes) {
        const actual = computed.getPropertyValue(change.property).trim()
        const expected = change.afterCss.trim()
        if (actual === expected) verified++
        else mismatched.push({ property: change.property, expected, actual })
      }
    } finally {
      for (const [prop, value] of stashed) {
        if (value) target.style.setProperty(prop, value)
        else target.style.removeProperty(prop)
      }
      if (inlineTransition) target.style.setProperty('transition', inlineTransition)
      else target.style.removeProperty('transition')
    }

    return {
      el: el.el,
      draftProps: el.draftProps,
      verified: verified + textVerified,
      mismatched: [...mismatched, ...textMismatched],
      missing: textUnproven + unknownOps,
    }
  })
}

export function verifyEntry(entry: SentEntry, doc: Document = document, textTrusted: TextTrust = () => true): VerifyResult {
  const result: VerifyResult = { verified: 0, mismatched: [], missing: 0 }
  for (const ev of verifyElements(entry, doc, textTrusted)) {
    result.verified += ev.verified
    result.mismatched.push(...ev.mismatched)
    result.missing += ev.missing
  }
  return result
}

interface Counters {
  implemented: number
  mismatch: number
  unverified: number
  failed: number
  /** Deduped mark_applied failure notes — the agent's one-line reasons travel the whole
   * pipeline (mark → queue → /status) and this is the only surface the user actually sees, so
   * dropping them here would waste the field entirely. A bounded list (not latest-wins): with
   * several failures for different reasons, one surviving note would misdescribe the rest. */
  failedNotes: string[]
}

/** Bounds for the failure-note portion of the one-line summary. */
const MAX_FAILED_NOTES = 3
const MAX_NOTE_CHARS = 120

/** Shape of GET /__the-forge/status — the one I/O boundary this module reads. */
interface StatusResponse {
  items: Array<{ id: string; status: string; note: string | null }>
  watcher?: unknown
  session?: unknown
}

/**
 * Renders the sent-status prefix. Manual rung (spec): nothing applies to the user's code until
 * they actually type /forge-design into their agent session — so as long as ANY sent item is still
 * server-side `pending` (queued, not yet claimed by the agent), the whole prefix must be the
 * manual instruction rather than a possibly-false "applying…" claim. Only once every sent item
 * has been claimed does "N applying…" (N = claimed count) become accurate.
 *
 * Watch mode refines the pending copy via queuedLineFor — the live/asleep/none message
 * matrix lives in watch.ts alongside the other watcher copy, not here. An active embedded
 * session (parsed from the same /status body as the watcher field) takes precedence inside
 * queuedLineFor — without it, a pending item queued for the embedded session would falsely
 * instruct the user to type /forge-watch.
 */
function renderSummary(
  counters: Counters,
  claimed: number,
  pendingManual: number,
  agentDisplayName: string,
  watcherState: WatcherState = 'none',
  sessionState: SessionState = 'unavailable'
): string {
  const parts: string[] = []
  if (pendingManual > 0) parts.push(queuedLineFor(pendingManual, agentDisplayName, watcherState, sessionState))
  else if (claimed > 0) parts.push(`${claimed} applying…`)
  if (counters.implemented) parts.push(`${counters.implemented} implemented ✓`)
  if (counters.mismatch) parts.push(`${counters.mismatch} mismatch ⚠`)
  if (counters.unverified) parts.push(`${counters.unverified} applied (unverified)`)
  if (counters.failed) {
    const notes = counters.failedNotes.join('; ').slice(0, MAX_NOTE_CHARS)
    parts.push(`${counters.failed} failed ✗${notes ? ` — ${notes}` : ''}`)
  }
  return parts.join(' · ')
}

export class Verifier {
  private counters: Counters = { implemented: 0, mismatch: 0, unverified: 0, failed: 0, failedNotes: [] }
  private timer: ReturnType<typeof setTimeout> | null = null
  private consecutiveFailures = 0
  private delayMs = POLL_MS
  /** Bumped by every start()/stop() — a poll chained under an older generation is dead and
   * must not reschedule, even if a newer chain has since made this.timer non-null again. */
  private generation = 0
  private stageListeners: Array<(e: StageEvent) => void> = []
  private hmr = new HmrSignal()
  /** requestId → HmrSignal cursor at the moment the id was first seen pending. Recorded in
   * start() AND every poll tick (a second send while the chain is already running never
   * passes through start()'s body); deleted on final resolution and swept against pendingIds
   * (ids that leave the lifecycle sideways — row dismiss, Clear done — never hit the take
   * paths, and their cursors would otherwise accumulate for the page lifetime; PR #44
   * review). Ids are unique per send, so a cursor surviving a stop()/start() cycle still
   * describes its own send correctly. */
  private hmrCursors = new Map<string, number>()
  /** Ids restored from sessionStorage (a fresh page). Their text equality is trusted WITHOUT
   * an HMR signal — the P1 plan's "full reloads trivially count (fresh page)": nothing on a
   * fresh page can echo our own draft back, because structural draft previews deliberately
   * don't persist across reloads (HANDOFF known limitation), so the DOM text IS the code's
   * truth. Without this, a full-reload apply terminally lands 'unverified' (PR #44 review). */
  private restoredIds = new Set<string>()
  /** Ids that were pending when the signal went deaf (design-mode off stops the verifier
   * while sent entries survive). An update firing in that window is uncountable, so these
   * degrade to accept-equality — the same documented trade as Next's trust-always path —
   * instead of never-trust (PR #44 review). */
  private signalGapIds = new Set<string>()
  /** requestId → verify attempts since the server first reported 'applied' — see
   * VERIFY_WINDOW_ATTEMPTS. */
  private verifyAttempts = new Map<string, number>()

  /** Bounded re-verify window (P1 plan: equality-without-signal "keeps polling — normal
   * window → unverified"): mark_applied lands the instant the agent writes the file, but the
   * HMR/Fast-Refresh update can reach the page seconds later (Next recompiles take seconds);
   * a one-shot verify at the first poll after 'applied' terminalized a wrong answer it could
   * never correct — take() resolves the entry for good (PR #44 review). While attempts
   * remain, an unresolved entry stays un-taken (pending), so the next poll tick re-verifies;
   * the poll loop shows it as 'applying' meanwhile. ~5 × POLL_MS ≈ a 10s window. */
  private static readonly VERIFY_WINDOW_ATTEMPTS = 5

  constructor(
    private sent: SentStore,
    private drafts: DraftStore,
    private onUpdate: (summary: string) => void
  ) {}

  subscribe(fn: (e: StageEvent) => void): void {
    this.stageListeners.push(fn)
  }

  private emitStage(e: StageEvent): void {
    for (const fn of this.stageListeners) fn(e)
  }

  start(): void {
    this.hmr.start()
    this.recordHmrCursors()
    if (this.timer) return
    if (this.sent.size() === 0) return
    this.generation++
    this.consecutiveFailures = 0
    this.delayMs = POLL_MS
    this.schedule()
  }

  stop(): void {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // Sent entries survive design-mode off (setActive keeps the SentStore), but the HMR
    // signal goes deaf below — an update firing while off would leave count == cursor
    // forever and land a genuinely-applied edit as terminal 'unverified' on re-activation.
    // Ids still pending here degrade to accept-equality instead — see signalGapIds.
    for (const id of this.sent.pendingIds()) this.signalGapIds.add(id)
    this.hmr.stop()
  }

  /** Tells the verifier these ids came back from sessionStorage on a fresh page — see
   * restoredIds. Called by the restore path (index.ts restoreLifecycle) before start(). */
  markRestored(ids: string[]): void {
    for (const id of ids) this.restoredIds.add(id)
  }

  /** Baseline each pending id's HMR cursor the first time it's seen — updates observed
   * BEFORE a send belong to earlier edits and must not vouch for this one. Also sweeps every
   * per-id map/set against pendingIds: ids that left the lifecycle sideways (row dismiss,
   * Clear done) never pass the take paths, and their bookkeeping would otherwise grow
   * monotonically for the page lifetime (PR #44 review). */
  private recordHmrCursors(): void {
    const pending = new Set(this.sent.pendingIds())
    for (const id of pending) {
      if (!this.hmrCursors.has(id)) this.hmrCursors.set(id, this.hmr.mark())
    }
    for (const id of [...this.hmrCursors.keys()]) if (!pending.has(id)) this.hmrCursors.delete(id)
    for (const id of [...this.restoredIds]) if (!pending.has(id)) this.restoredIds.delete(id)
    for (const id of [...this.signalGapIds]) if (!pending.has(id)) this.signalGapIds.delete(id)
    for (const id of [...this.verifyAttempts.keys()]) if (!pending.has(id)) this.verifyAttempts.delete(id)
  }

  /** Chained setTimeout instead of setInterval so the delay can stretch under backoff. */
  private schedule(): void {
    const gen = this.generation
    this.timer = setTimeout(() => this.poll(gen), this.delayMs)
  }

  private poll(gen: number): void {
    if (gen !== this.generation) return // belt-and-braces: a stale chain must not touch state
    const ids = this.sent.pendingIds()
    if (ids.length === 0) {
      this.stop()
      return
    }
    this.recordHmrCursors()
    fetch(`/__the-forge/status?ids=${ids.join(',')}`)
      .then((res) => {
        // A server that ANSWERS but errors (500s from a broken dev server, 404/HTML from some
        // other process squatting on the port) is just as stuck as an unreachable one — before
        // this branch existed, a non-ok response read as an empty success below, resetting the
        // failure counter and polling at the base cadence forever. Distinct message from the
        // catch path: this server IS reachable, so "unreachable" would be a lie.
        if (!res.ok) {
          this.consecutiveFailures++
          if (this.consecutiveFailures >= PAUSE_AFTER_FAILURES) {
            this.delayMs = Math.min(this.delayMs * 2, MAX_POLL_MS)
            this.onUpdate('verification paused — dev server not responding')
          }
          return null
        }
        return res.json() as Promise<StatusResponse>
      })
      .then((body: StatusResponse | null) => {
        if (body === null) return
        this.consecutiveFailures = 0
        this.delayMs = POLL_MS
        const statusById = new Map(body.items.map((item) => [item.id, item.status]))
        for (const item of body.items) {
          if (item.status === 'applied') this.handleApplied(item.id)
          else if (item.status === 'failed') this.handleFailed(item.id, item.note)
        }
        // Manual rung: nothing applies until the user types /forge-design, so any sent item the server
        // still reports (or simply hasn't reported back yet, i.e. missing from the response) as
        // `pending` — as opposed to `claimed` — must surface the manual instruction, not a false
        // "applying…" claim. Only items confirmed `claimed` count toward "applying…".
        let claimed = 0
        let pendingManual = 0
        for (const id of this.sent.pendingIds()) {
          const status = statusById.get(id)
          // 'applied' ids can legitimately still be pending here — the bounded re-verify
          // window (handleApplied) keeps an unresolved entry un-taken across a few ticks.
          // They read as 'applying' (the agent HAS acted), never as the manual instruction.
          const stage: LifecycleStage = status === 'claimed' || status === 'applied' ? 'applying' : 'sent'
          if (status === 'claimed' || status === 'applied') claimed++
          else pendingManual++ // status === 'pending', or unknown/missing from the response
          const entry = this.sent.get(id)
          if (entry) {
            entry.elements.forEach((element, elIndex) =>
              this.emitStage({ requestId: id, elIndex, dcSource: element.dcSource, stage })
            )
          }
        }
        if (this.sent.size() === 0) this.stop()
        const agentDisplayName = AGENT_DISPLAY_NAME[currentAgent()]
        // Shared /status-body parsers live in watch.ts (the allowlists' one home). Unknown
        // watcher collapses to 'none' here — this is a one-shot summary line, not WatchStatus's
        // stateful blip handling, so there's no standing 'asleep' to preserve.
        const watcherState: WatcherState = parseWatcherState(body.watcher) ?? 'none'
        const sessionState: SessionState = parseSessionState(body.session)
        this.onUpdate(renderSummary(this.counters, claimed, pendingManual, agentDisplayName, watcherState, sessionState))
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
        // A stop() or stop()+start() while this poll's fetch was in flight bumps the generation —
        // this chain is then dead and must not reschedule, or two concurrent chains would race
        // (and stop() could only ever clear one of them).
        if (this.timer !== null && gen === this.generation) this.schedule()
      })
  }

  private handleApplied(id: string): void {
    const entry = this.sent.get(id)
    if (!entry) return
    const cursor = this.hmrCursors.get(id) ?? 0
    // Accept-equality fallbacks: a fresh-page restore (restoredIds) or a signal-deaf window
    // (signalGapIds) — see the field docs. Otherwise trust is the HMR signal, scoped to the
    // element's OWN source file so an unrelated element's update can't vouch for this one.
    const lenient = this.restoredIds.has(id) || this.signalGapIds.has(id)
    const textTrusted: TextTrust = (sentEl, target, dcSource) => {
      if (target !== sentEl) return true
      if (lenient) return true
      const file = dcSource ? (parseSourceAttr(dcSource)?.file ?? null) : null
      return this.hmr.trustSince(cursor, file)
    }
    const results = verifyElements(entry, document, textTrusted)
    // Bounded re-verify window — see VERIFY_WINDOW_ATTEMPTS: an unresolved outcome inside
    // the window leaves the entry pending (un-taken) so the next poll tick retries with a
    // DOM the HMR update may have reached by then.
    const unresolved = results.some((ev) => ev.missing > 0 || ev.mismatched.length > 0)
    const attempts = (this.verifyAttempts.get(id) ?? 0) + 1
    if (unresolved && attempts < Verifier.VERIFY_WINDOW_ATTEMPTS) {
      this.verifyAttempts.set(id, attempts)
      return
    }
    this.sent.take(id)
    this.hmrCursors.delete(id)
    this.restoredIds.delete(id)
    this.signalGapIds.delete(id)
    this.verifyAttempts.delete(id)
    // decide per-element: only commit drafts for an element whose changes ALL
    // matched computed style — a mismatched element keeps its drafts so the
    // user can retry or adjust rather than silently losing the edit.
    results.forEach((ev, elIndex) => {
      const dcSource = entry.elements[elIndex].dcSource
      if (ev.missing > 0) {
        this.counters.unverified += 1
        this.emitStage({ requestId: id, elIndex, dcSource, stage: 'unverified' })
      } else if (ev.mismatched.length > 0) {
        this.counters.mismatch += 1
        this.emitStage({ requestId: id, elIndex, dcSource, stage: 'mismatch', mismatches: ev.mismatched })
      } else {
        this.drafts.commit(ev.el, ev.draftProps)
        // targeted structural commit, mirroring the targeted css commit above: only the
        // ops that were actually sent AND still match the live structural draft are
        // forgotten — a text draft re-edited while in flight survives.
        for (const op of entry.elements[elIndex].ops ?? []) this.drafts.commitStructural(ev.el, op)
        this.counters.implemented += 1
        this.emitStage({ requestId: id, elIndex, dcSource, stage: 'done' })
      }
    })
  }

  private handleFailed(id: string, note?: string | null): void {
    const entry = this.sent.take(id)
    if (!entry) return
    this.hmrCursors.delete(id)
    this.restoredIds.delete(id)
    this.signalGapIds.delete(id)
    this.verifyAttempts.delete(id)
    this.counters.failed += 1
    // Agent-authored free text headed for the status line: collapse whitespace and bound the
    // length so a long note can't blow up the single-line summary.
    const clean = note ? note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS) : ''
    if (clean && !this.counters.failedNotes.includes(clean) && this.counters.failedNotes.length < MAX_FAILED_NOTES) {
      this.counters.failedNotes.push(clean)
    }
    entry.elements.forEach((element, elIndex) =>
      this.emitStage({ requestId: id, elIndex, dcSource: element.dcSource, stage: 'failed', ...(clean ? { note: clean } : {}) })
    )
  }
}

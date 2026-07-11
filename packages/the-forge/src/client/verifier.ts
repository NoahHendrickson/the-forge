import type { SentEntry, SentStore } from './lifecycle'
import type { DraftStore } from './drafts'
import type { TaggedElement } from './source'
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

function verifyElements(entry: SentEntry, doc: Document = document): ElementVerification[] {
  return entry.elements.map((el) => {
    const target = locate(el.el, el.dcSource, doc, el.index ?? 0)
    if (!target) return { el: el.el, draftProps: el.draftProps, verified: 0, mismatched: [], missing: el.changes.length }

    // Neutralize the draft's inline styles before measuring — inline styles win the
    // cascade, so if the sent draft is still applied as inline style (e.g. the DOM
    // node survived Fast Refresh), getComputedStyle would just read back what WE put
    // there, reporting "implemented" even if the underlying code never adopted the
    // value. Stash and strip each sent property (plus transition, to avoid measuring
    // mid-transition values), measure, then restore in a finally.
    const inlineTransition = target.style.getPropertyValue('transition')
    target.style.setProperty('transition', 'none')
    const stashed = new Map<string, string>()
    for (const change of el.changes) {
      stashed.set(change.property, target.style.getPropertyValue(change.property))
      target.style.removeProperty(change.property)
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

    return { el: el.el, draftProps: el.draftProps, verified, mismatched, missing: 0 }
  })
}

export function verifyEntry(entry: SentEntry, doc: Document = document): VerifyResult {
  const result: VerifyResult = { verified: 0, mismatched: [], missing: 0 }
  for (const ev of verifyElements(entry, doc)) {
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
    const entry = this.sent.take(id)
    if (!entry) return
    // decide per-element: only commit drafts for an element whose changes ALL
    // matched computed style — a mismatched element keeps its drafts so the
    // user can retry or adjust rather than silently losing the edit.
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
  }

  private handleFailed(id: string, note?: string | null): void {
    const entry = this.sent.take(id)
    if (!entry) return
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

import { Overlay } from './overlay'
import { findTaggedElement, parseSourceAttr, basename, type TaggedElement } from './source'
import { buildInspectorData } from './inspector'
import { DraftStore } from './drafts'
import { Panel } from './panel'
import { Dock } from './dock'
import {
  buildChangeRequestWithElements,
  renderMarkdown,
  rebuildRequestFromSeed,
  type ChangeRequest,
  type ElementChange,
  type PromptRequest,
} from './request'
import { LifecycleSession, type SentSeed } from './lifecycle'
import { Verifier } from './verifier'
import { snapshotRects, diffRects } from './ripple'
import { resetTokensCache } from './tokens'
import { ChangeList } from './changelist'
import { type AgentName } from './agent'
import { WatchStatus, sentLabelFor, watchIndicatorFor, type Rung } from './watch'
import { SessionFeed } from './session-feed'
import { saveLifecycle, loadLifecycle, sourceIndex, locateBySource, type PersistedLifecycle } from './lifecycle-store'

/** Rapid edits (e.g. dragging a number field) within this window reuse the first snapshot. */
const RIPPLE_DEBOUNCE_MS = 300

declare global {
  interface Window {
    __THE_FORGE__?: { mode: DesignMode; secret?: string; agent?: AgentName }
  }
}

/** Belt-and-braces against cross-origin/DNS-rebinding bypasses of the server's Origin/Host
 * checks — same-origin page scripts are the user's own app and not the adversary. The secret
 * is injected by the server into `globalThis.__THE_FORGE__` (see index.ts load()); read it
 * lazily on each send so a value set after this module first evaluates is still picked up. */
function forgeSecretHeaders(): Record<string, string> {
  const secret = (globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__?.secret
  return secret ? { 'X-Forge-Secret': secret } : {}
}

/** Builds the SessionFeed chip payload for an element — label format `<tag> · <basename>:<line>`,
 * matching changelist.ts's shortSource formatting (the Changes list already established this
 * as the project's element-label convention) rather than inventing a new one. An untagged
 * element (no data-dc-source, or a malformed one) falls back to just the tag name. */
function elementChipLabel(el: TaggedElement): { source: string; tag: string; label: string } {
  const tag = el.tagName.toLowerCase()
  const dcSource = el.dataset.dcSource ?? ''
  const parsed = dcSource ? parseSourceAttr(dcSource) : null
  if (!parsed) return { source: dcSource, tag, label: tag }
  return { source: dcSource, tag, label: `${tag} · ${basename(parsed.file)}:${parsed.line}` }
}

export class DesignMode {
  active = false
  /** Ordered set of currently selected elements — VisBug-style multi-select (B6). */
  selection: TaggedElement[] = []
  /** Single owner of sent-state — verifier consumption, ChangeList rows, persistence
   * projection — replacing the old SentRegistry + sentSeeds + ChangeList.sentRows trio. */
  session = new LifecycleSession()
  onSendComplete?: () => void

  /** Back-compat alias: `.sent` used to be a separate SentRegistry; the session implements
   * that same SentStore surface directly now. */
  get sent() {
    return this.session
  }

  private moveRaf = 0
  private reflowRaf = 0
  private rippleRaf = 0
  private lastMove: MouseEvent | null = null
  private drafts: DraftStore
  private panel: Panel
  private dock: Dock
  private verifier: Verifier
  private verifierSummary = ''
  private changeList: ChangeList
  /** Seeds with a re-queue POST currently in flight (R2 F-A). The failed row deliberately
   * survives until the POST resolves (final-review F5) so the Re-send button stays clickable
   * during the round-trip — but that means a double-click before the first POST settles would
   * otherwise fire a second identical /queue POST. isDuplicate() can't catch this: the failed
   * record is already resolved, outside the sent-but-unverified duplicate window. */
  private resendsInFlight = new Set<SentSeed>()
  /** Watcher-state poller — runs ONLY while design mode is on (started/stopped in
   * setActive), so watch mode adds zero idle overhead to the page. Session-state
   * transitions also fire refreshStatus so the embedded-session indicator stays current. The
   * third arg (onTick) fires on EVERY poll, transition or not — refreshStatus also recomputes
   * chat availability from sessionEnabled(), which onChange/onSessionChange alone could miss
   * (see WatchStatus's onTick doc comment). */
  private watch = new WatchStatus(
    () => this.refreshStatus(),
    () => this.refreshStatus(),
    () => this.refreshStatus()
  )
  /** Live activity stream from the embedded session (Task 7/8) — idle-zero: start/stop
   * mirror this.watch.start()/stop() in setActive so no fetch or timer survives design mode off. */
  private feed = new SessionFeed({ headers: forgeSecretHeaders })
  private buttonTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  // Layout-ripple state: idle-zero — only populated during the post-edit window.
  // A rapid burst of edits (e.g. dragging a number field) reuses each element's FIRST
  // snapshot in the burst until RIPPLE_DEBOUNCE_MS of quiet, so ripples reflect
  // drag-start -> drag-end, not per-tick noise. Keyed BY EDITED ELEMENT because a
  // multi-select commit loop calls handleBeforeEdit once per selected element per
  // tick — a single snapshot slot would be overwritten down to the last element (its
  // scope alone would ripple) and the alternating elements would defeat the reuse
  // check, re-running snapshotRects (forced layout) on every scrub tick. Snapshots
  // are cleared by a quiet-window TIMER (reset on every edit), not by the rAF that
  // runs the diff — the rAF must leave them alive so the NEXT edit in a burst still
  // diffs against the drag-start baselines instead of re-baselining every frame.
  private rippleSnapshots: Map<TaggedElement, Map<TaggedElement, DOMRect>> | null = null
  private lastEditAt = 0
  private rippleQuietTimer: ReturnType<typeof setTimeout> | null = null

  /** Drafts/selection from a restored session whose elements haven't rendered yet — boot()
   * runs before the framework mounts, so restoreLifecycle retries these on a short timer
   * until the DOM catches up (bounded), and persist() keeps them in storage meanwhile so
   * another reload mid-window doesn't lose them. */
  private pendingRestore: { drafts: PersistedLifecycle['drafts']; selection: PersistedLifecycle['selection'] } | null = null
  private restoreTimer: ReturnType<typeof setTimeout> | null = null
  /** R2 F-C: debounces syncDrafts()+persist() off drafts.onChange, which otherwise fires on
   * EVERY scrub tick — querySelectorAll + JSON.stringify + a synchronous sessionStorage.setItem
   * + replaceChildren per drag frame, against the codebase's own "React never re-renders while
   * scrubbing" discipline (see RIPPLE_DEBOUNCE_MS's burst pattern above). Shares the same
   * "quiet window" concept and constant as the ripple debounce, just a separate timer instance
   * since the two debounce unrelated things (layout-ripple measurement vs. draft persistence). */
  private draftSyncTimer: ReturnType<typeof setTimeout> | null = null
  /** Elements added to the selection BY the restore drain (R2 F-B) — tracks which members of
   * the current selection are "restore-owned" so a later-arriving restore element can still
   * extend the selection (boot located element A, retry later locates B — both are restore
   * additions and should end up co-selected). The moment the user makes their OWN selection
   * (select/toggleSelection/deselect via setSelection), that selection no longer matches this
   * set, and any still-pending restore selection item is dropped as resolved-obsolete instead
   * of stomping what the user just chose. */
  private restoredSelection = new WeakSet<TaggedElement>()

  constructor(
    private overlay: Overlay,
    panel?: Panel,
    drafts?: DraftStore,
    dock?: Dock
  ) {
    this.drafts = drafts ?? new DraftStore()
    this.panel =
      panel ??
      new Panel(
        this.drafts,
        () => this.handleEdited(),
        (el) => this.handleBeforeEdit(el)
      )
    this.dock = dock ?? new Dock(overlay.host, this.panel, overlay.status, overlay.toggle)
    this.verifier = new Verifier(this.session, this.drafts, (summary) => {
      this.verifierSummary = summary
      this.refreshStatus()
      // a commit/mismatch may change the computed style of the element the panel is
      // currently showing (or the selection outline's geometry) — refresh both.
      this.panel.refresh()
      this.remeasure()
    })
    this.changeList = new ChangeList(this.drafts, this.session, {
      onHover: (el) => (el ? this.overlay.showOutline(el.getBoundingClientRect()) : this.overlay.hideOutline()),
      onSelect: (el) => this.select(el),
      onResend: (seed) => this.resend(seed),
    })
    this.panel.changesSlot.appendChild(this.changeList.root)
    this.panel.feedSlot.appendChild(this.feed.root)
    // Fire-and-forget with .catch(() => {}) — same style as the unlink button's fetch;
    // a failed interrupt just means the session keeps running (degraded, not broken).
    this.feed.onInterrupt = () => {
      void fetch('/__the-forge/session/interrupt', { method: 'POST', headers: forgeSecretHeaders() })
        .catch(() => {})
    }
    this.feed.onDecide = (id: string, allow: boolean) => {
      void fetch('/__the-forge/approval/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
        body: JSON.stringify({ id, allow }),
      }).catch(() => {})
    }
    // The onSend shim below AWAITS this result (composer consolidation Task 1 moved that round
    // trip out of session-feed.ts's own trySend — see its updated doc-comment) and only clears
    // the textarea/chip on a true resolution — the optimistic clear moved to the success path
    // so a failed send never silently discards what the user typed (final-review fix 3). Every
    // non-ok response and every network failure renders a transient .session-error-row before
    // resolving false; 429 keeps its specific queue-full copy, everything else gets the
    // generic retry copy.
    this.feed.onSay = (text, element) => {
      return fetch('/__the-forge/session/say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
        body: JSON.stringify({ text, element }),
      })
        .then((res) => {
          if (res.ok) return true
          if (res.status === 429) {
            this.feed.renderTransientError('chat queue full — wait for the current turn')
          } else {
            this.feed.renderTransientError('message failed to send — try again')
          }
          return false
        })
        .catch(() => {
          this.feed.renderTransientError('message failed to send — try again')
          return false
        })
    }
    // Task 3 replaces this shim with the send-everything verb. For now it reproduces the old
    // text-only trySend behavior exactly, just relocated here now that the feed's send gesture
    // is decoupled from onSay (composer consolidation Task 1): read the typed text + attached
    // chip, call onSay, and on a true resolution clear both — same shape as trySend's old
    // Promise.resolve(...).then(...) dance, minus the disable/re-enable (no test — old or new —
    // depends on it, and Task 3 will own the real in-flight UX for the combined send verb).
    this.feed.onSend = () => {
      const text = this.feed.getText()
      const chip = this.feed.getChip()
      Promise.resolve(this.feed.onSay(text, chip ?? undefined)).then((ok) => {
        if (ok) {
          this.feed.clearText()
          this.feed.setChip(null)
        }
      })
    }
    this.feed.onConfig = (cfg) => {
      void fetch('/__the-forge/session/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
        body: JSON.stringify(cfg),
      }).catch(() => {})
    }
    // Prompt button's job now: attach the selected element as a chip to the persistent chat
    // input and focus it — replacing the old floating prompt popup's open(anchor) (retired Task 6).
    this.panel.promptButton.addEventListener('click', () => {
      if (!this.selected) return
      this.feed.setChip(elementChipLabel(this.selected))
      this.feed.focusInput()
    })
    this.verifier.subscribe((e) => {
      // applyStage returns false for poll re-emissions of an unchanged stage (the verifier
      // ticks every ~2s while a request is pending) — persisting on every tick regardless would
      // defeat "storage writes only on state changes" (final-review F4). Only a real stage
      // transition (sent -> applying, applying -> done, etc.) warrants a sessionStorage write.
      if (this.session.applyStage(e)) this.persist()
    })
    overlay.toggle.addEventListener('click', () => this.setActive(!this.active))
    overlay.sendButton.addEventListener('click', () => {
      if (overlay.sendButton.disabled) return // re-entrancy guard: a POST is already in flight
      // R2 F-C: prepareSend reads the DraftStore directly (always current), so this flush isn't
      // needed for the request itself — it's needed so persist()/the Changes list are coherent
      // with what's about to be sent, rather than lagging behind by up to 300ms.
      this.flushDraftSync()
      const originalLabel = 'Send to agent'
      const prepared = this.prepareSend()
      if (prepared === 'no-changes' || prepared === 'already-sent') {
        this.flashButton(overlay.sendButton, prepared === 'already-sent' ? 'Already sent' : 'No changes', originalLabel)
        return
      }
      const { request, pairs } = prepared
      const md = renderMarkdown(request)
      const onSendFailed = (): void => {
        overlay.sendButton.disabled = false
        this.flashButton(overlay.sendButton, 'Send failed', originalLabel)
      }
      // Dispatch reaches for the user's already-RUNNING agent session (tmux/AppleScript/Cursor
      // deeplink) so they never have to type anything but Enter — see server/dispatch.ts. A
      // dispatch failure (network hiccup, non-200) must NOT undo the send: the request is
      // already safely queued, so we degrade to the same copy as rung 'manual'.
      const agent: AgentName = window.__THE_FORGE__?.agent ?? 'claude-code'
      const onDispatchSettled = (rung: Rung | null): void => {
        overlay.sendButton.disabled = false
        // Watcher state read at settle time (not captured at click) — the poller may have
        // learned the watcher fell asleep while the queue/dispatch round-trip was in flight.
        this.flashButton(overlay.sendButton, sentLabelFor(rung ?? 'manual', agent, this.watch.current()), originalLabel)
        this.onSendComplete?.()
      }
      const onSendOk = (id: string): void => {
        const seeds = this.pairsToSeeds(pairs)
        this.registerQueuedSend(id, seeds)
        this.postDispatch(onDispatchSettled)
      }
      overlay.sendButton.disabled = true
      this.queueRequest(request, md, onSendOk, onSendFailed)
    })
    overlay.copyButton.addEventListener('click', () => {
      // Same empty guard as Send, but deliberately NOT the in-flight duplicate filter: copying
      // the markdown of a request that is still queued is a legitimate manual fallback (e.g.
      // pasting into a session the dispatch ladder couldn't reach); copying a request with
      // zero actionable edits is never useful.
      const { request } = buildChangeRequestWithElements(this.drafts)
      if (request.elements.length === 0) {
        this.flashButton(overlay.copyButton, 'No changes', 'Copy for agent')
        return
      }
      const md = renderMarkdown(request)
      navigator.clipboard
        .writeText(md)
        .then(() => this.flashButton(overlay.copyButton, 'Copied ✓', 'Copy for agent'))
        .catch(() => this.flashButton(overlay.copyButton, 'Copy failed', 'Copy for agent'))
    })
    overlay.unlinkButton.addEventListener('click', () => {
      // The strip's ✕ (2026-07-05 watcher-unlink spec): stop the linked /forge-watch loop
      // (or dismiss the asleep hint) server-side. Fire-and-forget with a same-shape catch —
      // a failed unlink leaves the indicator as-is and the next 5s poll re-syncs anyway.
      void fetch('/__the-forge/unwatch', { method: 'POST', headers: forgeSecretHeaders() })
        .then((res) => (res.ok ? (res.json() as Promise<{ watcher?: unknown }>) : null))
        .then((body) => {
          if (body === null || !this.active) return
          // Apply the state the endpoint already told us authoritatively instead of
          // waiting out WATCH_POLL_MS — same unrecognized-value guard as WatchStatus's own
          // poll handler, since this body arrives over the network as untyped JSON too.
          const state = body.watcher
          if (state === 'live' || state === 'asleep' || state === 'none') this.watch.applyServerState(state)
        })
        .catch(() => {})
    })
    overlay.compareAllButton.addEventListener('click', () => {
      this.drafts.compareAll(!this.drafts.isComparingAll())
      this.panel.refresh()
    })
    overlay.resetAllButton.addEventListener('click', () => {
      this.drafts.discardAll()
      this.panel.refresh()
      this.remeasure()
    })
    this.drafts.onChange = () => {
      // refreshStatus() is a cheap label update — stays immediate. syncDrafts()+persist() are
      // debounced (R2 F-C): a scrub/drag burst calls onChange once per tick, and each of those
      // is a querySelectorAll+JSON.stringify+sessionStorage.setItem+replaceChildren — the same
      // "quiet window" debounce the layout-ripple logic already uses for the same reason.
      this.refreshStatus()
      if (this.draftSyncTimer) clearTimeout(this.draftSyncTimer)
      this.draftSyncTimer = setTimeout(() => this.flushDraftSync(), RIPPLE_DEBOUNCE_MS)
    }
  }

  /** Cancels the pending debounced draft-sync timer (if any) and runs syncDrafts()+persist()
   * immediately (R2 F-C). Called from setActive(false) teardown and at the top of Send's click
   * handler so a deactivate or a send always sees the Changes list and sessionStorage reflect
   * the current drafts, not a stale pre-debounce snapshot. */
  private flushDraftSync(): void {
    if (this.draftSyncTimer) {
      clearTimeout(this.draftSyncTimer)
      this.draftSyncTimer = null
    }
    this.changeList.syncDrafts()
    this.persist()
  }

  get panelRoot(): HTMLElement {
    return this.panel.root
  }

  /** The Send gate, kept out of the click handler so that stays wiring-only: builds the
   * request, applies the double-Send guard, and names why nothing survived. Duplicate
   * filtering drops elements whose exact change set is already in flight (sent, not yet
   * verified) — re-queueing an identical request would instruct the agent to redo utility
   * renames whose "before" class the first apply already removed. Elements edited to NEW
   * values since the send pass through: that's a genuinely new request. 'no-changes' means
   * the BUILDER produced nothing (every draft a no-op — scrubbed back to its original);
   * 'already-sent' means real changes existed but the duplicate filter dropped every one.
   * The distinction keys off what the builder produced, NOT off sent.size(): reverting all
   * drafts while an unrelated send is still in flight is "No changes", not "Already sent"
   * (and must agree with the Copy button, which shows "No changes" in that state). */
  private prepareSend():
    | { request: ChangeRequest; pairs: Array<[TaggedElement, ElementChange]> }
    | 'no-changes'
    | 'already-sent' {
    const { request, elements } = buildChangeRequestWithElements(this.drafts)
    const pairs = [...elements.entries()].filter(([el, change]) => !this.session.isDuplicate(el, change.changes))
    request.elements = pairs.map(([, change]) => change)
    if (request.elements.length === 0) return elements.size > 0 ? 'already-sent' : 'no-changes'
    return { request, pairs }
  }

  /** Single construction point for element/change pairs -> SentSeed[] (used to be built twice:
   * once for SentRegistry, once for ChangeList). */
  private pairsToSeeds(pairs: Array<[TaggedElement, ElementChange]>): SentSeed[] {
    return pairs.map(([el, change]) => {
      const dcSource = el.dataset.dcSource ?? null
      return {
        el,
        dcSource,
        index: dcSource ? sourceIndex(el, dcSource) : 0,
        draftProps: [...(this.drafts.entries().get(el)?.keys() ?? [])],
        change,
      }
    })
  }

  /** Registers a freshly-queued send under its server-assigned id — the single path shared by
   * Send's onSendOk and resend()'s re-queue success handler. */
  private registerQueuedSend(id: string, seeds: SentSeed[]): void {
    this.session.register(id, seeds)
    this.verifier.start()
    this.persist()
  }

  /** Single POST-to-queue path shared by Send and resend() — each built its own
   * fetch/.then/.catch chain before this extraction, differing only in what happens once an id
   * comes back (or the POST fails), which is exactly what onOk/onFail are for.
   * Nesting is deliberate, matching the pre-extraction Send handler: the send tests count
   * microtask ticks — re-check them before flattening to a flat .then chain or async/await. */
  private queueRequest(request: ChangeRequest | PromptRequest, markdown: string, onOk: (id: string) => void, onFail: () => void): void {
    fetch('/__the-forge/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
      body: JSON.stringify({ request, markdown }),
    })
      .then((res) => {
        if (!res.ok) return onFail()
        res
          .json()
          .then((body: { id: string }) => onOk(body.id))
          .catch(onFail)
      })
      .catch(onFail)
  }

  /** Fire-and-forget dispatch POST shared by Send and resend() — a failure here must never
   * undo the send, only downgrade to the manual rung. */
  private postDispatch(onSettled: (rung: Rung | null) => void): void {
    fetch('/__the-forge/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
      body: JSON.stringify({}),
    })
      .then((res) => {
        if (!res.ok) return onSettled(null)
        res
          .json()
          .then((body: { rung: Rung }) => onSettled(body.rung))
          .catch(() => onSettled(null))
      })
      .catch(() => onSettled(null))
  }

  /** Re-queues one failed element-change as a fresh request. Safe and unfiltered by design:
   * a failed apply changed no source, and failed items have already left the
   * sent-but-unverified set the duplicate filter checks. Reuses the queue → dispatch path
   * of Send; a dispatch failure degrades to manual copy exactly like Send does. */
  private resend(seed: SentSeed): void {
    if (this.resendsInFlight.has(seed)) return // re-entrancy guard: this seed's re-queue POST is already in flight
    this.resendsInFlight.add(seed)
    // A failed PROMPT seed re-queues as a fresh prompt request, not a ChangeRequest — its
    // change.changes is empty, so renderMarkdown would produce a bullet-less no-op request.
    // rebuildRequestFromSeed is the single place that shapes either request — resend no longer
    // maintains its own copy of that contract.
    const { request, markdown } = rebuildRequestFromSeed(seed)
    this.queueRequest(
      request,
      markdown,
      (id) => {
        // Remove the OLD failed row only once the re-queue actually succeeded (final-review
        // F5) — a failed POST below (see the failure callback) leaves the failed row and its
        // note in place instead of vanishing on click with nothing to show for it.
        this.session.removeSeed(seed)
        this.registerQueuedSend(id, [seed])
        // Lift the guard only after removeSeed/registerQueuedSend so the new in-flight record
        // (under the fresh id) exists before this seed is eligible for another resend click.
        this.resendsInFlight.delete(seed)
        this.postDispatch(() => {
          /* request is safely queued — manual rung, same as Send */
        })
      },
      () => {
        this.resendsInFlight.delete(seed)
        this.flashButton(this.overlay.sendButton, 'Send failed', 'Send to agent')
      }
    )
  }

  /** First selection member (or null) — kept for single-selection call sites/tests. */
  get selected(): TaggedElement | null {
    return this.selection[0] ?? null
  }

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    this.overlay.setActive(on)
    if (on) {
      this.dock.enter()
      // Tokens (colors, text scale) are memoized module-globally (readTokens) for cheap
      // repeat access during a session — but that means a theme edit made while design
      // mode was INACTIVE (author tweaks CSS, HMR reloads styles) would otherwise be
      // invisible until a full page reload. Reset on every activation so a fresh session
      // always re-reads the live stylesheet.
      resetTokensCache()
      document.addEventListener('mousemove', this.onMove, true)
      document.addEventListener('click', this.onClick, true)
      document.addEventListener('keydown', this.onKey, true)
      document.addEventListener('scroll', this.onReflow, { capture: true, passive: true })
      window.addEventListener('resize', this.onReflow, { passive: true })
      if (this.session.size() > 0) this.verifier.start()
      this.watch.start()
      this.feed.start()
      this.refreshStatus()
      this.persist()
    } else {
      document.removeEventListener('mousemove', this.onMove, true)
      document.removeEventListener('click', this.onClick, true)
      document.removeEventListener('keydown', this.onKey, true)
      document.removeEventListener('scroll', this.onReflow, true)
      window.removeEventListener('resize', this.onReflow)
      if (this.moveRaf) cancelAnimationFrame(this.moveRaf)
      if (this.reflowRaf) cancelAnimationFrame(this.reflowRaf)
      if (this.rippleRaf) cancelAnimationFrame(this.rippleRaf)
      this.moveRaf = 0
      this.reflowRaf = 0
      this.rippleRaf = 0
      this.clearRippleState()
      this.lastMove = null
      this.selection = []
      // A session the user turned off must not keep restoring in the background.
      if (this.restoreTimer) clearTimeout(this.restoreTimer)
      this.restoreTimer = null
      this.pendingRestore = null
      this.drafts.compareAll(false) // previews survive exit — never leave the page stranded on "before"
      this.panel.hide()
      this.dock.exit()
      this.verifier.stop()
      this.watch.stop()
      this.feed.stop()
      // A deactivate mid-debounce-window must not leave sessionStorage/the Changes list stale —
      // flush before clear() (R2 F-C), which only visually hides rows without touching state.
      this.flushDraftSync()
      // Visual-only: sent entries survive deactivate — the verifier keeps polling them and
      // setActive(true) below re-arms it whenever entries remain.
      this.changeList.clear()
      this.persist()
    }
  }

  /** Rebuilds the session from a persisted lifecycle after a full page reload: re-activates
   * design mode, re-applies draft previews, re-registers in-flight requests (placeholder
   * elements stay detached so the verifier's locate() re-resolves them by dcSource on every
   * poll — self-healing when the DOM catches up), re-arms the verifier, and re-selects. The
   * boot pass IS the first drain (R2 F-B) — not a special case with its own policy — so a
   * partial restore here and a partial restore on a later retry tick behave identically. */
  restoreLifecycle(saved: PersistedLifecycle): void {
    if (!saved.designModeOn) return
    this.setActive(true)
    this.session.restoreSent(saved.sent, locateBySource)
    if (this.session.size() > 0) this.verifier.start()
    this.pendingRestore = { drafts: saved.drafts, selection: saved.selection }
    const { done } = this.drainPendingRestore()
    if (!done) this.scheduleRestoreRetry()
    this.persist()
  }

  /** Single per-item drain used by BOTH the boot pass (restoreLifecycle) and every retry tick
   * (R2 F-B — previously these ran two divergent policies: the boot pass applied partial
   * drafts but queued the ENTIRE selection as unresolved, while the retry pass only ever
   * touched selection when `this.selection.length === 0` — dead once boot had selected
   * anything — and required ALL-or-nothing, so a partial restore left `pending.selection`
   * undrainable and the retry timer spun all 40 attempts as a zombie).
   *
   * Policy per item:
   * - drafts: apply located items, keep unresolved ones pending (unchanged from before).
   * - selection: per-item. A located item is removed from pending and its element is ADDED to
   *   the selection — but only while the CURRENT selection is still "restore-owned" (empty, or
   *   every currently-selected element is in `restoredSelection`). If the user has since made
   *   their own selection, the pending item is dropped as resolved-obsolete instead of stomping
   *   it — a user's own selection is never overwritten by a late-appearing restore element.
   *
   * Returns `{ done: true }` once nothing remains pending, so the caller (boot pass or retry
   * tick) knows whether to schedule another attempt. */
  private drainPendingRestore(): { done: boolean } {
    const pending = this.pendingRestore
    if (!pending) return { done: true }

    const remainingDrafts: PersistedLifecycle['drafts'] = []
    for (const d of pending.drafts) {
      const el = locateBySource(d.dcSource, d.index)
      if (!el) {
        remainingDrafts.push(d)
        continue
      }
      for (const [prop, value] of d.props) this.drafts.apply(el, prop, value)
    }
    pending.drafts = remainingDrafts

    const restoreOwnsSelection = this.selection.length === 0 || this.selection.every((el) => this.restoredSelection.has(el))
    const remainingSelection: PersistedLifecycle['selection'] = []
    if (restoreOwnsSelection) {
      const additions: TaggedElement[] = []
      for (const sel of pending.selection) {
        const el = locateBySource(sel.dcSource, sel.index)
        if (el) additions.push(el)
        else remainingSelection.push(sel)
      }
      if (additions.length > 0) {
        for (const el of additions) this.restoredSelection.add(el)
        this.setSelection([...this.selection, ...additions])
      }
    } // else: the user's own selection is in place — every pending selection item is dropped as
    // resolved-obsolete (remainingSelection stays empty) rather than fighting the user for it.
    pending.selection = remainingSelection

    const done = pending.drafts.length === 0 && pending.selection.length === 0
    if (done) this.pendingRestore = null
    return { done }
  }

  /** Retries locating drafts/selection left unresolved by restoreLifecycle — boot() runs
   * before the framework mounts, so the first pass often finds nothing. Ticks every 300ms
   * for up to 40 attempts (~12s bounded window) rather than forever, so an app that never
   * renders the tagged element (e.g. it was deleted by the agent) doesn't leak a timer. Stops
   * as soon as drainPendingRestore reports done, so a partial restore that fully resolves (or
   * resolves-obsolete) on some retry tick never spins out the remaining attempts. */
  private scheduleRestoreRetry(attempt = 0): void {
    if (this.restoreTimer) clearTimeout(this.restoreTimer)
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null
      if (!this.pendingRestore) return
      const { done } = this.drainPendingRestore()
      if (!done && attempt + 1 < 40) {
        this.scheduleRestoreRetry(attempt + 1)
        return
      }
      // Either fully drained, or attempts are exhausted — give up either way: a bounded window
      // that never renders the tagged element (e.g. it was deleted by the agent) must not leave
      // a zombie pendingRestore that keeps getting merged into every future persist() forever.
      this.pendingRestore = null
      this.persist()
    }, 300)
  }

  private refreshStatus(): void {
    if (!this.active) return
    const agent: AgentName = window.__THE_FORGE__?.agent ?? 'claude-code'
    this.overlay.updateStatus(
      this.drafts.elementCount(),
      this.drafts.isComparingAll(),
      this.verifierSummary || undefined,
      watchIndicatorFor(this.watch.current(), agent, this.watch.sessionState())
    )
    // Availability derivation lives HERE (the host), not in the feed — setAvailability is a
    // dumb setter. refreshStatus is wired to WatchStatus's onChange/onSessionChange/onTick
    // (constructor, all three), so this recomputes on EVERY poll cycle regardless of whether
    // watcher/session actually transitioned — a poll that only changes sessionEnabled (e.g.
    // watcher stays 'none' and session stays 'unavailable' throughout) would otherwise never
    // reach here. A 'failed' session state is deliberately NOT surfaced here — its error text
    // already lands as a feed row (session-error), so repeating it in the disabled-reason line
    // would just duplicate the same message twice.
    this.feed.setAvailability(
      this.watch.sessionEnabled() === false
        ? { enabled: false, reason: 'Embedded sessions are disabled in config' }
        : { enabled: true }
    )
  }

  /** Serializes the full lifecycle to sessionStorage. Called only from state-change hooks
   * while the tool is in use — an ordinary page load with design mode off never writes.
   * Elements are addressed as (dcSource, index-among-matches) so list items sharing one
   * source location survive a reload individually (lifecycle-store.ts). */
  private persist(): void {
    const drafts: PersistedLifecycle['drafts'] = []
    const liveKeys = new Set<string>()
    for (const [el, props] of this.drafts.entries()) {
      const dcSource = (el as TaggedElement).dataset?.dcSource
      if (!dcSource) continue // untagged elements can't be re-located — preview-only, not persisted
      const index = sourceIndex(el as TaggedElement, dcSource)
      liveKeys.add(`${dcSource}#${index}`)
      drafts.push({
        dcSource,
        index,
        props: [...props.entries()].map(([p, d]) => [p, d.value] as [string, string]),
      })
    }
    // Merge in still-unresolved restore work so a reload mid-retry-window doesn't lose it —
    // the live DraftStore only has what's actually been located and applied so far.
    if (this.pendingRestore) {
      for (const d of this.pendingRestore.drafts) {
        if (!liveKeys.has(`${d.dcSource}#${d.index}`)) drafts.push(d)
      }
    }
    // resolved (taken by the verifier) entries are already gone from the session's map, so
    // toPersistedSent() only ever sees what's still live.
    const sent = this.session.toPersistedSent()
    const selection =
      this.selection.length === 0 && this.pendingRestore && this.pendingRestore.selection.length > 0
        ? this.pendingRestore.selection
        : this.selection.flatMap((el) => {
            const dcSource = el.dataset?.dcSource
            return dcSource ? [{ dcSource, index: sourceIndex(el, dcSource) }] : []
          })
    saveLifecycle({
      v: 1,
      designModeOn: this.active,
      selection,
      drafts,
      sent,
    })
  }

  /** Replaces the selection with just `el` (plain click / programmatic single-select). */
  select(el: TaggedElement): void {
    this.setSelection([el])
  }

  deselect(): void {
    this.setSelection([])
  }

  /** Shift+click: toggles `el`'s membership in the selection (add if absent, remove if present). */
  private toggleSelection(el: TaggedElement): void {
    const idx = this.selection.indexOf(el)
    const next = idx === -1 ? [...this.selection, el] : this.selection.filter((s) => s !== el)
    this.setSelection(next)
  }

  private setSelection(next: TaggedElement[]): void {
    // Unlike the old floating prompt popup, the chat chip is deliberately NOT cleared on selection
    // change (task-6 contract: only Send and the chip's own × clear it) — a chip stays
    // attached to whatever element the user chose it for even as they browse other elements.
    this.selection = next
    this.clearRippleState()
    if (next.length === 0) {
      this.overlay.hideSelectOutline()
      this.overlay.hideSelectOutlines()
      this.panel.hide()
    } else if (next.length === 1) {
      this.overlay.hideSelectOutlines()
      this.overlay.showSelectOutline(next[0].getBoundingClientRect())
      this.panel.show(next[0], buildInspectorData(next[0]))
    } else {
      this.overlay.hideSelectOutline()
      this.overlay.showSelectOutlines(next.map((el) => el.getBoundingClientRect()))
      this.panel.show(next, buildInspectorData(next[0]))
    }
    this.persist()
  }

  /** Clears all layout-ripple debounce state, including the pending quiet-window timer. */
  private clearRippleState(): void {
    if (this.rippleQuietTimer) clearTimeout(this.rippleQuietTimer)
    this.rippleQuietTimer = null
    this.rippleSnapshots = null
    this.lastEditAt = 0
  }

  private remeasure(): void {
    if (this.selection.length === 1) {
      this.overlay.showSelectOutline(this.selection[0].getBoundingClientRect())
    } else if (this.selection.length > 1) {
      this.overlay.showSelectOutlines(this.selection.map((el) => el.getBoundingClientRect()))
    }
  }

  /** Panel's pre-hook, called immediately before drafts.apply() for every control edit. */
  private handleBeforeEdit(el: TaggedElement): void {
    const now = Date.now()
    // A quiet gap retires ALL baselines — the next edit starts a new burst. (Belt-and-
    // braces alongside the quiet-window timer below; also what re-baselines after a
    // re-selection whose edits resume within a still-pending timer window.)
    if (!this.rippleSnapshots || now - this.lastEditAt > RIPPLE_DEBOUNCE_MS) {
      this.rippleSnapshots = new Map()
    }
    // Reuse this element's in-flight snapshot while edits keep arriving within the
    // debounce window (a scrub/drag burst) — only the first edit of a burst measures.
    if (!this.rippleSnapshots.has(el)) {
      this.rippleSnapshots.set(el, snapshotRects(el))
    }
    this.lastEditAt = now
    // Reset the quiet-window timer on every edit — it (not the per-frame rAF) is what
    // retires the snapshots, so a burst of edits keeps diffing against the SAME
    // drag-start baselines instead of re-baselining every frame.
    if (this.rippleQuietTimer) clearTimeout(this.rippleQuietTimer)
    this.rippleQuietTimer = setTimeout(() => {
      this.rippleQuietTimer = null
      this.rippleSnapshots = null
      this.lastEditAt = 0
    }, RIPPLE_DEBOUNCE_MS)
  }

  /** Panel's post-hook, called after drafts.apply() for every control edit. */
  private handleEdited(): void {
    this.remeasure()
    if (this.rippleRaf) cancelAnimationFrame(this.rippleRaf)
    this.rippleRaf = requestAnimationFrame(() => {
      this.rippleRaf = 0
      // NOTE: do NOT null rippleSnapshots here — they must survive so the next edit in
      // a burst still diffs against the drag-start baselines. The quiet-window timer in
      // handleBeforeEdit is solely responsible for retiring them.
      const snapshots = this.rippleSnapshots
      if (!snapshots) return
      const changed = new Set<TaggedElement>()
      for (const snapshot of snapshots.values()) {
        for (const moved of diffRects(snapshot)) changed.add(moved)
      }
      // Selected elements are being EDITED, not rippled — each snapshot excludes only
      // its own element, so in multi-select every co-selected element still shows up
      // in the others' scopes and must be dropped here.
      for (const sel of this.selection) changed.delete(sel)
      if (changed.size > 0) this.overlay.showRipples([...changed].map((moved) => moved.getBoundingClientRect()))
    })
  }

  private flashButton(btn: HTMLButtonElement, label: string, restore: string): void {
    btn.textContent = label
    const existing = this.buttonTimers.get(btn)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      btn.textContent = restore
      this.buttonTimers.delete(btn)
    }, 1500)
    this.buttonTimers.set(btn, timer)
  }

  private onMove = (e: MouseEvent): void => {
    this.lastMove = e
    if (this.moveRaf) return
    this.moveRaf = requestAnimationFrame(() => {
      this.moveRaf = 0
      const ev = this.lastMove
      if (!this.active || !ev || this.overlay.contains(ev.target)) return
      const el = findTaggedElement(ev.target as Element)
      if (el && !this.selection.includes(el)) this.overlay.showOutline(el.getBoundingClientRect())
      else this.overlay.hideOutline()
    })
  }

  private onClick = (e: MouseEvent): void => {
    if (this.overlay.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    const el = findTaggedElement(e.target as Element)
    if (el && e.shiftKey) this.toggleSelection(el)
    else if (el) this.select(el)
    else this.deselect()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (this.overlay.contains(e.target)) return
    e.stopPropagation()
    if (this.selection.length > 0) this.deselect()
    else this.setActive(false)
  }

  private onReflow = (): void => {
    if (this.reflowRaf) return
    this.reflowRaf = requestAnimationFrame(() => {
      this.reflowRaf = 0
      if (!this.active) return
      this.remeasure()
      // hover position is stale after scroll/resize — hide; next mousemove redraws
      this.overlay.hideOutline()
      this.lastMove = null
    })
  }
}

function boot(): void {
  const overlay = new Overlay()
  overlay.mount()
  const mode = new DesignMode(overlay)
  overlay.attachPanel(mode.panelRoot)
  // The server-injected bootstrap (prepended to this bundle's source, see index.ts load())
  // sets globalThis.__THE_FORGE__ = { secret, agent } BEFORE this module runs — preserve it
  // rather than clobbering it when we attach `mode`.
  const secret = window.__THE_FORGE__?.secret
  const agent = window.__THE_FORGE__?.agent
  window.__THE_FORGE__ = { mode, secret, agent }
  // One synchronous sessionStorage read per page load — the only work done when design
  // mode was off (zero idle overhead). A stored active session survives full reloads:
  // some frameworks legitimately hard-reload (non-HMR-able edits), and losing every
  // draft/sent state to that was half of the original "panel closes on Send" trust bug.
  const saved = loadLifecycle()
  // R1: loadLifecycle now validates and drops invalid items per-entry (selection/drafts/sent),
  // so a corrupt individual item can no longer reach restoreLifecycle at all — this try/catch
  // is defense-in-depth, validation lives at the boundary (loadLifecycle itself). Kept anyway:
  // setActive(true) runs first inside restoreLifecycle, so ANY unforeseen throw mid-restore
  // would otherwise leave capture-phase listeners attached to a half-restored session.
  if (saved?.designModeOn) {
    try {
      mode.restoreLifecycle(saved)
    } catch {
      mode.setActive(false)
    }
  }
}

if (typeof document !== 'undefined' && !import.meta.vitest) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
}

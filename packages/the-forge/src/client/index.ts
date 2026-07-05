import { Overlay } from './overlay'
import { findTaggedElement, type TaggedElement } from './source'
import { buildInspectorData } from './inspector'
import { DraftStore } from './drafts'
import { Panel } from './panel'
import { Dock } from './dock'
import { buildChangeRequestWithElements, renderMarkdown, type ChangeRequest, type ElementChange } from './request'
import { SentRegistry } from './sent'
import { Verifier } from './verifier'
import { snapshotRects, diffRects } from './ripple'
import { resetTokensCache, readTheme } from './tokens'
import { ChangeList, type SentSeed } from './changelist'
import { type AgentName } from './agent'
import { WatchStatus, sentLabelFor, watchIndicatorFor, type Rung } from './watch'
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

export class DesignMode {
  active = false
  /** Ordered set of currently selected elements — VisBug-style multi-select (B6). */
  selection: TaggedElement[] = []
  sent = new SentRegistry()
  onSendComplete?: () => void

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
  /** Seed payloads per sent request id — the single owner ChangeList rows and (Task 10)
   * persistence read from; SentRegistry keeps only what verification needs. */
  private sentSeeds = new Map<string, SentSeed[]>()
  /** Watcher-state poller — runs ONLY while design mode is on (started/stopped in
   * setActive), so watch mode adds zero idle overhead to the page. */
  private watch = new WatchStatus(() => this.refreshStatus())
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
    this.verifier = new Verifier(this.sent, this.drafts, (summary) => {
      this.verifierSummary = summary
      this.refreshStatus()
      // a commit/mismatch may change the computed style of the element the panel is
      // currently showing (or the selection outline's geometry) — refresh both.
      this.panel.refresh()
      this.remeasure()
    })
    this.changeList = new ChangeList(this.drafts, {
      onHover: (el) => (el ? this.overlay.showOutline(el.getBoundingClientRect()) : this.overlay.hideOutline()),
      onSelect: (el) => this.select(el),
      onResend: (seed) => this.resend(seed),
    })
    this.panel.changesSlot.appendChild(this.changeList.root)
    this.verifier.subscribe((e) => {
      this.changeList.applyStage(e)
      this.persist() // registry contents change on resolution — keep storage in step
    })
    overlay.toggle.addEventListener('click', () => this.setActive(!this.active))
    overlay.sendButton.addEventListener('click', () => {
      if (overlay.sendButton.disabled) return // re-entrancy guard: a POST is already in flight
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
        const mapping = pairs.map(([el, change]) => ({
          el,
          dcSource: el.dataset.dcSource ?? null,
          draftProps: [...(this.drafts.entries().get(el)?.keys() ?? [])],
          changes: change.changes.map((c) => ({ property: c.property, afterCss: c.afterCss })),
        }))
        this.sent.add(id, mapping)
        const seeds: SentSeed[] = pairs.map(([el, change]) => ({
          el,
          dcSource: el.dataset.dcSource ?? null,
          draftProps: [...(this.drafts.entries().get(el)?.keys() ?? [])],
          change,
        }))
        this.sentSeeds.set(id, seeds)
        this.changeList.addSent(id, seeds)
        this.verifier.start()
        this.persist()
        fetch('/__the-forge/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
          body: JSON.stringify({}),
        })
          .then((res) => {
            if (!res.ok) return onDispatchSettled(null)
            res
              .json()
              .then((body: { rung: Rung }) => onDispatchSettled(body.rung))
              .catch(() => onDispatchSettled(null))
          })
          .catch(() => onDispatchSettled(null))
      }
      overlay.sendButton.disabled = true
      // nesting is deliberate: the send test counts microtask ticks — re-check it before flattening to async/await
      fetch('/__the-forge/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
        body: JSON.stringify({ request, markdown: md }),
      })
        .then((res) => {
          if (!res.ok) return onSendFailed()
          res
            .json()
            .then((body: { id: string }) => onSendOk(body.id))
            .catch(onSendFailed)
        })
        .catch(onSendFailed)
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
      this.refreshStatus()
      this.changeList.syncDrafts()
      this.persist()
    }
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
    const pairs = [...elements.entries()].filter(([el, change]) => !this.sent.isDuplicate(el, change.changes))
    request.elements = pairs.map(([, change]) => change)
    if (request.elements.length === 0) return elements.size > 0 ? 'already-sent' : 'no-changes'
    return { request, pairs }
  }

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
      if (this.sent.size() > 0) this.verifier.start()
      this.watch.start()
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
      this.changeList.clear()
      this.sentSeeds.clear()
      this.persist()
    }
  }

  /** Rebuilds the session from a persisted lifecycle after a full page reload: re-activates
   * design mode, re-applies draft previews, re-registers in-flight requests (placeholder
   * elements stay detached so the verifier's locate() re-resolves them by dcSource on every
   * poll — self-healing when the DOM catches up), re-arms the verifier, and re-selects. */
  restoreLifecycle(saved: PersistedLifecycle): void {
    if (!saved.designModeOn) return
    this.setActive(true)
    const unresolvedDrafts: PersistedLifecycle['drafts'] = []
    for (const d of saved.drafts) {
      const el = locateBySource(d.dcSource, d.index)
      if (!el) {
        unresolvedDrafts.push(d)
        continue
      }
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
    const locatedSelection = saved.selection
      .map((sel) => ({ sel, el: locateBySource(sel.dcSource, sel.index) }))
      .filter((pair): pair is { sel: (typeof saved.selection)[number]; el: TaggedElement } => pair.el !== null)
    const unresolvedSelection = locatedSelection.length === saved.selection.length ? [] : saved.selection
    if (locatedSelection.length > 0) this.setSelection(locatedSelection.map((pair) => pair.el))
    if (unresolvedDrafts.length > 0 || unresolvedSelection.length > 0) {
      this.pendingRestore = { drafts: unresolvedDrafts, selection: unresolvedSelection }
      this.scheduleRestoreRetry()
    }
    this.persist()
  }

  /** Retries locating drafts/selection left unresolved by restoreLifecycle — boot() runs
   * before the framework mounts, so the first pass often finds nothing. Ticks every 300ms
   * for up to 40 attempts (~12s bounded window) rather than forever, so an app that never
   * renders the tagged element (e.g. it was deleted by the agent) doesn't leak a timer. */
  private scheduleRestoreRetry(attempt = 0): void {
    if (this.restoreTimer) clearTimeout(this.restoreTimer)
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null
      const pending = this.pendingRestore
      if (!pending) return
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
      if (this.selection.length === 0 && pending.selection.length > 0) {
        const located = pending.selection
          .map((sel) => locateBySource(sel.dcSource, sel.index))
          .filter((el): el is TaggedElement => el !== null)
        if (located.length === pending.selection.length) {
          this.setSelection(located)
          pending.selection = []
        }
      }
      const attemptsLeft = attempt + 1 < 40
      if ((pending.drafts.length > 0 || pending.selection.length > 0) && attemptsLeft) {
        this.scheduleRestoreRetry(attempt + 1)
        return
      }
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
      watchIndicatorFor(this.watch.current(), agent)
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
  if (saved?.designModeOn) mode.restoreLifecycle(saved)
}

if (typeof document !== 'undefined' && !import.meta.vitest) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
}

import { Overlay } from './overlay'
import { findTaggedElement, type TaggedElement } from './source'
import { buildInspectorData } from './inspector'
import { DraftStore } from './drafts'
import { Panel } from './panel'
import { buildChangeRequestWithElements, renderMarkdown } from './request'
import { SentRegistry } from './sent'
import { Verifier } from './verifier'
import { snapshotRects, diffRects } from './ripple'
import { resetTokensCache } from './tokens'

/** Rapid edits (e.g. dragging a number field) within this window reuse the first snapshot. */
const RIPPLE_DEBOUNCE_MS = 300

declare global {
  interface Window {
    __THE_FORGE__?: { mode: DesignMode }
  }
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
  private verifier: Verifier
  private verifierSummary = ''
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

  constructor(
    private overlay: Overlay,
    panel?: Panel,
    drafts?: DraftStore
  ) {
    this.drafts = drafts ?? new DraftStore()
    this.panel =
      panel ??
      new Panel(
        this.drafts,
        () => this.handleEdited(),
        (el) => this.handleBeforeEdit(el)
      )
    this.verifier = new Verifier(this.sent, this.drafts, (summary) => {
      this.verifierSummary = summary
      this.refreshStatus()
      // a commit/mismatch may change the computed style of the element the panel is
      // currently showing (or the selection outline's geometry) — refresh both.
      this.panel.refresh()
      this.remeasure()
    })
    overlay.toggle.addEventListener('click', () => this.setActive(!this.active))
    overlay.sendButton.addEventListener('click', () => {
      if (overlay.sendButton.disabled) return // re-entrancy guard: a POST is already in flight
      const originalLabel = 'Send to agent'
      const { request, elements } = buildChangeRequestWithElements(this.drafts)
      const md = renderMarkdown(request)
      const onSendFailed = (): void => {
        overlay.sendButton.disabled = false
        this.flashButton(overlay.sendButton, 'Send failed', originalLabel)
      }
      const onSendOk = (id: string): void => {
        const mapping = [...elements.entries()].map(([el, change]) => ({
          el,
          dcSource: el.dataset.dcSource ?? null,
          draftProps: [...(this.drafts.entries().get(el)?.keys() ?? [])],
          changes: change.changes.map((c) => ({ property: c.property, afterCss: c.afterCss })),
        }))
        this.sent.add(id, mapping)
        this.verifier.start()
        overlay.sendButton.disabled = false
        this.flashButton(overlay.sendButton, 'Sent ✓', originalLabel)
        this.onSendComplete?.()
      }
      overlay.sendButton.disabled = true
      // nesting is deliberate: the send test counts microtask ticks — re-check it before flattening to async/await
      fetch('/__the-forge/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const md = renderMarkdown(buildChangeRequestWithElements(this.drafts).request)
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
    this.drafts.onChange = () => this.refreshStatus()
  }

  get panelRoot(): HTMLElement {
    return this.panel.root
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
      this.refreshStatus()
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
      this.drafts.compareAll(false) // previews survive exit — never leave the page stranded on "before"
      this.panel.hide()
      this.verifier.stop()
    }
  }

  private refreshStatus(): void {
    if (!this.active) return
    this.overlay.updateStatus(this.drafts.elementCount(), this.drafts.isComparingAll(), this.verifierSummary || undefined)
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
  window.__THE_FORGE__ = { mode }
}

if (typeof document !== 'undefined' && !import.meta.vitest) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
}

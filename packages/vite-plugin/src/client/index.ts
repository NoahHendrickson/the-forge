import { Overlay } from './overlay'
import { findTaggedElement, type TaggedElement } from './source'
import { buildInspectorData } from './inspector'
import { DraftStore } from './drafts'
import { Panel } from './panel'
import { buildChangeRequestWithElements, renderMarkdown } from './request'
import { SentRegistry } from './sent'
import { Verifier } from './verifier'
import { snapshotRects, diffRects } from './ripple'

/** Rapid edits (e.g. dragging a number field) within this window reuse the first snapshot. */
const RIPPLE_DEBOUNCE_MS = 300

declare global {
  interface Window {
    __THE_FORGE__?: { mode: DesignMode }
  }
}

export class DesignMode {
  active = false
  selected: TaggedElement | null = null
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
  // A rapid burst of edits (e.g. dragging a number field) reuses the FIRST snapshot
  // in the burst until RIPPLE_DEBOUNCE_MS of quiet, so ripples reflect drag-start ->
  // drag-end, not per-tick noise.
  private rippleSnapshot: Map<TaggedElement, DOMRect> | null = null
  private rippleSnapshotFor: TaggedElement | null = null
  private lastEditAt = 0

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

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    this.overlay.setActive(on)
    if (on) {
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
      this.rippleSnapshot = null
      this.rippleSnapshotFor = null
      this.lastEditAt = 0
      this.lastMove = null
      this.selected = null
      this.drafts.compareAll(false) // previews survive exit — never leave the page stranded on "before"
      this.panel.hide()
      this.verifier.stop()
    }
  }

  private refreshStatus(): void {
    if (!this.active) return
    this.overlay.updateStatus(this.drafts.elementCount(), this.drafts.isComparingAll(), this.verifierSummary || undefined)
  }

  select(el: TaggedElement): void {
    this.selected = el
    this.rippleSnapshot = null
    this.rippleSnapshotFor = null
    this.lastEditAt = 0
    this.overlay.showSelectOutline(el.getBoundingClientRect())
    this.panel.show(el, buildInspectorData(el))
  }

  deselect(): void {
    this.selected = null
    this.rippleSnapshot = null
    this.rippleSnapshotFor = null
    this.lastEditAt = 0
    this.overlay.hideSelectOutline()
    this.panel.hide()
  }

  private remeasure(): void {
    if (this.selected) this.overlay.showSelectOutline(this.selected.getBoundingClientRect())
  }

  /** Panel's pre-hook, called immediately before drafts.apply() for every control edit. */
  private handleBeforeEdit(el: TaggedElement): void {
    const now = Date.now()
    // Reuse the in-flight snapshot while edits keep arriving within the debounce
    // window (a scrub/drag burst) — only take a fresh one after a quiet gap or
    // when the edited element changes (re-selection within the debounce window).
    if (!this.rippleSnapshot || this.rippleSnapshotFor !== el || now - this.lastEditAt > RIPPLE_DEBOUNCE_MS) {
      this.rippleSnapshot = snapshotRects(el)
      this.rippleSnapshotFor = el
    }
    this.lastEditAt = now
  }

  /** Panel's post-hook, called after drafts.apply() for every control edit. */
  private handleEdited(): void {
    this.remeasure()
    if (this.rippleRaf) cancelAnimationFrame(this.rippleRaf)
    this.rippleRaf = requestAnimationFrame(() => {
      this.rippleRaf = 0
      const snapshot = this.rippleSnapshot
      if (!snapshot) return
      this.rippleSnapshot = null
      const changed = diffRects(snapshot)
      if (changed.length > 0) this.overlay.showRipples(changed.map((el) => el.getBoundingClientRect()))
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
      if (el && el !== this.selected) this.overlay.showOutline(el.getBoundingClientRect())
      else this.overlay.hideOutline()
    })
  }

  private onClick = (e: MouseEvent): void => {
    if (this.overlay.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    const el = findTaggedElement(e.target as Element)
    if (el) this.select(el)
    else this.deselect()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (this.selected) this.deselect()
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

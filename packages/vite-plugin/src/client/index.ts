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
import { AGENT_DISPLAY_NAME, type AgentName } from './agent'

/** Rapid edits (e.g. dragging a number field) within this window reuse the first snapshot. */
const RIPPLE_DEBOUNCE_MS = 300

declare global {
  interface Window {
    __THE_FORGE__?: { mode: DesignMode; secret?: string; agent?: AgentName }
  }
}

type Rung = 'channels' | 'tmux' | 'applescript' | 'deeplink' | 'manual'

/** Maps a dispatch rung to the Send button's flash label. Request content never appears here —
 * only the fixed per-rung copy and (for 'manual') the configured agent's display name. */
function sentLabelFor(rung: Rung, agent: AgentName): string {
  if (rung === 'deeplink') return 'Sent — opened in Cursor'
  // Explicit allowlist for the "typed into your session" copy — the rung value actually arrives
  // over the network as untyped JSON (see the /dispatch fetch handler below), so any value that
  // isn't recognizably tmux/applescript (a typo, a future rung, a server bug) must default to
  // the manual label rather than falsely claiming a terminal was typed into.
  if (rung === 'tmux' || rung === 'applescript') return 'Sent — typed /forge-design into your session'
  return `Sent — type /forge-design in ${AGENT_DISPLAY_NAME[agent]}` // manual / channels / unrecognized
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
  private verifier: Verifier
  private verifierSummary = ''
  private buttonTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  // Layout-ripple state: idle-zero — only populated during the post-edit window.
  // A rapid burst of edits (e.g. dragging a number field) reuses the FIRST snapshot
  // in the burst until RIPPLE_DEBOUNCE_MS of quiet, so ripples reflect drag-start ->
  // drag-end, not per-tick noise. The snapshot is cleared by a quiet-window TIMER
  // (reset on every edit), not by the rAF that runs the diff — the rAF must leave the
  // snapshot alive so the NEXT edit in a burst still diffs against the drag-start
  // baseline instead of re-baselining every frame.
  private rippleSnapshot: Map<TaggedElement, DOMRect> | null = null
  private rippleSnapshotFor: TaggedElement | null = null
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
      // Dispatch reaches for the user's already-RUNNING agent session (tmux/AppleScript/Cursor
      // deeplink) so they never have to type anything but Enter — see server/dispatch.ts. A
      // dispatch failure (network hiccup, non-200) must NOT undo the send: the request is
      // already safely queued, so we degrade to the same copy as rung 'manual'.
      const agent: AgentName = window.__THE_FORGE__?.agent ?? 'claude-code'
      const manualLabel = sentLabelFor('manual', agent)
      const onDispatchSettled = (rung: Rung | null): void => {
        overlay.sendButton.disabled = false
        this.flashButton(overlay.sendButton, rung ? sentLabelFor(rung, agent) : manualLabel, originalLabel)
        this.onSendComplete?.()
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
    this.rippleSnapshot = null
    this.rippleSnapshotFor = null
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
    // Reuse the in-flight snapshot while edits keep arriving within the debounce
    // window (a scrub/drag burst) — only take a fresh one after a quiet gap or
    // when the edited element changes (re-selection within the debounce window).
    if (!this.rippleSnapshot || this.rippleSnapshotFor !== el || now - this.lastEditAt > RIPPLE_DEBOUNCE_MS) {
      this.rippleSnapshot = snapshotRects(el)
      this.rippleSnapshotFor = el
    }
    this.lastEditAt = now
    // Reset the quiet-window timer on every edit — it (not the per-frame rAF) is what
    // retires the snapshot, so a burst of edits keeps diffing against the SAME
    // drag-start baseline instead of re-baselining every frame.
    if (this.rippleQuietTimer) clearTimeout(this.rippleQuietTimer)
    this.rippleQuietTimer = setTimeout(() => {
      this.rippleQuietTimer = null
      this.rippleSnapshot = null
      this.rippleSnapshotFor = null
      this.lastEditAt = 0
    }, RIPPLE_DEBOUNCE_MS)
  }

  /** Panel's post-hook, called after drafts.apply() for every control edit. */
  private handleEdited(): void {
    this.remeasure()
    if (this.rippleRaf) cancelAnimationFrame(this.rippleRaf)
    this.rippleRaf = requestAnimationFrame(() => {
      this.rippleRaf = 0
      // NOTE: do NOT null rippleSnapshot here — it must survive so the next edit in a
      // burst still diffs against the drag-start baseline. The quiet-window timer in
      // handleBeforeEdit is solely responsible for retiring it.
      const snapshot = this.rippleSnapshot
      if (!snapshot) return
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
}

if (typeof document !== 'undefined' && !import.meta.vitest) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
}

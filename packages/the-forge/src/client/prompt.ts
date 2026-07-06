import { createButton } from './ui/button'
import type { TaggedElement } from './source'

/** Gap between the anchor element's rect and the box, and the viewport clamp margin. */
const GAP = 8

/** Floating free-form prompt box, anchored to the selected element (spec
 * 2026-07-05-prompt-mode). Dumb on purpose: it owns text entry, anchoring, and busy state;
 * the HOST (DesignMode) owns what "send" means (queue POST, seeds, dispatch) via onSend and
 * decides when to close (queue success) vs un-busy (queue failure). Scroll/resize reposition
 * listeners exist ONLY while open — zero idle overhead, same rule as design mode's own
 * document listeners (index.ts setActive). */
export class PromptBox {
  root = document.createElement('div')
  textarea = document.createElement('textarea')
  sendButton = createButton({ label: 'Send', className: 'prompt-send' })

  /** Host-assigned send handler; called with trimmed, non-empty text while not busy. */
  onSend: (text: string) => void = () => {}

  private anchor: TaggedElement | null = null
  private busy = false

  constructor() {
    this.root.className = 'prompt-box'
    this.root.hidden = true
    this.textarea.className = 'prompt-textarea'
    this.textarea.placeholder = 'Describe the change…'
    this.textarea.rows = 3
    this.textarea.addEventListener('input', () => this.syncSendDisabled())
    this.textarea.addEventListener('keydown', (e) => {
      // Esc closes the BOX only — stopPropagation keeps DesignMode's document-capture Escape
      // (deselect/exit, index.ts onKey) out of it. onKey also ignores overlay-internal targets
      // via overlay.contains(), so this is belt-and-braces, not the only line of defense.
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        this.trySend()
      }
    })
    this.sendButton.addEventListener('click', () => this.trySend())
    this.root.append(this.textarea, this.sendButton)
  }

  /** Reposition on scroll/resize while open — capture-phase scroll like index.ts onReflow,
   * since scroll events don't bubble from inner containers. */
  private reposition = (): void => {
    if (this.anchor && this.anchor.isConnected) this.place(this.anchor.getBoundingClientRect())
  }

  open(anchor: TaggedElement): void {
    this.anchor = anchor
    if (this.root.hidden) {
      this.root.hidden = false
      window.addEventListener('scroll', this.reposition, { capture: true, passive: true })
      window.addEventListener('resize', this.reposition, { passive: true })
    }
    this.syncSendDisabled()
    this.place(anchor.getBoundingClientRect())
    this.textarea.focus()
  }

  close(): void {
    if (this.root.hidden) return
    this.root.hidden = true
    this.anchor = null
    this.busy = false
    this.textarea.value = '' // discard on close — spec'd v1 behavior, no draft-restore
    this.textarea.disabled = false
    this.syncSendDisabled()
    window.removeEventListener('scroll', this.reposition, true)
    window.removeEventListener('resize', this.reposition)
  }

  isOpen(): boolean {
    return !this.root.hidden
  }

  /** True while the queue POST is in flight — the host clears it via close() (success) or
   * setBusy(false) (failure, box stays open so the text isn't lost). */
  setBusy(on: boolean): void {
    this.busy = on
    this.textarea.disabled = on
    this.syncSendDisabled()
  }

  private trySend(): void {
    const text = this.textarea.value.trim()
    if (!text || this.busy) return
    this.onSend(text)
  }

  private syncSendDisabled(): void {
    this.sendButton.disabled = this.busy || this.textarea.value.trim() === ''
  }

  /** Below the anchor first; flips above when below would clip and above fits; clamps into the
   * viewport with a GAP margin either way. position:fixed coordinates — same space as the
   * overlay's outlines. */
  private place(rect: DOMRect): void {
    const w = this.root.offsetWidth
    const h = this.root.offsetHeight
    let top = rect.bottom + GAP
    if (top + h > window.innerHeight && rect.top - GAP - h >= 0) top = rect.top - GAP - h
    const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - w - GAP))
    this.root.style.top = `${Math.max(GAP, top)}px`
    this.root.style.left = `${left}px`
  }
}

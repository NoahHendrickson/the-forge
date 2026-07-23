import type { DraftStore } from './drafts'
import { isEditable } from './canvas'
import { isTextLeaf } from './panel-readers'
import { findTaggedElement, type TaggedElement } from './source'

/** What TextEditMode needs from its host (DesignMode) — selection, the ripple hooks, and
 * hover chrome. Injected so the mode stays free of DesignMode/Overlay imports. */
export interface TextEditHooks {
  /** Single-select the element about to be edited. */
  select(el: TaggedElement): void
  /** True when `el` is already the ONLY selected element — begin() skips the re-select. */
  isSoleSelection(el: TaggedElement): boolean
  /** Ripple pre-hook (drag-start baseline) — the same hook panel edits go through. */
  beforeEdit(el: TaggedElement): void
  /** Ripple post-hook. */
  edited(): void
  /** Hide the hover outline when an edit session opens. */
  hideHover(): void
}

const denbsp = (s: string): string => s.replace(/\u00a0/g, ' ')

/** The inline text-edit mode (Figma pivot P1): double-click a text-leaf element →
 * contenteditable session → Esc/Enter/blur/outside-click commits a text draft.
 *
 * Extracted from DesignMode (PR #44 follow-up) — the same self-contained-mode shape
 * canvas.ts was carved out for, back when index.ts pushed past 1k lines. DesignMode's
 * capture handlers remain the owners of DOM events (registration/teardown stays in
 * setActive, keeping idle-zero untouched); they delegate their text-editing branches here:
 * candidate() gates the dblclick verb, handleClick()/handleKey() own the mid-edit event
 * policy, begin()/finish() own the session lifecycle. */
export class TextEditMode {
  private editing: TaggedElement | null = null
  /** textContent at edit START — the draft's true "before". Captured here because by commit
   * time the DOM already shows whatever the user typed (see DraftStore.applyText's hint). */
  private original = ''

  constructor(
    private drafts: DraftStore,
    private hooks: TextEditHooks
  ) {}

  /** True while an edit session is open — hover/keydown handling yields to the browser. */
  get active(): boolean {
    return this.editing !== null
  }

  /** The dblclick verb's gate — returns the editable element, or null when the gesture must
   * fall through untouched (so the caller only preventDefaults a consumed event). */
  candidate(target: EventTarget | null): TaggedElement | null {
    // Same typing-surface guard as the Del branch: a double-click inside a real form
    // control is a select-the-word gesture in THAT control — without this, the tagged
    // ancestor (e.g. a <label>) goes contenteditable with the control inside the
    // selectNodeContents range, and the first keystroke deletes it from the live DOM
    // (PR #44 review).
    if (isEditable(target)) return null
    const el = findTaggedElement(target as Element)
    // isTextLeaf, NOT hasDirectText: the flat-textContent draft model destroys element
    // children of mixed-content elements — see panel-readers.ts (PR #44 review).
    if (!el || !isTextLeaf(el)) return null
    return el
  }

  /** The text-editing branch of the host's capture onClick. 'shielded' means the event was
   * fully handled here (caller returns); 'committed' and 'idle' fall through to selection. */
  handleClick(e: MouseEvent): 'idle' | 'shielded' | 'committed' {
    if (!this.editing) return 'idle'
    // Clicks inside the editing element place the caret — the browser's job, and it
    // happens on MOUSEDOWN default, so shielding the click costs the caret nothing. The
    // shield is still mandatory here: the host's listener is document-CAPTURE, above
    // React's root delegation, and contenteditable only suppresses the native <a> default
    // — a react-router Link or modal-opening handler on the edited element would otherwise
    // fire on a caret-repositioning click and navigate mid-edit, after which blur commits
    // the half-finished draft against a changed page (PR #44 review).
    if (this.editing.contains(e.target as Node)) {
      e.preventDefault()
      e.stopPropagation()
      return 'shielded'
    }
    // A click anywhere else commits the edit and falls through to normal selection.
    this.finish()
    return 'committed'
  }

  /** The text-editing branch of the host's capture onKey — true when the mode owns the
   * event (the caller returns without its own key handling). */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.editing) return false
    // Esc and Enter both commit (Figma: Esc commits text; P1 has no multi-line intent for
    // Enter, so it commits too rather than inserting a newline). Everything else — typing,
    // arrows, shortcuts — belongs to the contenteditable.
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      this.finish()
    }
    return true
  }

  begin(el: TaggedElement): void {
    if (!(el instanceof HTMLElement)) return // contenteditable is an HTMLElement affair — SVG text is out of P1's scope
    if (this.editing === el) return
    this.finish()
    if (!this.hooks.isSoleSelection(el)) this.hooks.select(el)
    this.editing = el
    this.original = el.textContent ?? ''
    this.hooks.hideHover()
    // plaintext-only keeps paste/typing from minting nested markup the tagger never saw.
    // Set as an ATTRIBUTE, not the property: jsdom's property setter doesn't reflect to the
    // attribute (breaking the browser's own [contenteditable] activation contract in tests).
    // contenteditable is an ENUMERATED attribute — an unrecognized keyword resolves to the
    // INHERIT state (NOT editable; pre-136 Firefox shipped exactly that silently-dead mode),
    // so feature-detect via isContentEditable and fall back to 'true': rich editing loses
    // the plaintext guard but keeps the feature alive (PR #44 review). Strict `=== false`:
    // jsdom doesn't implement isContentEditable (undefined), and must keep plaintext-only.
    el.setAttribute('contenteditable', 'plaintext-only')
    if (el.isContentEditable === false) el.setAttribute('contenteditable', 'true')
    el.addEventListener('blur', this.onBlur)
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  private onBlur = (): void => {
    this.finish()
  }

  /** Commits the inline edit into a text draft. Always safe to call — no-op when not editing;
   * applyText itself no-ops when the text is unchanged, so an idle in-and-out leaves nothing. */
  finish(): void {
    const el = this.editing
    if (!el) return
    this.editing = null
    el.removeEventListener('blur', this.onBlur)
    el.removeAttribute('contenteditable')
    window.getSelection()?.removeAllRanges()
    // Browsers rebalance collapsible spaces (trailing, consecutive) to U+00A0 inside
    // contenteditable — plaintext-only included. The committed value is both the agent's ask
    // and the verifier's textContent oracle, and the agent writes ordinary spaces in JSX, so
    // an un-normalized nbsp would land the row in a terminal 'mismatch' whose expected and
    // actual render identically (PR #44 review). The unchanged-check normalizes BOTH sides
    // so an idle in-and-out on nbsp-bearing source text stays a no-op.
    const value = denbsp(el.textContent ?? '')
    if (value === denbsp(this.original)) {
      // Unchanged (modulo nbsp) — put the verbatim original back: the browser may have
      // swapped spaces for nbsp while the element was editable.
      el.textContent = this.original
      return
    }
    this.hooks.beforeEdit(el)
    this.drafts.applyText(el, value, this.original)
    this.hooks.edited()
  }
}

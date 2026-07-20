// Not EventSource: EventSource cannot send custom request headers. The event stream
// requires X-Forge-Secret for auth (same as all mutating endpoints), so we use
// fetch + ReadableStream + manual NDJSON parsing instead.
import { createButton } from './ui/button'
import { CHAT_TEXT_MAX, type HarnessId } from '../shared/chat-constants'
import { ComposerConfig } from './composer-config'
import { FeedAnchor } from './feed-anchor'
import { type SessionState } from './watch'
import { popOnce } from './motion'
import {
  makeApprovalRow, makeAssistantBubble, makeConfigRow, makeErrorRow, makeToolRow,
  makeTurnDoneRow, makeUserBubble, makeWorkingRow, markToolFinished, setAssistantContent,
} from './chat-rows'

// Shared untyped-JSON guard for the edit payload carried by tool-started AND (Cursor's
// late-diff path) tool-finished — the wire outlives any one bundle build, so shape is checked
// at runtime, never trusted from the type.
function parseEditPayload(raw: unknown): { file: string; before: string; after: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const e = raw as Record<string, unknown>
  return typeof e.file === 'string' && typeof e.before === 'string' && typeof e.after === 'string'
    ? { file: e.file, before: e.before, after: e.after }
    : undefined
}

/** The textarea's autosize growth cap — roughly seven lines; past it the textarea scrolls
 * internally (every modern composer caps growth so the feed keeps most of the panel). */
const TEXTAREA_MAX_PX = 140

// ---------------------------------------------------------------------------
// Stream line types (NDJSON, one object per line)
// ---------------------------------------------------------------------------

type StreamLine =
  | { type: 'feed'; seq: number; at: string; event: SessionEvent }
  | { type: 'approval'; id: string; toolName: string; detail: string }
  | { type: 'approval-resolved'; id: string; allow: boolean }

type SessionEvent =
  | { kind: 'started'; sessionId: string; model: string; mcpLoaded: boolean }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'user-text'; text: string; element?: { source: string; tag: string } }
  // assistant-delta always arrives with seq 0 — ephemeral, subscriber-only, never ringed
  // (see parseLine's seq-tracking below).
  | { kind: 'assistant-delta'; text: string }
  | { kind: 'tool-started'; toolId: string; name: string; detail: string; edit?: { file: string; before: string; after: string } }
  // tool-finished's edit mirrors the server union's late-arriving-diff extension: Cursor
  // delivers an edit's before/after on the terminal tool_call_update, so the diff can only
  // ride tool-finished there; Claude's diffs always arrive on tool-started.
  | { kind: 'tool-finished'; toolId: string; edit?: { file: string; before: string; after: string } }
  | { kind: 'turn-complete'; isError: boolean; errorText?: string; costUsd?: number }
  // harness mirrors adapter.ts's server-side SessionEvent (Task 2) — a deliberately separate
  // copy, not a shared import, so a stale client bundle stays tolerant of a rebuilt server
  // (see the untyped-JSON guards throughout this module's event parsing).
  | { kind: 'config-changed'; model?: string; permissionMode?: string; effort?: string; harness?: HarnessId }
  | { kind: 'session-error'; text: string }
  | { kind: 'ended' }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROWS = 200
// Reconnect backoff: 1s doubling to 30s cap. On 404 (unavailable), park at the cap
// immediately to avoid log spam when no session is wired.
const BACKOFF_INIT_MS = 1_000
const BACKOFF_CAP_MS = 30_000

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SessionFeedOpts {
  /** Factory for request headers — index.ts passes forgeSecretHeaders; tests pass a stub. */
  headers?: () => Record<string, string>
  /** Override fetch — lets tests drive a scripted ReadableStream without network. */
  fetchFn?: typeof fetch
}

export class SessionFeed {
  /** The section root — class="session-feed"; host appends this to panel.feedSlot. */
  root: HTMLElement
  /** .draft-disclosure content host — index.ts appends the (unmodified) ChangeList's root
   * here instead of the panel's old dedicated changesSlot (composer consolidation Task 2). */
  draftSlot: HTMLElement
  /** Called when the user clicks Stop — host wires to POST /__the-forge/session/interrupt. */
  onInterrupt: () => void = () => {}
  /** Called when user clicks Allow/Deny on an approval row — host wires to the decide endpoint. */
  onDecide: (id: string, allow: boolean) => void = () => {}
  /** Called on Send (click or Cmd/Ctrl-Enter) once the textarea holds non-empty text (or, since
   * composer consolidation Task 3, whenever there are drafts to send even with an empty
   * textarea — see trySend's guard). The feed itself is deliberately verb-agnostic — it does not
   * decide what "sending" means; that used to be its own `onSay` hook's job (invoked directly
   * from trySend), which was deleted from this public surface by the composer-send extraction —
   * the chat POST now lives in ComposerSend#postSay (composer-send.ts), reached only via
   * getText()/getChip()/clearText()/setChip(null) below, same as before. The host wires onSend
   * to whatever it wants sending to do, calling clearText()/setChip(null) itself once it decides
   * the send succeeded (composer consolidation Task 1; Task 3 wires the real send-everything
   * verb — drafts + say, one gesture — via ComposerSend). */
  onSend: () => void = () => {}
  /** Called when the harness, model, effort, or permission picker changes, with ONLY the
   * changed key — host wires to POST /__the-forge/session/config (index.ts forwards the whole
   * object unchanged, so widening this union is the only wiring index.ts needs for a new key). */
  onConfig: (cfg: { model?: string; permissionMode?: string; effort?: string; harness?: HarnessId }) => void = () => {}

  private readonly list: HTMLElement

  // --- config pickers: harness, model, effort, and permission — live in .composer-controls,
  // owned by ComposerConfig (composer-config.ts, extracted PR #32); SessionFeed mounts its
  // selects and drives its seed methods from the stream handlers. ---
  private readonly config: ComposerConfig

  // --- chat composer (composer consolidation Task 1): the single bordered card holding the
  // chip row, textarea, and controls row ---
  private readonly chatComposer: HTMLElement
  private readonly composerChips: HTMLElement
  private readonly composerControls: HTMLElement
  // --- drafts pill + disclosure (composer consolidation Task 2): draftPill is the single
  // unified chip — it absorbed the old separate element chip (chat-composer-chip spec) and
  // renders drafts count, element label, or both. draftDisclosure is a block above .chat-input
  // that the pill's click toggles open/closed via the .open class — a details-free div toggle
  // (no <details> semantics needed, there's only ever one thing to show/hide). draftSlot
  // (public) is the content host inside it. ---
  private readonly draftPill: HTMLButtonElement
  private readonly draftPillLabel: HTMLSpanElement
  private readonly draftPillEl: HTMLSpanElement
  private readonly draftChevron: HTMLSpanElement
  private readonly pillClear: HTMLButtonElement
  private readonly draftDisclosure: HTMLElement

  // --- attached-element state + input cluster ---
  private readonly inputCluster: HTMLElement
  private readonly textarea: HTMLTextAreaElement
  private readonly sendBtn: HTMLButtonElement
  private readonly disabledReason: HTMLElement
  /** The element currently attached to a pending message, set via setChip (Prompt button /
   * host) and cleared on send or the chip's own × — mirrors the old floating prompt popup's
   * single-anchor model but as host-driven state instead of an open/close popover. */
  private currentChip: { source: string; tag: string; label: string } | null = null

  // --- stream lifecycle (generation-guard pattern from Verifier/WatchStatus) ---
  /** Bumped on every start()/stop(): a fetch/timer chain under an older generation is dead
   * and must not reschedule or touch state — same stale-chain guard as the Verifier's poll loop. */
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private controller: AbortController | null = null
  /** Highest feed seq seen so far; sent as ?since= on reconnect so the server replays only
   * new events (the ring buffer replays from seq+1 on reconnect, making reconnects seamless). */
  private lastSeq = 0
  /** Current reconnect delay — resets to BACKOFF_INIT_MS on a successful line, doubles on
   * failure/stream-close, capped at BACKOFF_CAP_MS. */
  private backoffMs = BACKOFF_INIT_MS

  // --- render bookkeeping ---
  /** toolId → row element; lets tool-finished flip the spinner to ✓ by pairing. */
  private readonly toolRows = new Map<string, HTMLElement>()
  /** approvalId → row element; lets approval-resolved collapse the row. */
  private readonly approvalRows = new Map<string, HTMLElement>()
  /** All rows appended to this.list, in insertion order; capped at MAX_ROWS (oldest removed). */
  private readonly rowList: HTMLElement[] = []
  /** Anchor-at-top owner (feed-anchor.ts, extracted PR #35 review): the tail spacer, the
   * anchored-row bookkeeping, and the sizing math. addRow inserts rows before its `spacer`;
   * the mutation sites that must call `anchor.update()` are named in FeedAnchor's docs. */
  private readonly anchor: FeedAnchor
  /** The single in-progress .chat-streaming bubble, if any — the first seq-0 delta after a
   * non-delta event creates it; subsequent deltas append to it; the next final assistant-text
   * replaces its content and clears this back to null (no duplicate bubble). */
  private streamingBubble: HTMLElement | null = null
  /** The singleton "Thinking" placeholder (chat-ux polish) — inserted after a user-text
   * bubble, removed by the next sign of turn activity. Deliberately NOT in rowList: it is
   * ephemeral chrome, not history, so it must never consume a MAX_ROWS slot or survive as
   * a row the cap could evict out from under this reference. */
  private workingRow: HTMLElement | null = null
  /** Accumulated text of the current streaming bubble — tracked separately from the DOM node's
   * textContent so appends are O(1) string concat rather than re-reading the DOM each delta. */
  private streamingText = ''
  /** True after any tool-started/assistant-text, cleared on turn-complete/ended/session-error.
   * Drives composer-send's morph to ■ (interrupt) while a turn is in flight AND the textarea is
   * empty — see updateSendMorph(). Typing during a busy turn flips the morph back to ↑ (the
   * message queues mid-turn via the existing FIFO) so the user is never blocked from typing a
   * follow-up while the current turn is still running. */
  private busyish = false
  /** Mirrors updateSendMorph()'s last computed morph state — the click handler reads this
   * instead of recomputing busyish && textarea-empty itself. */
  private sendIsStop = false
  /** Mirrored from setDraftState's count (composer consolidation Task 3) — lets trySend's
   * empty-text guard admit a drafts-only send: the composer's ↑ is the single send surface for
   * both edits and chat, so an empty textarea must not block sending when there ARE drafts to
   * send, even though it still blocks when there is truly nothing (no text, no drafts). */
  private draftCount = 0
  /** Mirrors setDraftState's `applying` — updateChip needs both halves of the drafts signal,
   * and setDraftState must not be the only place that can recompute the pill text. */
  private draftApplying = false
  /** Mirrors setAvailability's last `enabled` value — kept alongside draftCount so
   * syncSendEnabled() can compute the send button's disabled state from both independent
   * signals without either setter having to know the other's current value (final-review fix
   * C1). Defaults true to match the button's native default-enabled state before the host's
   * first setAvailability call. */
  private sessionAvailable = true

  private readonly fetchFn: typeof fetch
  private readonly getHeaders: () => Record<string, string>

  constructor(opts: SessionFeedOpts = {}) {
    this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis)
    this.getHeaders = opts.headers ?? (() => ({}))

    this.root = document.createElement('div')
    this.root.className = 'session-feed'
    this.root.hidden = true

    this.list = document.createElement('div')
    this.list.className = 'session-list'

    this.anchor = new FeedAnchor(this.list)

    // Config pickers (harness/model/effort/permission) — owned by ComposerConfig
    // (composer-config.ts, extracted PR #32). It forwards each picker's onChange through the
    // SessionFeed.onConfig arrow below (read lazily, so index.ts reassigning onConfig after
    // construction still takes effect); its `selects` are mounted into .composer-controls
    // further down. They used to live in their own header bar (.session-config-bar, retired);
    // composer consolidation (Task 1) moved them into the composer's .composer-controls row.
    this.config = new ComposerConfig((cfg) => this.onConfig(cfg))

    // Unified chip (2026-07-12 chat-composer-chip spec): ONE chip carries both the pending-
    // drafts state and the attached element — .chat-chip retired, .draft-pill absorbed its
    // job. The visual chip (.composer-chip) holds TWO sibling buttons, because a button
    // cannot nest an interactive child: .draft-pill (count label + element label + chevron;
    // click toggles the sibling draftDisclosure's .open class, drafts permitting) and
    // .draft-pill-clear (× — detaches the element, the old .chat-chip-clear contract: no
    // host callback, hosts read the element via getChip()). Both are createButton (CLAUDE.md
    // ui/ factory rule). All label/visibility rendering flows through updateChip() — the
    // single owner — so setChip and setDraftState can each fire without knowing the other's
    // state. .open is mirrored onto the pill itself so the chevron can rotate with a
    // same-element CSS hook (the disclosure is a sibling, not a parent).
    this.draftPill = createButton({ className: 'draft-pill' })
    this.draftPill.type = 'button'
    this.draftPillLabel = document.createElement('span')
    this.draftPillLabel.className = 'draft-pill-label'
    this.draftPillEl = document.createElement('span')
    this.draftPillEl.className = 'draft-pill-el'
    this.draftPillEl.hidden = true
    this.draftChevron = document.createElement('span')
    this.draftChevron.className = 'draft-pill-chevron'
    this.draftChevron.textContent = '▾'
    this.draftChevron.setAttribute('aria-hidden', 'true')
    this.draftPill.append(this.draftPillLabel, this.draftPillEl, this.draftChevron)
    this.draftPill.addEventListener('click', () => {
      if (this.draftCount > 0 || this.draftApplying) {
        this.setDisclosureOpen(!this.draftDisclosure.classList.contains('open'))
      }
    })
    this.pillClear = createButton({ label: '×', className: 'draft-pill-clear' })
    this.pillClear.type = 'button'
    this.pillClear.setAttribute('aria-label', 'Detach element')
    this.pillClear.hidden = true
    this.pillClear.addEventListener('click', () => this.setChip(null))
    const composerChip = document.createElement('div')
    composerChip.className = 'composer-chip'
    composerChip.append(this.draftPill, this.pillClear)

    this.draftSlot = document.createElement('div')
    this.draftSlot.className = 'draft-slot'
    this.draftDisclosure = document.createElement('div')
    this.draftDisclosure.className = 'draft-disclosure'
    this.draftDisclosure.append(this.draftSlot)

    // Composer chip row — hidden-attr managed by updateChip (the old `.composer-chips:empty`
    // CSS can't work anymore: the unified chip is always a child, just sometimes blank).
    this.composerChips = document.createElement('div')
    this.composerChips.className = 'composer-chips'
    this.composerChips.hidden = true
    this.composerChips.append(composerChip)

    // Input cluster: plain createElement for the textarea (no factory exists for it, per
    // CLAUDE.md's ui/ factory rule — that rule covers buttons/selects). Send now lives in
    // .composer-controls, one row below, not in here (composer consolidation Task 1).
    this.inputCluster = document.createElement('div')
    this.inputCluster.className = 'chat-input'
    this.disabledReason = document.createElement('div')
    this.disabledReason.className = 'chat-disabled-reason'
    this.disabledReason.hidden = true
    this.textarea = document.createElement('textarea')
    this.textarea.className = 'chat-textarea'
    this.textarea.placeholder = 'Message, or send your edits…'
    this.textarea.rows = 2
    // Mirrors CHAT_TEXT_MAX (src/shared/chat-constants.ts, also consumed by server/endpoints.ts)
    // — the server 400s past this length anyway; capping client-side stops the user from typing
    // a message the send can never succeed at.
    this.textarea.maxLength = CHAT_TEXT_MAX
    this.textarea.addEventListener('keydown', (e) => {
      // Plain Enter SENDS; Shift+Enter inserts the newline (2026-07-18 chat-ux polish —
      // the universal chat-composer convention: ChatGPT/Cursor/claude.ai all treat Enter as
      // send; the old Cmd/Ctrl-Enter-only contract dated from the prompt-mode popup era,
      // before this was a chat surface). Cmd/Ctrl-Enter still lands in the same branch
      // (they're Enter without Shift), so trained fingers keep working. The isComposing
      // guard keeps Enter-to-commit inside an IME composition from firing a send.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        this.trySend()
      }
      // Escape is deliberately NOT stopPropagation'd here (unlike the old floating prompt
      // popup's local handler): index.ts's onKey already ignores every overlay-internal target via
      // overlay.contains(e.target) — since this textarea lives inside the panel, which is
      // itself inside the overlay's shadow host, that guard alone already keeps Escape from
      // deselecting/deactivating while typing. See design-mode.test.ts for the proof.
    })
    // Re-evaluate the send↔stop morph on every keystroke — typing during a busy turn must
    // flip ■ back to ↑ immediately (a mid-turn message queues via the existing FIFO), not just
    // whenever busyish itself next transitions. Autosize rides the same event: the textarea
    // grows with typed content up to TEXTAREA_MAX_PX, then scrolls (chat-ux polish).
    this.textarea.addEventListener('input', () => {
      this.updateSendMorph()
      this.autosize()
    })
    this.inputCluster.append(this.composerChips, this.disabledReason, this.textarea)

    // Composer send/stop button: morphs between ↑ (send, fires onSend) and ■ (interrupt, fires
    // onInterrupt) — see updateSendMorph()/sendIsStop. Kept on BOTH .composer-send (the new
    // hook) and the legacy .chat-send class — CSS class names are test hooks, extend don't
    // rename, and design-mode.test.ts's existing Send-click assertions still query .chat-send.
    this.sendBtn = createButton({ label: '↑', className: 'composer-send chat-send' })
    this.sendBtn.type = 'button'
    this.sendBtn.setAttribute('aria-label', 'Send')
    this.sendBtn.addEventListener('click', () => {
      if (this.sendIsStop) {
        this.onInterrupt()
        return
      }
      this.trySend()
    })

    const composerSpacer = document.createElement('div')
    composerSpacer.className = 'composer-spacer'
    this.composerControls = document.createElement('div')
    this.composerControls.className = 'composer-controls'
    // Spread ComposerConfig's four selects directly (not a wrapper) so they stay direct flex
    // children of .composer-controls in harness/model/effort/permission order, byte-identical
    // to the pre-extraction DOM.
    this.composerControls.append(...this.config.selects, composerSpacer, this.sendBtn)

    // The single bordered composer card (composer consolidation Task 1) — replaces the retired
    // status row, standalone Stop button, and .session-config-bar. draftDisclosure sits ABOVE
    // .chat-input: it hosts the ChangeList, which can grow to its own max-height — above the
    // input/controls rows is the only position that never pushes the textarea around when it
    // opens. The chips row now lives inside the input box itself (chat-composer-chip spec,
    // Task 2), appended to inputCluster above. Task 4 adds the draggable divider above
    // .session-feed.
    this.chatComposer = document.createElement('div')
    this.chatComposer.className = 'chat-composer'
    this.chatComposer.append(this.draftDisclosure, this.inputCluster, this.composerControls)

    this.root.append(this.list, this.chatComposer)
    this.updateSendMorph()
  }

  /** Attaches (or clears, with `null`) the element a pending message will reference — Prompt
   * button sets this via the host; the chip's own × also routes here. No longer cleared by
   * trySend itself (composer consolidation Task 1) — the feed's send gesture doesn't know
   * whether a send "succeeded", so it's the host's onSend implementation that calls
   * setChip(null) once it decides the send is done, same as it now clears the text via
   * clearText(). */
  setChip(el: { source: string; tag: string; label: string } | null): void {
    this.currentChip = el
    this.updateChip()
  }

  /** Focuses the chat textarea — the Prompt button's new job (index.ts) is setChip + focus,
   * replacing the old floating prompt popup's open(anchor). */
  focusInput(): void {
    this.textarea.focus()
  }

  /** Pushes the drafts-pill display state (composer consolidation Task 2) — index.ts calls
   * this from both the drafts store's onChange (count) and the lifecycle session's onChange
   * (applying), so either can independently flip the pill on/off without knowing about the
   * other's derivation. `applying` wins the text over a nonzero count — an in-flight send stays
   * "applying…" even while further drafts pile up behind it. Visibility/hidden-state (whole
   * chip, force-closing the disclosure) is no longer decided here — that's updateChip()'s job,
   * since the unified chip's visibility also depends on the independent element-chip signal. */
  setDraftState(s: { count: number; applying: boolean }): void {
    this.draftCount = s.count
    this.draftApplying = s.applying
    this.updateChip()
    // Draft count is one of the two independent signals that can license the send button —
    // see syncSendEnabled (final-review fix C1).
    this.syncSendEnabled()
  }

  /** Single renderer for the unified chip (chat-composer-chip spec) — setChip and
   * setDraftState both route here so either signal can flip visibility/labels without
   * knowing the other's derivation. States: drafts only → "N changes" + chevron; element
   * only → element label + ×; both → "N changes · <label>" + chevron + ×; neither → the
   * whole .composer-chips row hidden. `applying` wins the drafts text over a nonzero count —
   * an in-flight send stays "applying…" even while further drafts pile up behind it. The
   * disclosure force-close ALSO lives here (not on wrapper-hidden): the chip can stay
   * visible element-only while the drafts disclosure must still close, or an empty
   * disclosure would show a blank block once the last draft resolves. has-items on
   * .chat-input is the primed-state CSS hook (accent glow — see overlay.ts). */
  private updateChip(): void {
    const draftsVisible = this.draftCount > 0 || this.draftApplying
    const el = this.currentChip
    const visible = draftsVisible || el !== null
    this.composerChips.hidden = !visible
    this.draftPillLabel.hidden = !draftsVisible
    this.draftPillLabel.textContent = !draftsVisible
      ? ''
      : this.draftApplying
        ? 'applying…'
        : this.draftCount === 1
          ? '1 change'
          : `${this.draftCount} changes`
    this.draftPillEl.hidden = el === null
    this.draftPillEl.textContent = el === null ? '' : draftsVisible ? `· ${el.label}` : el.label
    this.draftChevron.hidden = !draftsVisible
    this.pillClear.hidden = el === null
    if (!draftsVisible) this.setDisclosureOpen(false)
    this.inputCluster.classList.toggle('has-items', visible)
  }

  /** Single owner of the disclosure's open state — mirrored onto the pill so the chevron
   * rotation has a same-element CSS hook. Every open/close path (pill click, setDraftState's
   * force-close) must come through here or pill and disclosure drift apart. */
  private setDisclosureOpen(open: boolean): void {
    this.draftDisclosure.classList.toggle('open', open)
    this.draftPill.classList.toggle('open', open)
  }

  /** Enables/disables the input cluster and shows/hides the reason line. Availability
   * derivation lives in the HOST (index.ts) — this is a dumb setter. Also unhides the feed
   * root (same as addRow, and the 'started' event handler below) so the input — and any
   * disabled-reason — is visible as soon as design mode is on, even before the embedded
   * session has emitted its first NDJSON event (a fresh session may sit at 'idle' until the
   * user's first message auto-starts it). */
  setAvailability(a: { enabled: boolean; reason?: string }): void {
    this.root.hidden = false
    // Only the TEXTAREA (the chat leg) is gated by availability now — the send button is
    // computed separately by syncSendEnabled, since drafts must stay sendable even when chat
    // is unavailable (final-review fix C1: embedded:false must not disable the whole composer,
    // only the chat leg — drafts ride the queue/watcher path that opt-out deliberately
    // preserves, and there is no other send surface left for a terminal-only consumer).
    this.textarea.disabled = !a.enabled
    this.sessionAvailable = a.enabled
    if (!a.enabled && a.reason) {
      this.disabledReason.textContent = a.reason
      this.disabledReason.hidden = false
    } else {
      this.disabledReason.hidden = true
      this.disabledReason.textContent = ''
    }
    this.syncSendEnabled()
  }

  /** Recomputes composer-send's disabled state from the two independent signals that can each
   * license it — sessionAvailable (setAvailability) OR a nonzero draftCount (setDraftState).
   * Called from both setters so either can flip the button without waiting on the other
   * (final-review fix C1). Disabled only when NEITHER signal licenses a send. */
  private syncSendEnabled(): void {
    this.sendBtn.disabled = !this.sessionAvailable && this.draftCount === 0
  }

  /** Renders a transient error row using the same styling as in-band session-error rows —
   * for host-side failures that never arrive over the NDJSON stream (e.g. a 429 from POST
   * /session/say). Public so index.ts can call it straight from the fetch handler. */
  renderTransientError(text: string): void {
    this.addRow(makeErrorRow(text))
  }

  /** Guard + fire onSend — composer consolidation Task 1 moved everything past the guard out
   * of the feed's hands: it used to disable the input, await onSay's promise, and clear text/
   * chip on success itself (final-review fix 3's round trip); now onSend is a fire-and-forget
   * `() => void` and the HOST owns that whole round trip via getText()/getChip()/clearText().
   * The empty-text guard (Task 3) now admits a drafts-only send: it only blocks when there is
   * BOTH no usable text AND no drafts (draftCount, kept current by setDraftState) — the
   * composer's ↑ is the single send surface for edits and chat, so "nothing typed" must not
   * block "something drafted". "Usable text" is text in an ENABLED textarea (final-review fix
   * C1): a disabled textarea's value never counts, even if non-empty — availability gates the
   * chat leg only via the textarea's own disabled state, not via a separate guard here, so a
   * disabled-but-drafts-present composer still sends (see setAvailability/syncSendEnabled). */
  private trySend(): void {
    const hasUsableText = !this.textarea.disabled && this.textarea.value.trim() !== ''
    if (!hasUsableText && this.draftCount === 0) return
    this.onSend()
  }

  /** Trimmed textarea contents — a host's onSend implementation reads this instead of reaching
   * into the feed's private textarea field directly. */
  getText(): string {
    return this.textarea.value.trim()
  }

  /** Empties the textarea — the host calls this once its onSend implementation decides the
   * send succeeded (mirrors the old trySend's optimistic-on-success clear, now host-owned).
   * Re-evaluates the send↔stop morph immediately, since setting .value programmatically
   * doesn't fire the textarea's own 'input' listener. */
  clearText(): void {
    this.textarea.value = ''
    this.updateSendMorph()
    this.autosize()
  }

  /** Grows the textarea to fit its content (up to TEXTAREA_MAX_PX, then it scrolls) —
   * 'auto' first so shrinking works too, since scrollHeight never reports smaller than the
   * current box. The scrollHeight>0 guard makes this a no-op under jsdom (layout-free). */
  private autosize(): void {
    this.textarea.style.height = 'auto'
    if (this.textarea.scrollHeight > 0) {
      this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, TEXTAREA_MAX_PX)}px`
    }
  }

  /** The element currently attached via setChip, shaped as the {source, tag} pair
   * ComposerSend#postSay's request body expects — onSend takes no arguments, so a host
   * implementation needs its own way to read what trySend used to build directly from
   * currentChip. */
  getChip(): { source: string; tag: string } | null {
    return this.currentChip ? { source: this.currentChip.source, tag: this.currentChip.tag } : null
  }

  /** Maps embedded-session lifecycle state to the textarea's placeholder — the retired status
   * row's job, now chrome-as-placeholder-text instead of a chrome ROW (composer consolidation
   * Task 1). 'unavailable' is deliberately a no-op: setAvailability's disabled-reason line
   * already owns messaging when the session is unavailable, so this must not fight it for the
   * placeholder. Wiring this from WatchStatus.sessionState() + availability is a later task's
   * job — this method's own mapping is what's under test here. */
  setSessionState(s: SessionState): void {
    if (s === 'unavailable') return
    const placeholders: Record<Exclude<SessionState, 'unavailable'>, string> = {
      idle: 'Message, or send your edits…',
      ready: 'Message, or send your edits…',
      starting: 'Starting session…',
      busy: 'Working…',
      failed: 'Message to retry…',
    }
    this.textarea.placeholder = placeholders[s]
  }

  /** Recomputes composer-send's morph — ■ (interrupt) while a turn is in flight (busyish) AND
   * the textarea is empty; otherwise ↑ (send). Called on every busyish transition (setBusyish)
   * and on every textarea keystroke (typing mid-turn flips it back to ↑ immediately).
   * The glyph pop (popOnce) fires only when the morph actually FLIPS — this method runs per
   * keystroke, so popping unconditionally would pulse the button while typing. */
  private updateSendMorph(): void {
    const wasStop = this.sendIsStop
    this.sendIsStop = this.busyish && this.textarea.value.trim() === ''
    this.sendBtn.textContent = this.sendIsStop ? '■' : '↑'
    this.sendBtn.setAttribute('aria-label', this.sendIsStop ? 'Stop' : 'Send')
    if (wasStop !== this.sendIsStop) popOnce(this.sendBtn)
  }

  /** Switches the composer's config pickers to a harness — thin delegate to ComposerConfig
   * (composer-config.ts), kept on SessionFeed so index.ts's status-poll seed and the tests can
   * reach it via the feed instance, same access path as before the extraction. */
  setHarness(h: HarnessId): void {
    this.config.setHarness(h)
  }

  /** Snaps the config pickers back to their last confirmed values — thin delegate to
   * ComposerConfig; index.ts calls it when a POST /__the-forge/session/config fails. */
  revertConfig(): void {
    this.config.revertConfig()
  }

  /** The harness the pickers currently reflect — thin delegate to ComposerConfig; index.ts's
   * status-poll seed reads it before calling setHarness. */
  getHarness(): HarnessId {
    return this.config.getHarness()
  }

  /** Open the NDJSON stream — called when design mode turns on. Re-entrant guard: if a fetch
   * is already live (controller set), does nothing — stop() + start() for a forced reconnect. */
  start(): void {
    if (this.controller !== null) return
    // A start() can land during the reconnect-backoff window (no live fetch, timer
    // parked) — the controller guard above doesn't cover that state. Clear the parked
    // timer before opening a fresh connection, or the stale (generation-guarded, so
    // harmless-but-alive) timer would outlive this start() and only die at the NEXT stop().
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.generation++
    this.connect(this.generation)
  }

  /** Abort the active fetch and clear any pending reconnect timer — idle to zero.
   * After stop(), no timer or fetch survives (same zero-idle-overhead rule as Verifier). */
  stop(): void {
    this.generation++
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.controller !== null) {
      this.controller.abort()
      this.controller = null
    }
  }

  // ---------------------------------------------------------------------------
  // Stream connection
  // ---------------------------------------------------------------------------

  private connect(gen: number): void {
    if (gen !== this.generation) return
    const url = `/__the-forge/session/events?since=${this.lastSeq}`
    const ctrl = new AbortController()
    this.controller = ctrl

    this.fetchFn(url, { headers: this.getHeaders(), signal: ctrl.signal })
      .then(async (res) => {
        if (gen !== this.generation) return
        if (res.status === 404) {
          // Session unavailable — park at the cap to avoid log spam; no error row shown.
          this.controller = null
          this.backoffMs = BACKOFF_CAP_MS
          this.scheduleReconnect(gen)
          return
        }
        if (!res.ok || !res.body) {
          this.controller = null
          this.scheduleReconnect(gen)
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (gen !== this.generation) {
              reader.cancel().catch(() => {})
              return
            }
            if (done) break
            buf += decoder.decode(value, { stream: true })
            // Incremental NDJSON parse: split on newlines, buffer the last (partial) line.
            let nl: number
            while ((nl = buf.indexOf('\n')) !== -1) {
              const raw = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!raw) continue
              // Successful line → reset backoff so the next reconnect is fast
              this.backoffMs = BACKOFF_INIT_MS
              this.parseLine(raw)
            }
          }
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return
          // Other read errors fall through to reconnect
        }
        // Stream ended (server closed connection) — schedule reconnect
        if (gen === this.generation) {
          this.controller = null
          this.scheduleReconnect(gen)
        }
      })
      .catch((err) => {
        if (gen !== this.generation) return
        if ((err as Error)?.name === 'AbortError') return
        this.controller = null
        this.scheduleReconnect(gen)
      })
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect(gen)
    }, delay)
  }

  // ---------------------------------------------------------------------------
  // NDJSON line parsing — unknown + manual checks at the I/O boundary, no schema library
  // ---------------------------------------------------------------------------

  private parseLine(raw: string): void {
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      return // malformed JSON → ignore silently
    }
    if (typeof obj !== 'object' || obj === null) return
    const o = obj as Record<string, unknown>
    if (o.type === 'feed') {
      const seq = typeof o.seq === 'number' ? o.seq : null
      // assistant-delta lines always carry seq 0 (ephemeral, never ringed server-side) — the
      // `seq > this.lastSeq` comparison already excludes 0 from ever bumping lastSeq, so a
      // burst of deltas between real events can never move the reconnect ?since= cursor.
      if (seq !== null && seq > this.lastSeq) this.lastSeq = seq
      const event = o.event
      if (typeof event !== 'object' || event === null) return
      this.handleEvent(event as Record<string, unknown>)
    } else if (o.type === 'approval') {
      const { id, toolName, detail } = o
      if (typeof id !== 'string' || typeof toolName !== 'string' || typeof detail !== 'string') return
      this.renderApproval(id, toolName, detail)
    } else if (o.type === 'approval-resolved') {
      const { id, allow } = o
      if (typeof id !== 'string' || typeof allow !== 'boolean') return
      this.resolveApproval(id, allow)
    }
    // unknown type → ignore silently (forward-compat posture)
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private handleEvent(e: Record<string, unknown>): void {
    const { kind } = e
    switch (kind) {
      case 'started': {
        // Unhides the root even when this 'started' event doesn't itself addRow (e.g. a
        // started-only fixture) — the retired status row used to do this via setStatus; there
        // is no status ROW to write it to anymore, but the composer/list must still become
        // visible the moment a session actually starts.
        this.root.hidden = false
        // Config pickers re-seed from the started event (model from the payload, effort/
        // permission re-applied from the last user-chosen values) — see seedFromStarted's own
        // doc comment (composer-config.ts) for the rationale.
        this.config.seedFromStarted(e)
        break
      }
      case 'assistant-text': {
        const text = typeof e.text === 'string' ? e.text : ''
        this.clearWorkingRow()
        this.finalizeAssistantText(text)
        this.setBusyish(true)
        break
      }
      case 'user-text': {
        const text = typeof e.text === 'string' ? e.text : ''
        const element = typeof e.element === 'object' && e.element !== null ? (e.element as Record<string, unknown>) : undefined
        const bubble = makeUserBubble(text, element)
        this.addRow(bubble)
        // "Thinking" placeholder fills the dead air until the turn's first activity —
        // shown BELOW the just-sent bubble, removed by the next non-user event. Inserted
        // after anchor() so the anchored scroll measures the bubble, not the placeholder.
        this.anchor.anchor(bubble)
        this.showWorkingRow()
        break
      }
      case 'assistant-delta': {
        const text = typeof e.text === 'string' ? e.text : ''
        this.clearWorkingRow()
        this.appendDelta(text)
        this.setBusyish(true)
        break
      }
      case 'tool-started': {
        const toolId = typeof e.toolId === 'string' ? e.toolId : ''
        const name = typeof e.name === 'string' ? e.name : ''
        const detail = typeof e.detail === 'string' ? e.detail : ''
        const edit = parseEditPayload(e.edit)
        const row = makeToolRow(toolId, name, detail, edit)
        this.clearWorkingRow()
        this.toolRows.set(toolId, row)
        this.addRow(row)
        this.setBusyish(true)
        break
      }
      case 'config-changed': {
        this.addRow(makeConfigRow(e))
        // Seeds the pickers AND records the last user-chosen effort/permission for a later
        // respawn's `started` to re-apply — see seedFromConfigChanged (composer-config.ts).
        this.config.seedFromConfigChanged(e)
        break
      }
      case 'tool-finished': {
        const toolId = typeof e.toolId === 'string' ? e.toolId : ''
        const row = this.toolRows.get(toolId)
        if (row && markToolFinished(row, parseEditPayload(e.edit))) {
          // The row grew in place (late diff appended) with no addRow — same spacer
          // invariant as the in-place finalize branch (PR #35 review: this path was the
          // one still bypassing it).
          this.anchor.update()
        }
        break
      }
      case 'turn-complete': {
        this.clearWorkingRow()
        if (e.isError === true) {
          const errorText = typeof e.errorText === 'string' ? e.errorText : 'Turn error'
          this.addRow(makeErrorRow(errorText))
        } else {
          // Completion affordance (chat-ux polish): a clean turn ends with a subtle
          // "✓ Done · $cost" marker — the "when is it finished" signal Cursor draws as a
          // checkpoint line and Claude Code prints as its per-turn result/cost line.
          this.addRow(makeTurnDoneRow(typeof e.costUsd === 'number' ? e.costUsd : undefined))
        }
        this.setBusyish(false)
        this.clearStreamingBubble()
        break
      }
      case 'session-error': {
        const text = typeof e.text === 'string' ? e.text : 'Session error'
        this.clearWorkingRow()
        this.addRow(makeErrorRow(text))
        this.setBusyish(false)
        this.clearStreamingBubble()
        break
      }
      case 'ended': {
        this.clearWorkingRow()
        this.setBusyish(false)
        this.clearStreamingBubble()
        break
      }
      default:
        // default: unknown kinds are ignored on purpose — the wire outlives any one bundle
        // build (a rebuilt server can stream to a cached client), so runtime tolerance here
        // is load-bearing; do NOT add a compile-time exhaustiveness check on wire data.
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------------

  private setBusyish(on: boolean): void {
    this.busyish = on
    this.updateSendMorph()
  }

  /** Inserts (or re-inserts, keeping it the newest row) the singleton "Thinking"
   * placeholder before the anchor spacer. Not addRow on purpose — see workingRow's field
   * doc: ephemeral chrome stays out of the MAX_ROWS bookkeeping entirely. */
  private showWorkingRow(): void {
    this.clearWorkingRow()
    this.workingRow = makeWorkingRow()
    this.list.insertBefore(this.workingRow, this.anchor.spacer)
    this.anchor.update()
  }

  /** Removes the placeholder — called by every event that proves the turn is doing (or has
   * finished doing) something: delta, final text, tool-started, approval, turn-complete,
   * session-error, ended. A no-op when none is showing. */
  private clearWorkingRow(): void {
    if (this.workingRow === null) return
    this.workingRow.remove()
    this.workingRow = null
    this.anchor.update()
  }

  /** Invalidates a stale in-progress streaming bubble (final-review fix 5) — called from
   * turn-complete/session-error/ended, none of which are guaranteed to be preceded by a
   * finalizing assistant-text (an in-band error can end a turn mid-stream with no final text
   * ever arriving). Without this, the NEXT turn's first delta would silently append to a
   * bubble that belongs to an already-ended turn (appendDelta's `if (!this.streamingBubble)`
   * check sees it as still-live). Also drops the `.chat-streaming` class from the now-stale
   * bubble still in the DOM, or it would keep showing the "still typing" affordance for a
   * turn that already ended. A no-op when there's no live bubble. */
  private clearStreamingBubble(): void {
    this.streamingBubble?.classList.remove('chat-streaming')
    this.streamingBubble = null
    this.streamingText = ''
  }

  /** Final assistant-text lands here (never the raw addRow path) so it can replace an
   * in-progress streaming bubble instead of duplicating it. Reconnect case (a final text
   * with no preceding streaming bubble — the deltas that built it were never seen this
   * connection) falls through to a fresh bubble. */
  private finalizeAssistantText(text: string): void {
    if (this.streamingBubble) {
      setAssistantContent(this.streamingBubble, text)
      this.streamingBubble.classList.remove('chat-streaming')
      this.streamingBubble = null
      this.streamingText = ''
      // The bubble can grow in place with no addRow/appendDelta — e.g. a mid-stream
      // reconnect replays a final assistant-text much longer than the partial streamed
      // text — so the spacer must be recomputed here or it stays oversized, leaving a
      // scrollable blank tail.
      this.anchor.update()
      return
    }
    this.addRow(makeAssistantBubble(text))
  }

  /** First delta after a non-delta event (or after the prior stream finalized) creates the
   * bubble via addRow (so MAX_ROWS cap applies once, at creation); every later delta in the
   * same run re-renders the accumulated text in place (setAssistantContent — a full markdown
   * pass, so partially streamed block syntax settles as it closes) — no repeated addRow/cap
   * bookkeeping. */
  private appendDelta(text: string): void {
    if (!this.streamingBubble) {
      this.streamingText = ''
      const bubble = makeAssistantBubble('')
      bubble.classList.add('chat-streaming')
      this.streamingBubble = bubble
      this.addRow(bubble)
    }
    this.streamingText += text
    setAssistantContent(this.streamingBubble, this.streamingText)
    this.anchor.update()
  }

  private renderApproval(id: string, toolName: string, detail: string): void {
    // Approval lines carry no seq, so ?since= can't filter them — the server re-emits
    // every still-pending approval on each reconnect. A duplicate id must be a no-op:
    // appending again would overwrite the approvalRows entry and leave a ghost row
    // (with live buttons) that approval-resolved could no longer collapse.
    if (this.approvalRows.has(id)) return
    // An approval request IS turn activity — the harness stopped to ask, so the
    // "Thinking" placeholder must yield to the card that explains the pause.
    this.clearWorkingRow()
    const row = makeApprovalRow(id, toolName, detail, (allow) => this.onDecide(id, allow))
    this.approvalRows.set(id, row)
    this.addRow(row)
  }

  private resolveApproval(id: string, allow: boolean): void {
    const row = this.approvalRows.get(id)
    if (!row) return
    // Collapse to a single resolution line — remove buttons and replace content
    row.textContent = allow ? 'Allowed' : 'Denied'
    row.classList.add('session-approval-resolved')
  }

  private addRow(row: HTMLElement): void {
    this.rowList.push(row)
    this.list.insertBefore(row, this.anchor.spacer)
    this.root.hidden = false
    // Cap at MAX_ROWS — drop oldest rows beyond the limit (mirrors the server's ring-buffer cap)
    if (this.rowList.length > MAX_ROWS) {
      const excess = this.rowList.splice(0, this.rowList.length - MAX_ROWS)
      for (const el of excess) el.remove()
      // A still-streaming bubble old enough to be evicted here is now detached from the DOM —
      // if left referenced, the eventual finalizeAssistantText would write the final text into
      // that invisible node instead of a fresh, visible one (final-review fix 5).
      if (this.streamingBubble && excess.includes(this.streamingBubble)) {
        this.clearStreamingBubble()
      }
      // Evicted rows must release their toolRows/approvalRows entries too — otherwise a
      // still-pending approval re-emitted by the server on reconnect finds its (now
      // detached, but still tracked) id in approvalRows and renderApproval's dup guard
      // no-ops the re-emit, making the approval permanently undecidable; toolRows would
      // just grow unboundedly with entries pointing at nodes no longer in the DOM.
      const excessSet = new Set(excess)
      for (const [id, row] of this.toolRows) {
        if (excessSet.has(row)) this.toolRows.delete(id)
      }
      for (const [id, row] of this.approvalRows) {
        if (excessSet.has(row)) this.approvalRows.delete(id)
      }
      this.anchor.onEvict(excess)
    }
    this.anchor.update()
  }
}

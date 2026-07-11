// Not EventSource: EventSource cannot send custom request headers. The event stream
// requires X-Forge-Secret for auth (same as all mutating endpoints), so we use
// fetch + ReadableStream + manual NDJSON parsing instead.
import { createButton } from './ui/button'
import { createSelect } from './ui/select'
import { basename } from './source'
import { EFFORT_LEVELS, PERMISSION_MODES, CHAT_TEXT_MAX } from '../shared/chat-constants'
import { type SessionState } from './watch'

// Fixed vocabularies for the effort/permission pickers — built from the shared
// EFFORT_LEVELS/PERMISSION_MODES arrays (src/shared/chat-constants.ts), the single source of
// truth also consumed by server/endpoints.ts's validation sets (task-6 brief).
const EFFORT_OPTIONS = [{ value: '', label: 'effort…' }, ...EFFORT_LEVELS.map((v) => ({ value: v, label: v }))] as const

const PERMISSION_OPTIONS = [
  { value: '', label: 'permissions…' },
  ...PERMISSION_MODES.map((v) => ({ value: v, label: v })),
] as const

// The model picker's option set is NOT a fixed vocabulary like effort/permissions: the CLI
// exposes no enumerable model list, so the select offers the started/config-changed-reported
// model (the only ground truth for "current") PLUS these aliases — the CLI's own documented
// shorthands, resolved server-side by set_model (spike-verified in Task 1 with a full model
// id). Deduped when the current value IS one of the aliases; rebuilt on every seed so a
// config-changed to a model outside the list still renders as the selected option.
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku'] as const

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
  | { kind: 'tool-finished'; toolId: string }
  | { kind: 'turn-complete'; isError: boolean; errorText?: string; costUsd?: number }
  | { kind: 'config-changed'; model?: string; permissionMode?: string; effort?: string }
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
  /** Called when the effort or permission picker changes, with ONLY the changed key — host
   * wires to POST /__the-forge/session/config. */
  onConfig: (cfg: { model?: string; permissionMode?: string; effort?: string }) => void = () => {}

  private readonly list: HTMLElement

  // --- config pickers: model, effort, and permission — live in .composer-controls ---
  private readonly modelSelect: HTMLSelectElement
  private readonly effortSelect: HTMLSelectElement
  private readonly permissionSelect: HTMLSelectElement

  // --- chat composer (composer consolidation Task 1): the single bordered card holding the
  // chip row, textarea, and controls row ---
  private readonly chatComposer: HTMLElement
  private readonly composerChips: HTMLElement
  private readonly composerControls: HTMLElement
  // --- drafts pill + disclosure (composer consolidation Task 2): the pill lives in
  // composerChips alongside the element chip; draftDisclosure is a sibling block, above
  // composerChips, that the pill's click toggles open/closed via the .open class — a
  // details-free div toggle (no <details> semantics needed, there's only ever one thing to
  // show/hide). draftSlot (public) is the content host inside it. ---
  private readonly draftPill: HTMLButtonElement
  private readonly draftPillLabel: HTMLSpanElement
  private readonly draftDisclosure: HTMLElement

  // --- element chip + input cluster ---
  private readonly chip: HTMLElement
  private readonly chipLabel: HTMLElement
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
  /** Last-user-chosen effort/permissionMode seen via config-changed rows — re-applied to the
   * pickers on every `started` event (final-review fix 2). The manager now re-applies these
   * server-side on every respawn too (a respawned child otherwise silently reverts them), so
   * this keeps the UI honest about that reality instead of relying on DOM inertia (a `started`
   * event's payload carries no effort/permissionMode field to seed from directly). Undefined
   * until the first config-changed for that key — the pickers stay on their placeholder. */
  private lastEffort: string | undefined = undefined
  private lastPermission: string | undefined = undefined
  /** The single in-progress .chat-streaming bubble, if any — the first seq-0 delta after a
   * non-delta event creates it; subsequent deltas append to it; the next final assistant-text
   * replaces its content and clears this back to null (no duplicate bubble). */
  private streamingBubble: HTMLElement | null = null
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

    // Config pickers: model, effort, and permission — each stays on a placeholder option
    // until a started/config-changed event seeds it; picking the placeholder itself is a
    // no-op (see the '' guards in the onChange handlers). The model select's options are
    // rebuilt per seed (seedModelOptions) rather than fixed like the other two — see the
    // MODEL_ALIASES why-comment above. They used to live in their own header bar
    // (.session-config-bar, retired); composer consolidation (Task 1) moves them into the
    // composer's .composer-controls row instead — assembled further down.
    this.modelSelect = createSelect({
      className: 'session-model',
      options: [{ value: '', label: 'model…' }],
      value: '',
      onChange: (value) => {
        if (value === '') return
        this.onConfig({ model: value })
      },
    })
    this.effortSelect = createSelect({
      className: 'session-effort',
      options: EFFORT_OPTIONS,
      value: '',
      onChange: (value) => {
        if (value === '') return
        this.onConfig({ effort: value })
      },
    })
    this.permissionSelect = createSelect({
      className: 'session-permission',
      options: PERMISSION_OPTIONS,
      value: '',
      onChange: (value) => {
        if (value === '') return
        this.onConfig({ permissionMode: value })
      },
    })

    // Element chip: Prompt-button / host sets it via setChip(); the × clears it locally
    // (no host callback — a host's onSend implementation reads it via getChip(), same as the
    // old floating prompt popup used to read its own anchor).
    this.chip = document.createElement('div')
    this.chip.className = 'chat-chip'
    this.chip.hidden = true
    this.chipLabel = document.createElement('span')
    const chipClear = createButton({ label: '×', className: 'chat-chip-clear' })
    chipClear.type = 'button'
    chipClear.addEventListener('click', () => this.setChip(null))
    this.chip.append(this.chipLabel, chipClear)

    // Drafts pill + disclosure (composer consolidation Task 2): the pill is a plain
    // createButton (CLAUDE.md's ui/ factory rule), hidden until setDraftState says otherwise.
    // Its click toggles the sibling draftDisclosure's .open class — draftSlot is exposed
    // publicly so index.ts can append the (unmodified) ChangeList's root into it.
    // Label + chevron are child spans (2026-07-11 draft-badge spec): setDraftState rewrites
    // only the label span, and .open is mirrored onto the pill itself so the chevron can
    // rotate with a same-element CSS hook (the disclosure is a sibling, not a parent).
    this.draftPill = createButton({ className: 'draft-pill' })
    this.draftPill.type = 'button'
    this.draftPill.hidden = true
    this.draftPillLabel = document.createElement('span')
    this.draftPillLabel.className = 'draft-pill-label'
    const draftChevron = document.createElement('span')
    draftChevron.className = 'draft-pill-chevron'
    draftChevron.textContent = '▾'
    this.draftPill.append(this.draftPillLabel, draftChevron)
    this.draftPill.addEventListener('click', () => this.setDisclosureOpen(!this.draftDisclosure.classList.contains('open')))

    this.draftSlot = document.createElement('div')
    this.draftSlot.className = 'draft-slot'
    this.draftDisclosure = document.createElement('div')
    this.draftDisclosure.className = 'draft-disclosure'
    this.draftDisclosure.append(this.draftSlot)

    // Composer chip row: the element chip plus the drafts pill (Task 2).
    this.composerChips = document.createElement('div')
    this.composerChips.className = 'composer-chips'
    this.composerChips.append(this.chip, this.draftPill)

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
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
    // whenever busyish itself next transitions.
    this.textarea.addEventListener('input', () => this.updateSendMorph())
    this.inputCluster.append(this.disabledReason, this.textarea)

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
    this.composerControls.append(this.modelSelect, this.effortSelect, this.permissionSelect, composerSpacer, this.sendBtn)

    // The single bordered composer card (composer consolidation Task 1) — replaces the retired
    // status row, standalone Stop button, and .session-config-bar. draftDisclosure sits ABOVE
    // composerChips (Task 2): it hosts the ChangeList, which can grow to its own max-height —
    // above the chips/input/controls rows is the only position that never pushes the textarea
    // around when it opens. Task 4 adds the draggable divider above .session-feed.
    this.chatComposer = document.createElement('div')
    this.chatComposer.className = 'chat-composer'
    this.chatComposer.append(this.draftDisclosure, this.composerChips, this.inputCluster, this.composerControls)

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
    this.chipLabel.textContent = el?.label ?? ''
    this.chip.hidden = el === null
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
   * "applying…" even while further drafts pile up behind it. Hidden only when there is truly
   * nothing to show, which also force-closes the disclosure — an empty disclosure left open
   * would show a blank block once the last draft/send resolves. */
  setDraftState(s: { count: number; applying: boolean }): void {
    this.draftCount = s.count
    const visible = s.count > 0 || s.applying
    this.draftPill.hidden = !visible
    if (!visible) {
      this.setDisclosureOpen(false)
    } else {
      this.draftPillLabel.textContent = s.applying ? 'applying…' : s.count === 1 ? '1 change drafted' : `${s.count} changes drafted`
    }
    // Draft count is one of the two independent signals that can license the send button —
    // see syncSendEnabled (final-review fix C1).
    this.syncSendEnabled()
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
    this.addRow(this.makeErrorRow(text))
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
   * and on every textarea keystroke (typing mid-turn flips it back to ↑ immediately). */
  private updateSendMorph(): void {
    this.sendIsStop = this.busyish && this.textarea.value.trim() === ''
    this.sendBtn.textContent = this.sendIsStop ? '■' : '↑'
    this.sendBtn.setAttribute('aria-label', this.sendIsStop ? 'Stop' : 'Send')
  }

  /** Seeds the config pickers from a started/config-changed event — only the keys present in
   * the event are applied, matching the "each select shows a placeholder until seeded"
   * contract. Programmatic .value / option rebuilds don't fire 'change', so this never loops
   * back into onConfig. */
  private seedConfigBar(e: Record<string, unknown>): void {
    if (typeof e.model === 'string') this.seedModelOptions(e.model)
    if (typeof e.effort === 'string') this.effortSelect.value = e.effort
    if (typeof e.permissionMode === 'string') this.permissionSelect.value = e.permissionMode
  }

  /** Rebuilds the model select's options as [current, ...MODEL_ALIASES] (deduped, current
   * first) and selects the current model. Rebuilt — not appended to — on every seed, so the
   * placeholder disappears once a real model is known and a config-changed to a model outside
   * the alias list still renders as the selected option instead of silently failing to match. */
  private seedModelOptions(current: string): void {
    const values = [current, ...MODEL_ALIASES.filter((a) => a !== current)]
    this.modelSelect.replaceChildren(
      ...values.map((v) => {
        const opt = document.createElement('option')
        opt.value = v
        opt.textContent = v
        return opt
      })
    )
    this.modelSelect.value = current
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
        // Model re-seeds from the event itself, as before — the started payload IS the source
        // of truth for which model actually booted. Effort/permission carry no such field
        // (control-request-only, or spawn-flag-only for effort), so re-apply the last
        // user-chosen values instead of leaving them at whatever the DOM happened to hold.
        this.seedConfigBar(e)
        this.effortSelect.value = this.lastEffort ?? ''
        this.permissionSelect.value = this.lastPermission ?? ''
        break
      }
      case 'assistant-text': {
        const text = typeof e.text === 'string' ? e.text : ''
        this.finalizeAssistantText(text)
        this.setBusyish(true)
        break
      }
      case 'user-text': {
        const text = typeof e.text === 'string' ? e.text : ''
        const element = typeof e.element === 'object' && e.element !== null ? (e.element as Record<string, unknown>) : undefined
        this.addRow(this.makeUserBubble(text, element))
        break
      }
      case 'assistant-delta': {
        const text = typeof e.text === 'string' ? e.text : ''
        this.appendDelta(text)
        this.setBusyish(true)
        break
      }
      case 'tool-started': {
        const toolId = typeof e.toolId === 'string' ? e.toolId : ''
        const name = typeof e.name === 'string' ? e.name : ''
        const detail = typeof e.detail === 'string' ? e.detail : ''
        const editRaw = typeof e.edit === 'object' && e.edit !== null ? (e.edit as Record<string, unknown>) : null
        const edit =
          editRaw && typeof editRaw.file === 'string' && typeof editRaw.before === 'string' && typeof editRaw.after === 'string'
            ? { file: editRaw.file, before: editRaw.before, after: editRaw.after }
            : undefined
        const row = this.makeToolRow(toolId, name, detail, edit)
        this.toolRows.set(toolId, row)
        this.addRow(row)
        this.setBusyish(true)
        break
      }
      case 'config-changed': {
        this.addRow(this.makeConfigRow(e))
        this.seedConfigBar(e)
        if (typeof e.effort === 'string') this.lastEffort = e.effort
        if (typeof e.permissionMode === 'string') this.lastPermission = e.permissionMode
        break
      }
      case 'tool-finished': {
        const toolId = typeof e.toolId === 'string' ? e.toolId : ''
        const row = this.toolRows.get(toolId)
        if (row) {
          const spinner = row.querySelector('.session-spinner')
          if (spinner) spinner.textContent = '✓'
        }
        break
      }
      case 'turn-complete': {
        if (e.isError === true) {
          const errorText = typeof e.errorText === 'string' ? e.errorText : 'Turn error'
          this.addRow(this.makeErrorRow(errorText))
        }
        this.setBusyish(false)
        this.clearStreamingBubble()
        break
      }
      case 'session-error': {
        const text = typeof e.text === 'string' ? e.text : 'Session error'
        this.addRow(this.makeErrorRow(text))
        this.setBusyish(false)
        this.clearStreamingBubble()
        break
      }
      case 'ended': {
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
      this.streamingBubble.textContent = text
      this.streamingBubble.classList.remove('chat-streaming')
      this.streamingBubble = null
      this.streamingText = ''
      return
    }
    this.addRow(this.makeAssistantBubble(text))
  }

  /** First delta after a non-delta event (or after the prior stream finalized) creates the
   * bubble via addRow (so MAX_ROWS cap applies once, at creation); every later delta in the
   * same run just mutates its textContent in place — no repeated addRow/cap bookkeeping. */
  private appendDelta(text: string): void {
    if (!this.streamingBubble) {
      this.streamingText = ''
      const bubble = this.makeAssistantBubble('')
      bubble.classList.add('chat-streaming')
      this.streamingBubble = bubble
      this.addRow(bubble)
    }
    this.streamingText += text
    this.streamingBubble.textContent = this.streamingText
  }

  private makeAssistantBubble(text: string): HTMLElement {
    // Full text, no truncation — unlike the old snippet row, chat bubbles show the whole
    // message (the panel scrolls instead).
    const row = document.createElement('div')
    row.className = 'session-row chat-msg chat-assistant'
    row.textContent = text
    return row
  }

  private makeUserBubble(text: string, element?: Record<string, unknown>): HTMLElement {
    const row = document.createElement('div')
    row.className = 'session-row chat-msg chat-user'
    row.append(document.createTextNode(text))
    if (element) {
      const source = typeof element.source === 'string' ? element.source : ''
      const tag = typeof element.tag === 'string' ? element.tag : ''
      if (source || tag) {
        const ref = document.createElement('div')
        ref.className = 'chat-msg-ref'
        ref.textContent = [tag, source].filter(Boolean).join(' · ')
        row.append(ref)
      }
    }
    return row
  }

  private makeToolRow(
    toolId: string,
    name: string,
    detail: string,
    edit?: { file: string; before: string; after: string },
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'session-row session-tool-row'
    row.dataset.toolId = toolId
    const spinner = document.createElement('span')
    spinner.className = 'session-spinner'
    // Braille spinning glyph; tool-finished flips this to ✓ by matching toolId
    spinner.textContent = '\u28CB'
    const label = document.createElement('span')
    label.textContent = ` ${name} ${detail}`.trimEnd()
    row.append(spinner, label)
    if (edit) {
      // Hand-rolled before/after disclosure — no diff library. Collapsed by default (native
      // <details> behavior); summary is just the basename so long paths don't blow out the row.
      const details = document.createElement('details')
      details.className = 'session-diff'
      const summary = document.createElement('summary')
      summary.textContent = basename(edit.file)
      const before = document.createElement('pre')
      before.className = 'diff-before'
      before.textContent = edit.before
      const after = document.createElement('pre')
      after.className = 'diff-after'
      after.textContent = edit.after
      details.append(summary, before, after)
      row.append(details)
    }
    return row
  }

  private makeConfigRow(e: Record<string, unknown>): HTMLElement {
    const parts: string[] = []
    if (typeof e.model === 'string') parts.push(`model → ${e.model}`)
    if (typeof e.permissionMode === 'string') parts.push(`permissions → ${e.permissionMode}`)
    if (typeof e.effort === 'string') parts.push(`effort → ${e.effort}`)
    const row = document.createElement('div')
    row.className = 'session-row session-config'
    row.textContent = parts.join(' · ')
    return row
  }

  private makeErrorRow(text: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'session-row session-error-row'
    row.textContent = text
    return row
  }

  private renderApproval(id: string, toolName: string, detail: string): void {
    // Approval lines carry no seq, so ?since= can't filter them — the server re-emits
    // every still-pending approval on each reconnect. A duplicate id must be a no-op:
    // appending again would overwrite the approvalRows entry and leave a ghost row
    // (with live buttons) that approval-resolved could no longer collapse.
    if (this.approvalRows.has(id)) return
    const row = document.createElement('div')
    row.className = 'session-row session-approval'
    row.dataset.approvalId = id

    const label = document.createElement('span')
    label.textContent = `${toolName}: ${detail}`

    const allowBtn = createButton({ label: 'Allow', className: 'session-approval-allow' })
    allowBtn.type = 'button'
    allowBtn.addEventListener('click', () => this.onDecide(id, true))

    const denyBtn = createButton({ label: 'Deny', className: 'session-approval-deny' })
    denyBtn.type = 'button'
    denyBtn.addEventListener('click', () => this.onDecide(id, false))

    row.append(label, allowBtn, denyBtn)
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
    this.list.appendChild(row)
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
    }
  }
}

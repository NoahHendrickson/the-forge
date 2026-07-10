import type { SessionFeed } from './session-feed'

// Transient-error copy for the CHAT leg only — the drafts leg's own copy ('failed to queue
// changes — try again') stays in index.ts alongside DesignMode#sendDrafts, which this module
// does not own (see the ComposerSend class doc below for why).
const CHAT_QUEUE_FULL_COPY = 'chat queue full — wait for the current turn'
const CHAT_SEND_FAILED_COPY = 'message failed to send — try again'

export interface ComposerSendOpts {
  /** The single SessionFeed instance index.ts wires everywhere else — this module only ever
   * touches its public surface (getText/clearText/getChip/setChip/renderTransientError). */
  feed: SessionFeed
  /** Host-injected secret-header POST — mirrors index.ts's other POST call sites
   * (queueRequest/postDispatch/onConfig) so this module never has to read
   * globalThis.__THE_FORGE__ itself. */
  postJson: (path: string, body: unknown) => Promise<Response>
  /** The drafts leg — DesignMode#sendDrafts in index.ts, INJECTED rather than owned here. It
   * reads/writes the DraftStore, the LifecycleSession, the Verifier, and the ChangeList, and
   * shares its queue/dispatch POST plumbing with resend() — pulling all of that in here would
   * leave ComposerSend re-exposing nearly every DesignMode internal as a constructor option for
   * no real encapsulation win, so the leg stays put and this module only needs to know WHEN it
   * settles (queued+dispatched, or bailed out early on no-changes/already-sent/failure). */
  sendDraftsLeg: () => Promise<void>
  /** this.drafts.elementCount() > 0 at click time — decides send()'s branch (await the drafts
   * leg before the chat leg vs. fire the chat leg immediately), without this module needing its
   * own DraftStore reference. Also preserves a tick-count detail worth calling out: when this is
   * false, proceedWithChat runs SYNCHRONOUSLY inside send() (matching the original onSend shim's
   * two-branch shape) rather than via a `.then()` — some design-mode.test.ts assertions count
   * microtask ticks, so this branch is deliberately kept rather than always awaiting
   * sendDraftsLeg() (which would always defer proceedWithChat by at least one tick). */
  hasDrafts: () => boolean
  /** this.watch.sessionEnabled() !== false at click time — see send()'s inline comment. */
  chatAvailable: () => boolean
}

/**
 * ComposerSend — single owner of the send-everything verb's ORCHESTRATION and its CHAT leg
 * (composer consolidation Task 3; split out of DesignMode by the composer-send extraction
 * review round — see ComposerSendOpts#sendDraftsLeg above for why the drafts leg itself stayed
 * in index.ts instead of moving in whole). The composer's ↑ is the only send surface, firing
 * whichever of drafts/chat are present in one gesture — drafts go FIRST when both are present:
 * the server answers a chat turn only after applying whatever is already queued ahead of it
 * (nudge-before-FIFO), so queuing edits before the chat POST keeps client-observed send order
 * consistent with server-observed apply order.
 *
 * TWO independent in-flight flags exist across this extraction — draftsInFlight (stays in
 * DesignMode, guarding the injected sendDraftsLeg) and chatInFlight (owned here, guarding
 * sendChat) — and that split is deliberate, NOT a shortcut to be collapsed into one shared phase
 * enum. The two legs deliberately OVERLAP in time: send() awaits only the drafts leg's /queue
 * POST, not its /dispatch POST (fire-and-forget, kicked off and left to settle on its own) — so
 * the chat leg's /session/say POST can already be in flight while the drafts leg's dispatch is
 * still running. A single enum cannot represent "queue done, dispatch still running, chat also
 * running" without inventing states nothing else needs — keep both flags.
 */
export class ComposerSend {
  private chatInFlight = false

  constructor(private opts: ComposerSendOpts) {}

  /** The send-everything verb itself — see the class doc for the drafts-first-when-both
   * rationale. The trimmed text is captured ONCE, here at gesture time (review fix 2):
   * re-reading the textarea after the awaited drafts leg would send whatever the user edited it
   * to during that async gap — pinned semantics are "send what the user had at click time". */
  send(): void {
    const hasDrafts = this.opts.hasDrafts()
    const text = this.opts.feed.getText()
    // Belt-and-braces (final-review fix C1): the textarea's own disabled attribute already
    // stops a real user keystroke from landing while chat is unavailable, but getText() reads
    // .value directly, and a value set before the disable (or poked in some other way) can
    // still be non-empty — so the chat leg must ALSO be gated here on the same signal
    // setAvailability's caller (index.ts's refreshStatus) derives from, not just on
    // textarea.value being non-empty. chatAvailable() undefined (not yet probed, or an older
    // server) means "available by default" — only an explicit false disables the leg.
    const chatAvailable = this.opts.chatAvailable()
    const proceedWithChat = (): void => {
      if (text && chatAvailable) void this.sendChat(text)
    }
    if (hasDrafts) this.opts.sendDraftsLeg().then(proceedWithChat)
    else proceedWithChat()
  }

  /** The chat leg of the send-everything verb — POSTs the given text + the attached chip via
   * postSay, and — only on a true (ok) resolution — clears both. A falsy resolution (network
   * failure, 429, any non-ok response) already rendered its own explanation via postSay's
   * renderTransientError call and must leave the typed text/chip untouched (final-review fix 3
   * — never silently discard what the user typed). `text` is a PARAMETER, not re-read from
   * feed.getText() here (review fix 2) — see send()'s doc comment. Guards non-empty itself so no
   * caller can POST a blank turn.
   *
   * chatInFlight (final-review fix C2) makes a second call while one is already in flight a
   * no-op — a rapid double-click of ↑ must produce exactly one /session/say POST, not two.
   * clearText() only fires when feed.getText() still equals the text this call sent (deferred
   * Minor 7): the user may have retyped the textarea during the round trip, and an
   * unconditional clear would silently discard that — only wipe it when what's there now is
   * still exactly what was sent (i.e. nothing changed underneath it). setChip(null) stays
   * unconditional on ok — the chip has no independent "retyped" concept to preserve. */
  private sendChat(text: string): Promise<void> {
    if (!text.trim()) return Promise.resolve()
    if (this.chatInFlight) return Promise.resolve()
    this.chatInFlight = true
    const chip = this.opts.feed.getChip()
    return this.postSay(text, chip ?? undefined)
      .then((ok) => {
        if (ok) {
          if (this.opts.feed.getText() === text) this.opts.feed.clearText()
          this.opts.feed.setChip(null)
        }
      })
      .finally(() => {
        this.chatInFlight = false
      })
  }

  /** POSTs to /__the-forge/session/say — used to be SessionFeed's own `onSay` hook, deleted
   * from its public surface by this extraction (the chat POST belongs to the send verb, not to
   * the feed). Every non-ok response and every network failure renders a transient
   * .session-error-row before resolving false; 429 keeps its specific queue-full copy,
   * everything else gets the generic retry copy. */
  private postSay(text: string, element?: { source: string; tag: string }): Promise<boolean> {
    return this.opts
      .postJson('/__the-forge/session/say', { text, element })
      .then((res) => {
        if (res.ok) return true
        if (res.status === 429) {
          this.opts.feed.renderTransientError(CHAT_QUEUE_FULL_COPY)
        } else {
          this.opts.feed.renderTransientError(CHAT_SEND_FAILED_COPY)
        }
        return false
      })
      .catch(() => {
        this.opts.feed.renderTransientError(CHAT_SEND_FAILED_COPY)
        return false
      })
  }
}

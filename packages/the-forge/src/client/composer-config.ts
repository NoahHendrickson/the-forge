// The config-picker cluster of the chat composer (harness/model/effort/permission), extracted
// from session-feed.ts (PR #32) to keep that file under 1k lines. Owns the four selects, their
// per-harness vocabulary state, and every seed/revert path — SessionFeed instantiates one,
// mounts its `selects` directly into .composer-controls (no wrapper — they stay direct flex
// children, same DOM as before), forwards its own `onConfig` through, and calls the seed
// methods from the started/config-changed stream handlers. Pure move: no behavior change.
import { createSelect } from './ui/select'
import { EMBEDDED_HARNESSES, HARNESS_VOCAB, isHarnessId, type HarnessId } from '../shared/chat-constants'
import { AGENT_DISPLAY_NAME } from './agent'

// Per-harness vocabularies for the effort/permission pickers — built from HARNESS_VOCAB
// (src/shared/chat-constants.ts), the single source of truth also consumed by
// server/endpoints.ts's validation sets (task-6 brief). Cursor's arrays are empty (see
// HARNESS_VOCAB's own comments), which setHarness reads to hide both selects entirely rather
// than rendering an all-placeholder, unusable picker. Placeholder-first, and picking the
// placeholder itself is a no-op (see the '' guards in the onChange handlers below) — a select
// stays on it until a started/config-changed event seeds a real value.
function effortOptionsFor(h: HarnessId): ReadonlyArray<{ value: string; label: string }> {
  return [{ value: '', label: 'effort…' }, ...HARNESS_VOCAB[h].efforts.map((v) => ({ value: v, label: v }))]
}

function permissionOptionsFor(h: HarnessId): ReadonlyArray<{ value: string; label: string }> {
  return [{ value: '', label: 'permissions…' }, ...HARNESS_VOCAB[h].permissionModes.map((v) => ({ value: v, label: v }))]
}

// The model picker's option set is NOT a fixed vocabulary like effort/permissions: the CLI
// exposes no enumerable model list, so the select offers the started/config-changed-reported
// model (the only ground truth for "current") PLUS these aliases — the CLI's own documented
// shorthands, resolved server-side by set_model (spike-verified in Task 1 with a full model
// id). Deduped when the current value IS one of the aliases; rebuilt on every seed so a
// config-changed to a model outside the list still renders as the selected option. Per-harness
// (Task 5, C1): Cursor has no documented model shorthands, so its select offers the
// session-reported value only — the same "no vocabulary" posture as its empty
// efforts/permissionModes arrays in HARNESS_VOCAB.
const MODEL_ALIASES: Record<HarnessId, readonly string[]> = {
  'claude-code': ['sonnet', 'opus', 'haiku'],
  cursor: [],
}

/** The model select's unseeded state — shared by the constructor and setHarness's model reset
 * (a harness switch returns the select to exactly this state until the new session reports its
 * own model), so the two can't drift. */
const MODEL_PLACEHOLDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [{ value: '', label: 'model…' }]

/** The config-picker cluster — the four selects (harness/model/effort/permission) plus the
 * per-harness vocabulary state that drives their options and the seed/revert paths. Constructed
 * by SessionFeed with an `onConfig` callback it fires (with ONLY the changed key) when a picker
 * changes; SessionFeed mounts `selects` into .composer-controls and drives the seed methods. */
export class ComposerConfig {
  readonly harnessSelect: HTMLSelectElement
  readonly modelSelect: HTMLSelectElement
  readonly effortSelect: HTMLSelectElement
  readonly permissionSelect: HTMLSelectElement
  /** The four selects in composer-controls order — SessionFeed appends these DIRECTLY (no
   * wrapper element) so they stay direct flex children of .composer-controls, byte-identical to
   * the pre-extraction DOM (tests reach them via .composer-controls > child[0] and by class). */
  readonly selects: readonly HTMLSelectElement[]

  /** Which harness the pickers currently reflect — mirrors harnessSelect.value but typed
   * (HarnessId) for HARNESS_VOCAB/MODEL_ALIASES lookups. getHarness() exposes it read-only so
   * index.ts's status-poll seed can skip a re-apply when the server-reported value already
   * matches (setHarness resets the effort/permission selects, which must only happen on a
   * genuine harness change — see setHarness's own doc comment). */
  private currentHarness: HarnessId = 'claude-code'
  /** Last-user-chosen effort/permissionMode seen via config-changed rows — re-applied to the
   * pickers on every `started` event (final-review fix 2). The manager now re-applies these
   * server-side on every respawn too (a respawned child otherwise silently reverts them), so
   * this keeps the UI honest about that reality instead of relying on DOM inertia (a `started`
   * event's payload carries no effort/permissionMode field to seed from directly). Undefined
   * until the first config-changed for that key — the pickers stay on their placeholder. */
  private lastEffort: string | undefined = undefined
  private lastPermission: string | undefined = undefined

  constructor(private readonly onConfig: (cfg: { model?: string; permissionMode?: string; effort?: string; harness?: HarnessId }) => void) {
    // Config pickers: harness, model, effort, and permission — each of the LAST three stays
    // on a placeholder option until a started/config-changed event seeds it; picking the
    // placeholder itself is a no-op (see the '' guards in the onChange handlers). The harness
    // select is different: it has no placeholder — a session always has a definite harness, so
    // it starts on 'claude-code' (this.currentHarness's own default) rather than an empty
    // option. The model select's options are rebuilt per seed (seedModelOptions) rather than
    // fixed like effort/permission — see the MODEL_ALIASES why-comment above. They used to live
    // in their own header bar (.session-config-bar, retired); composer consolidation (Task 1)
    // moves them into the composer's .composer-controls row instead — assembled by SessionFeed.
    this.harnessSelect = createSelect({
      className: 'session-harness',
      options: EMBEDDED_HARNESSES.map((h) => ({ value: h, label: AGENT_DISPLAY_NAME[h] })),
      value: this.currentHarness,
      // Deliberately does NOT call setHarness() itself — same posture as the effort/permission
      // selects below, which only POST the change and wait for the round-trip config-changed
      // event to actually re-render (seedConfigBar -> setHarness). Switching harness respawns
      // the session server-side, so the picker following the confirmed state (not the optimistic
      // click) keeps it honest if the respawn fails.
      onChange: (value) => this.onConfig({ harness: value as HarnessId }),
    })
    this.modelSelect = createSelect({
      className: 'session-model',
      options: MODEL_PLACEHOLDER_OPTIONS,
      value: '',
      onChange: (value) => {
        if (value === '') return
        this.onConfig({ model: value })
      },
    })
    this.effortSelect = createSelect({
      className: 'session-effort',
      options: effortOptionsFor(this.currentHarness),
      value: '',
      onChange: (value) => {
        if (value === '') return
        this.onConfig({ effort: value })
      },
    })
    this.permissionSelect = createSelect({
      className: 'session-permission',
      options: permissionOptionsFor(this.currentHarness),
      value: '',
      onChange: (value) => {
        if (value === '') return
        this.onConfig({ permissionMode: value })
      },
    })
    this.selects = [this.harnessSelect, this.modelSelect, this.effortSelect, this.permissionSelect]
  }

  /** Seeds the pickers from a `started` event (SessionFeed's stream handler). Model re-seeds
   * from the event itself, as before — the started payload IS the source of truth for which
   * model actually booted. Effort/permission carry no such field (control-request-only, or
   * spawn-flag-only for effort), so re-apply the last user-chosen values instead of leaving
   * them at whatever the DOM happened to hold. */
  seedFromStarted(e: Record<string, unknown>): void {
    this.seedConfigBar(e)
    this.effortSelect.value = this.lastEffort ?? ''
    this.permissionSelect.value = this.lastPermission ?? ''
  }

  /** Seeds the pickers from a `config-changed` event (SessionFeed's stream handler) and records
   * the last user-chosen effort/permissionMode so a later `started` (respawn) can re-apply them
   * — see lastEffort/lastPermission. */
  seedFromConfigChanged(e: Record<string, unknown>): void {
    this.seedConfigBar(e)
    if (typeof e.effort === 'string') this.lastEffort = e.effort
    if (typeof e.permissionMode === 'string') this.lastPermission = e.permissionMode
  }

  /** Seeds the config pickers from a started/config-changed event — only the keys present in
   * the event are applied, matching the "each select shows a placeholder until seeded"
   * contract. Programmatic .value / option rebuilds don't fire 'change', so this never loops
   * back into onConfig. harness is applied FIRST (via setHarness) so that a single event
   * carrying both `harness` and `model`/`effort`/`permissionMode` together already has the new
   * harness's MODEL_ALIASES/vocab in effect before those fields seed — setHarness's own
   * placeholder reset would otherwise stomp values this same call is about to set. */
  private seedConfigBar(e: Record<string, unknown>): void {
    if (isHarnessId(e.harness)) this.setHarness(e.harness)
    if (typeof e.model === 'string') this.seedModelOptions(e.model)
    if (typeof e.effort === 'string') this.effortSelect.value = e.effort
    if (typeof e.permissionMode === 'string') this.permissionSelect.value = e.permissionMode
  }

  /** Switches the composer's effort/permission pickers to a new harness's vocabulary (Task 5,
   * C1) — called both from seedConfigBar (a config-changed event confirming a harness the user
   * or the server picked) and from index.ts's status-poll seed (discovering an already-switched
   * harness, e.g. on a fresh page load). Resets both dependent selects to their placeholder
   * (the new/current session reports its own effort/permissionMode on its next config-changed,
   * same as a fresh `started`) and hides a select entirely when the harness has no vocabulary
   * for it — HARNESS_VOCAB's efforts/permissionModes are BOTH empty for cursor today, so both
   * selects disappear rather than rendering an all-placeholder, unusable picker. Also updates
   * currentHarness, which seedModelOptions reads to pick the right MODEL_ALIASES list, and
   * resets the model select to its unseeded placeholder state (final-review finding): the
   * previous harness's model + aliases are meaningless under the new harness — the new session
   * reports its own model via started/config-changed, at which point seedModelOptions rebuilds
   * with THIS harness's alias list. */
  setHarness(h: HarnessId): void {
    this.currentHarness = h
    this.harnessSelect.value = h
    const vocab = HARNESS_VOCAB[h]
    this.setSelectOptions(this.effortSelect, effortOptionsFor(h))
    this.effortSelect.value = ''
    this.effortSelect.hidden = vocab.efforts.length === 0
    this.setSelectOptions(this.permissionSelect, permissionOptionsFor(h))
    this.permissionSelect.value = ''
    this.permissionSelect.hidden = vocab.permissionModes.length === 0
    this.setSelectOptions(this.modelSelect, MODEL_PLACEHOLDER_OPTIONS)
    this.modelSelect.value = ''
  }

  /** Snaps every config picker back to its last CONFIRMED value — index.ts calls this when its
   * POST /__the-forge/session/config fails (409 while the session is busy — harness and effort
   * switches — or a network failure). The selects update optimistically on click, so a failed
   * POST would otherwise leave a never-applied value showing indefinitely: index.ts's poll-seed
   * guard compares against CONFIRMED state (getHarness()), which the click never touched, so
   * nothing else snaps the DOM back. Reads only state the seed paths already maintain — no
   * parallel bookkeeping: currentHarness (only setHarness writes it), the model select's own
   * first option (seedModelOptions puts the confirmed model first; the unseeded state's only
   * option is the '' placeholder), and lastEffort/lastPermission (the same values a respawn's
   * `started` re-applies). Reverting ALL four rather than just the failed key is deliberate:
   * onConfig carries only the changed key, so the other three already sit at their confirmed
   * values and the extra writes are no-ops. */
  revertConfig(): void {
    this.harnessSelect.value = this.currentHarness
    this.modelSelect.value = this.modelSelect.options[0]?.value ?? ''
    this.effortSelect.value = this.lastEffort ?? ''
    this.permissionSelect.value = this.lastPermission ?? ''
  }

  /** The harness the pickers currently reflect — see currentHarness's own doc comment for why
   * index.ts's status-poll seed needs this before calling setHarness. */
  getHarness(): HarnessId {
    return this.currentHarness
  }

  /** Rebuilds the model select's options as [current, ...MODEL_ALIASES[currentHarness]]
   * (deduped, current first) and selects the current model. Rebuilt — not appended to — on
   * every seed, so the placeholder disappears once a real model is known and a config-changed
   * to a model outside the list still renders as the selected option instead of silently
   * failing to match. */
  private seedModelOptions(current: string): void {
    const aliases = MODEL_ALIASES[this.currentHarness]
    const values = [current, ...aliases.filter((a) => a !== current)]
    this.setSelectOptions(this.modelSelect, values.map((v) => ({ value: v, label: v })))
    this.modelSelect.value = current
  }

  /** Shared option-rebuild for the model/effort/permission selects — replaces (not appends to)
   * a select's <option> children. Programmatic option rebuilds don't fire 'change', matching
   * seedConfigBar's own "never loops back into onConfig" contract. */
  private setSelectOptions(select: HTMLSelectElement, options: ReadonlyArray<{ value: string; label: string }>): void {
    select.replaceChildren(
      ...options.map((o) => {
        const opt = document.createElement('option')
        opt.value = o.value
        opt.textContent = o.label
        return opt
      })
    )
  }
}

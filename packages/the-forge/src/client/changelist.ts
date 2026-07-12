import type { DraftStore } from './drafts'
import type { StageEvent, LifecycleStage } from './verifier'
import type { ChangeItem } from './request'
import type { TaggedElement } from './source'
import { shortSource } from './source'
import type { LifecycleSession, SentSeed, SeedRecord } from './lifecycle'
import { collapseRow } from './motion'

export type { SentSeed } from './lifecycle'

export interface ChangeListCallbacks {
  onHover: (el: TaggedElement | null) => void
  onSelect: (el: TaggedElement) => void
  onResend: (seed: SentSeed) => void
}

function summarizeItem(c: ChangeItem): string {
  if (c.beforeUtility && c.afterUtility) return `${c.beforeUtility} → ${c.afterUtility}`
  if (c.afterUtility) return `add ${c.afterUtility}`
  return `${c.property}: ${c.beforeCss} → ${c.afterCss}`
}

/** Shared "+N more" collapse for sent-row (summarize) summaries — `text` is the visible
 * summary (first entry, +N more if there's more than one), `full` is the newline-joined tooltip
 * shown via the row's title attribute. */
function collapseWithMore(all: string[]): { text: string; full: string } {
  const text = all.length > 1 ? `${all[0]} +${all.length - 1} more` : (all[0] ?? '')
  return { text, full: all.join('\n') }
}

function summarize(changes: ChangeItem[]): { text: string; full: string } {
  return collapseWithMore(changes.map(summarizeItem))
}

/** Renders the send/verify lifecycle as rows. Sent-row state lives in LifecycleSession now —
 * this class is a view over it plus the DraftStore: DOM building, draft dedup, interactions. */
export class ChangeList {
  root = document.createElement('div')

  private head = document.createElement('div')
  private clearButton = document.createElement('button')
  private list = document.createElement('div')
  /** Set by clear() (design-mode off) and cleared by the next syncDrafts() — suppresses the
   * draft-row render loop so a clear() while the DraftStore still holds stale drafts (the
   * DraftStore is owned/cleared by the caller, not this class) doesn't resurrect rows. */
  private suppressDrafts = false
  /** Same idea for sent rows, cleared by the next addSent()/applyStage(): clear() must hide
   * rows WITHOUT wiping the session — the verifier keeps polling its entries across a
   * deactivate/reactivate. */
  private suppressSeedRecords = false
  /** Stage seen at the previous render, keyed by SeedRecord identity — render() rebuilds every
   * row via replaceChildren(), so CSS transitions can never fire across a stage change and
   * a bare entry animation would replay on EVERY re-render (each scrub tick rebuilds the
   * list). .stage-flip therefore lands only on the one render where a row's stage actually
   * differs from what this map last saw — the pop/shake plays once, then the next render
   * (whatever triggers it) rebuilds the row without the class. Keyed by the RECORD, not
   * row.seed: index.ts's resend() reuses the SAME SentSeed object under a new request id
   * (removeSeed → registerQueuedSend), so a seed-keyed entry would survive retirement and
   * flip the resent row's FIRST render (stale 'failed' remembered vs fresh 'sent') — records
   * are minted fresh per register() (lifecycle.ts) and identity-stable across renders, so a
   * re-registration starts clean by construction, no manual invalidation to forget. */
  private lastStages = new WeakMap<SeedRecord, LifecycleStage>()

  constructor(
    private drafts: DraftStore,
    private session: LifecycleSession,
    private cb: ChangeListCallbacks
  ) {
    this.root.className = 'changes-section'
    this.root.hidden = true
    this.head.className = 'changes-head'
    const title = document.createElement('span')
    title.textContent = 'Changes'
    this.clearButton.className = 'changes-clear'
    this.clearButton.textContent = 'Clear done'
    this.clearButton.addEventListener('click', () => this.session.clearResolved())
    this.head.append(title, this.clearButton)
    this.list.className = 'changes-list'
    this.root.append(this.head, this.list)
    this.session.onChange(() => this.render())
  }

  syncDrafts(): void {
    this.suppressDrafts = false
    this.render()
  }

  // Thin delegates to the session (state lives there now) — kept here for one call surface;
  // the session's onChange subscription (constructor) drives the re-render.
  addSent(id: string, seeds: SentSeed[]): void {
    this.suppressSeedRecords = false
    this.session.register(id, seeds)
  }

  applyStage(e: StageEvent): boolean {
    this.suppressSeedRecords = false
    return this.session.applyStage(e)
  }

  /** Design-mode-off teardown: visually clears every row WITHOUT touching the session (the
   * verifier keeps polling its entries across a deactivate/reactivate). Suppression lifts on
   * the next real mutation. */
  clear(): void {
    this.suppressSeedRecords = true
    this.suppressDrafts = true
    this.render()
  }

  /** Props of `el` covered by an in-flight (sent/applying) row — those edits are already
   * represented; a draft row repeating them would show the same change twice. */
  private inFlightProps(el: TaggedElement, rows: SeedRecord[]): Set<string> {
    const props = new Set<string>()
    for (const row of rows) {
      if (row.seed.el !== el) continue
      if (row.stage !== 'sent' && row.stage !== 'applying') continue
      for (const p of row.seed.draftProps) props.add(p)
    }
    return props
  }

  private render(): void {
    this.session.healPlaceholders()
    this.list.replaceChildren()
    let terminalOk = 0

    // Sent rows first (newest last in session insertion order — reverse for newest-first display).
    const rows: SeedRecord[] = this.suppressSeedRecords ? [] : this.session.records()
    for (const row of [...rows].reverse()) {
      this.list.appendChild(this.renderSeedRecord(row))
      if (row.stage === 'done' || row.stage === 'unverified') terminalOk++
    }

    // Draft rows after sent rows: drafts are "not yet part of the story being told above".
    if (!this.suppressDrafts) {
      for (const [el, props] of this.drafts.entries()) {
        const inFlight = this.inFlightProps(el as TaggedElement, rows)
        const remaining = [...props.entries()].filter(([prop]) => !inFlight.has(prop))
        if (remaining.length === 0) continue
        this.list.appendChild(this.renderDraftRow(el as TaggedElement, remaining))
      }
    }

    this.clearButton.hidden = terminalOk === 0
    this.root.hidden = this.list.childElementCount === 0
  }

  private baseRow(stage: LifecycleStage | 'draft', el: TaggedElement | null): HTMLElement {
    const row = document.createElement('div')
    row.className = 'change-row'
    row.dataset.stage = stage
    const chip = document.createElement('span')
    chip.className = `chip chip-${stage}`
    chip.textContent = stage
    row.appendChild(chip)
    if (el) {
      const locatable = el.isConnected
      if (!locatable) row.classList.add('row-gone')
      row.addEventListener('mouseenter', () => this.cb.onHover(el.isConnected ? el : null))
      row.addEventListener('mouseleave', () => this.cb.onHover(null))
      row.addEventListener('click', () => {
        if (el.isConnected) this.cb.onSelect(el)
      })
    }
    return row
  }

  private elLabel(tag: string, dcSource: string | null): HTMLElement {
    const elLabel = document.createElement('span')
    elLabel.className = 'change-el'
    // shortSource takes a non-null source (it's the shared src/client/source.ts export, also
    // used by index.ts/panel.ts/session-feed.ts) — the null case (no dcSource at all) is
    // handled here, matching shortSource's own '(no source)' fallback for an unparseable one.
    elLabel.textContent = `${tag} · ${dcSource ? shortSource(dcSource) : '(no source)'}`
    return elLabel
  }

  private renderDraftRow(el: TaggedElement, props: Array<[string, { original: string; value: string }]>): HTMLElement {
    const row = this.baseRow('draft', el)
    const dcSource = el.dataset?.dcSource ?? null
    row.appendChild(this.elLabel(el.tagName.toLowerCase(), dcSource))
    // Draft rows list EVERY drafted property (2026-07-11 draft-badge spec) — the disclosure
    // is already the user's opt-in to detail, so nothing hides behind "+N more"/title here.
    // The value shown is the inline draft (`prop → value`, no "before"): the DraftStore's
    // recorded original is the prior INLINE style (usually empty) — the real before/after
    // pair only exists at send time via computed styles. Sent rows keep collapseWithMore.
    for (const [prop, d] of props) {
      const line = document.createElement('div')
      line.className = 'change-detail'
      line.textContent = `${prop} → ${d.value}`
      row.appendChild(line)
    }
    return row
  }

  private renderSeedRecord(row: SeedRecord): HTMLElement {
    const dom = this.baseRow(row.stage, row.seed.el)
    const prev = this.lastStages.get(row)
    if (prev !== undefined && prev !== row.stage) dom.classList.add('stage-flip')
    this.lastStages.set(row, row.stage)
    const source = row.seed.change.source
    const dcSource = source ? `${source.file}:${source.line}:${source.col}` : row.seed.dcSource
    const elLabel = this.elLabel(row.seed.change.tag, dcSource)
    // .change-summary is a sent/history-row affair only — draft rows itemize per property
    // (.change-detail) instead, which is why the span is built here and not in elLabel().
    const summary = document.createElement('span')
    summary.className = 'change-summary'
    const { text, full } = summarize(row.seed.change.changes)
    summary.textContent = text
    summary.title = full
    dom.append(elLabel, summary)
    if (row.stage === 'mismatch' && row.mismatches?.length) {
      const note = document.createElement('div')
      note.className = 'change-note change-note-mismatch'
      note.textContent = row.mismatches.map((m) => `${m.property}: expected ${m.expected}, got ${m.actual}`).join('; ')
      dom.appendChild(note)
    }
    if (row.stage === 'failed') {
      if (row.note) {
        const note = document.createElement('div')
        note.className = 'change-note'
        note.textContent = row.note
        dom.appendChild(note)
      }
      dom.appendChild(this.failedActions(row))
    }
    return dom
  }

  private failedActions(row: SeedRecord): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'change-actions'
    const resend = document.createElement('button')
    resend.className = 'change-resend'
    resend.textContent = 'Re-send'
    resend.addEventListener('click', (e) => {
      e.stopPropagation() // row click selects the element — actions must not
      // Row removal moved to the resend SUCCESS path (final-review F5): dismissing here, before
      // the re-queue POST resolves, left the user with nothing but a button flash if the POST
      // failed — no record of the still-failed change. The host (index.ts resend()) now calls
      // session.removeSeed() itself right before re-registering the seed under the new id (R2
      // minor: ChangeList's own removeRow() wrapper was removed — every real caller already
      // called session.removeSeed directly).
      this.cb.onResend(row.seed)
    })
    const dismiss = document.createElement('button')
    dismiss.className = 'change-dismiss'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation()
      // Collapse first, mutate after — the removeSeed() re-render discards this element,
      // so animating post-removal is impossible. A re-render landing mid-collapse discards
      // the animating row early; collapseRow's timeout still fires onDone, so the seed is
      // removed either way (removal is the invariant, the collapse is garnish).
      const rowEl = (e.currentTarget as HTMLElement).closest('.change-row') as HTMLElement | null
      if (rowEl) collapseRow(rowEl, () => this.session.removeSeed(row.seed))
      else this.session.removeSeed(row.seed)
    })
    actions.append(resend, dismiss)
    return actions
  }
}

import type { DraftStore } from './drafts'
import type { StageEvent, LifecycleStage } from './verifier'
import type { ChangeItem } from './request'
import type { TaggedElement } from './source'
import { parseSourceAttr } from './source'
import type { LifecycleSession, SentSeed, SeedRecord } from './lifecycle'

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

function summarize(changes: ChangeItem[]): { text: string; full: string } {
  const all = changes.map(summarizeItem)
  const text = all.length > 1 ? `${all[0]} +${all.length - 1} more` : (all[0] ?? '')
  return { text, full: all.join('\n') }
}

function shortSource(dcSource: string | null): string {
  if (!dcSource) return '(no source)'
  const parsed = parseSourceAttr(dcSource)
  if (!parsed) return '(no source)'
  const slash = parsed.file.lastIndexOf('/')
  return `${slash === -1 ? parsed.file : parsed.file.slice(slash + 1)}:${parsed.line}`
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

  removeRow(seed: SentSeed): void {
    this.session.removeSeed(seed)
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

  private label(tag: string, dcSource: string | null): [HTMLElement, HTMLElement] {
    const elLabel = document.createElement('span')
    elLabel.className = 'change-el'
    elLabel.textContent = `${tag} · ${shortSource(dcSource)}`
    const summary = document.createElement('span')
    summary.className = 'change-summary'
    return [elLabel, summary]
  }

  private renderDraftRow(el: TaggedElement, props: Array<[string, { original: string; value: string }]>): HTMLElement {
    const row = this.baseRow('draft', el)
    const dcSource = el.dataset?.dcSource ?? null
    const [elLabel, summary] = this.label(el.tagName.toLowerCase(), dcSource)
    const all = props.map(([prop, d]) => `${prop} → ${d.value}`)
    summary.textContent = all.length > 1 ? `${all[0]} +${all.length - 1} more` : all[0]
    summary.title = all.join('\n')
    row.append(elLabel, summary)
    return row
  }

  private renderSeedRecord(row: SeedRecord): HTMLElement {
    const dom = this.baseRow(row.stage, row.seed.el)
    const source = row.seed.change.source
    const dcSource = source ? `${source.file}:${source.line}:${source.col}` : row.seed.dcSource
    const [elLabel, summary] = this.label(row.seed.change.tag, dcSource)
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
      // removeRow() itself right before re-registering the seed under the new id.
      this.cb.onResend(row.seed)
    })
    const dismiss = document.createElement('button')
    dismiss.className = 'change-dismiss'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation()
      this.session.removeSeed(row.seed)
    })
    actions.append(resend, dismiss)
    return actions
  }
}

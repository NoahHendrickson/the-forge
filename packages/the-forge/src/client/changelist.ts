import type { DraftStore } from './drafts'
import type { StageEvent, LifecycleStage } from './verifier'
import type { ElementChange, ChangeItem } from './request'
import type { TaggedElement } from './source'
import { parseSourceAttr } from './source'

export interface SentSeed {
  el: TaggedElement
  dcSource: string | null
  draftProps: string[]
  change: ElementChange
}

export interface ChangeListCallbacks {
  onHover: (el: TaggedElement | null) => void
  onSelect: (el: TaggedElement) => void
  onResend: (seed: SentSeed) => void
}

/** Stages a row can no longer leave via poll events — a late 'sent'/'applying' tick for an
 * already-resolved id (races between take() and the next poll) must not resurrect a receipt. */
const TERMINAL: ReadonlySet<LifecycleStage> = new Set(['done', 'mismatch', 'unverified', 'failed'])

interface SentRow {
  seed: SentSeed
  stage: LifecycleStage
  note?: string
  mismatches?: StageEvent['mismatches']
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

export class ChangeList {
  root = document.createElement('div')

  private head = document.createElement('div')
  private clearButton = document.createElement('button')
  private list = document.createElement('div')
  private sentRows = new Map<string, SentRow>() // key: `${requestId}:${elIndex}`
  /** Set by clear() (design-mode off) and cleared by the next syncDrafts() — suppresses the
   * draft-row render loop so a clear() while the DraftStore still holds stale drafts (the
   * DraftStore is owned/cleared by the caller, not this class) doesn't resurrect rows. */
  private suppressDrafts = false

  constructor(
    private drafts: DraftStore,
    private cb: ChangeListCallbacks
  ) {
    this.root.className = 'changes-section'
    this.root.hidden = true
    this.head.className = 'changes-head'
    const title = document.createElement('span')
    title.textContent = 'Changes'
    this.clearButton.className = 'changes-clear'
    this.clearButton.textContent = 'Clear done'
    this.clearButton.addEventListener('click', () => this.clearDone())
    this.head.append(title, this.clearButton)
    this.list.className = 'changes-list'
    this.root.append(this.head, this.list)
  }

  syncDrafts(): void {
    this.suppressDrafts = false
    this.render()
  }

  addSent(id: string, seeds: SentSeed[]): void {
    seeds.forEach((seed, i) => this.sentRows.set(`${id}:${i}`, { seed, stage: 'sent' }))
    this.render()
  }

  applyStage(e: StageEvent): void {
    const row = this.sentRows.get(`${e.requestId}:${e.elIndex}`)
    if (!row) return
    if (row.stage === e.stage) return // poll re-emissions are expected — no re-render churn
    if (TERMINAL.has(row.stage)) return
    row.stage = e.stage
    row.note = e.note
    row.mismatches = e.mismatches
    this.render()
  }

  clearDone(): void {
    for (const [key, row] of this.sentRows) {
      if (row.stage === 'done' || row.stage === 'unverified') this.sentRows.delete(key)
    }
    this.render()
  }

  clear(): void {
    this.sentRows.clear()
    this.suppressDrafts = true
    this.render()
  }

  /** Props of `el` covered by an in-flight (sent/applying) row — those edits are already
   * represented; a draft row repeating them would show the same change twice. */
  private inFlightProps(el: TaggedElement): Set<string> {
    const props = new Set<string>()
    for (const row of this.sentRows.values()) {
      if (row.seed.el !== el) continue
      if (row.stage !== 'sent' && row.stage !== 'applying') continue
      for (const p of row.seed.draftProps) props.add(p)
    }
    return props
  }

  private render(): void {
    this.list.replaceChildren()
    let terminalOk = 0

    // Sent rows first (newest last in insertion order — reverse for newest-first display).
    const sentEntries = [...this.sentRows.entries()].reverse()
    for (const [, row] of sentEntries) {
      this.list.appendChild(this.renderSentRow(row))
      if (row.stage === 'done' || row.stage === 'unverified') terminalOk++
    }

    // Draft rows after sent rows: drafts are "not yet part of the story being told above".
    if (!this.suppressDrafts) {
      for (const [el, props] of this.drafts.entries()) {
        const inFlight = this.inFlightProps(el as TaggedElement)
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

  private renderSentRow(row: SentRow): HTMLElement {
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

  private failedActions(row: SentRow): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'change-actions'
    const resend = document.createElement('button')
    resend.className = 'change-resend'
    resend.textContent = 'Re-send'
    resend.addEventListener('click', (e) => {
      e.stopPropagation() // row click selects the element — actions must not
      this.dismissRow(row)
      this.cb.onResend(row.seed)
    })
    const dismiss = document.createElement('button')
    dismiss.className = 'change-dismiss'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation()
      this.dismissRow(row)
    })
    actions.append(resend, dismiss)
    return actions
  }

  private dismissRow(row: SentRow): void {
    for (const [key, r] of this.sentRows) {
      if (r === row) this.sentRows.delete(key)
    }
    this.render()
  }
}

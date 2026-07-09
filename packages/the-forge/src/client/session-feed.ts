// Not EventSource: EventSource cannot send custom request headers. The event stream
// requires X-Forge-Secret for auth (same as all mutating endpoints), so we use
// fetch + ReadableStream + manual NDJSON parsing instead.
import { createButton } from './ui/button'

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
  | { kind: 'tool-started'; toolId: string; name: string; detail: string }
  | { kind: 'tool-finished'; toolId: string }
  | { kind: 'turn-complete'; isError: boolean; errorText?: string; costUsd?: number }
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
  /** Called when the user clicks Stop — host wires to POST /__the-forge/session/interrupt. */
  onInterrupt: () => void = () => {}
  /** Called when user clicks Allow/Deny on an approval row — host wires to the decide endpoint. */
  onDecide: (id: string, allow: boolean) => void = () => {}

  private readonly statusRow: HTMLElement
  private readonly list: HTMLElement
  private readonly stopBtn: HTMLButtonElement

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
  /** True after any tool-started/assistant-text, cleared on turn-complete/ended/session-error.
   * Controls Stop button visibility: visible while a turn is in flight ("busyish" state). */
  private busyish = false

  private readonly fetchFn: typeof fetch
  private readonly getHeaders: () => Record<string, string>

  constructor(opts: SessionFeedOpts = {}) {
    this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis)
    this.getHeaders = opts.headers ?? (() => ({}))

    this.root = document.createElement('div')
    this.root.className = 'session-feed'
    this.root.hidden = true

    this.statusRow = document.createElement('div')
    this.statusRow.className = 'session-row session-status'
    this.statusRow.hidden = true

    // Stop button: fires onInterrupt while a turn is in flight
    this.stopBtn = createButton({ label: 'Stop', className: 'session-stop' })
    this.stopBtn.hidden = true
    this.stopBtn.addEventListener('click', () => this.onInterrupt())

    this.list = document.createElement('div')
    this.list.className = 'session-list'

    this.root.append(this.statusRow, this.stopBtn, this.list)
  }

  /** Open the NDJSON stream — called when design mode turns on. Re-entrant guard: if a fetch
   * is already live (controller set), does nothing — stop() + start() for a forced reconnect. */
  start(): void {
    if (this.controller !== null) return
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
    if (kind === 'started') {
      const model = typeof e.model === 'string' ? e.model : '?'
      this.setStatus(`Session started · ${model}`)
    } else if (kind === 'assistant-text') {
      const text = typeof e.text === 'string' ? e.text : ''
      this.addRow(this.makeTextRow(text))
      this.setBusyish(true)
    } else if (kind === 'tool-started') {
      const toolId = typeof e.toolId === 'string' ? e.toolId : ''
      const name = typeof e.name === 'string' ? e.name : ''
      const detail = typeof e.detail === 'string' ? e.detail : ''
      const row = this.makeToolRow(toolId, name, detail)
      this.toolRows.set(toolId, row)
      this.addRow(row)
      this.setBusyish(true)
    } else if (kind === 'tool-finished') {
      const toolId = typeof e.toolId === 'string' ? e.toolId : ''
      const row = this.toolRows.get(toolId)
      if (row) {
        const spinner = row.querySelector('.session-spinner')
        if (spinner) spinner.textContent = '✓'
      }
    } else if (kind === 'turn-complete') {
      if (e.isError === true) {
        const errorText = typeof e.errorText === 'string' ? e.errorText : 'Turn error'
        this.addRow(this.makeErrorRow(errorText))
      }
      this.setBusyish(false)
    } else if (kind === 'session-error') {
      const text = typeof e.text === 'string' ? e.text : 'Session error'
      this.addRow(this.makeErrorRow(text))
      this.setBusyish(false)
    } else if (kind === 'ended') {
      this.setStatus('Session ended')
      this.setBusyish(false)
    }
    // unknown kind → ignore silently
  }

  // ---------------------------------------------------------------------------
  // Rendering helpers
  // ---------------------------------------------------------------------------

  private setStatus(text: string): void {
    this.statusRow.textContent = text
    this.statusRow.hidden = false
    this.root.hidden = false
  }

  private setBusyish(on: boolean): void {
    this.busyish = on
    this.stopBtn.hidden = !on
  }

  private makeTextRow(text: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'session-row'
    // Truncate to ~200 chars to keep the panel scannable; full text in tooltip
    const snippet = text.length > 200 ? `${text.slice(0, 200)}\u2026` : text
    row.textContent = snippet
    row.title = text
    return row
  }

  private makeToolRow(toolId: string, name: string, detail: string): HTMLElement {
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
    return row
  }

  private makeErrorRow(text: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'session-row session-error-row'
    row.textContent = text
    return row
  }

  private renderApproval(id: string, toolName: string, detail: string): void {
    const row = document.createElement('div')
    row.className = 'session-row session-approval'
    row.dataset.approvalId = id

    const label = document.createElement('span')
    label.textContent = `${toolName}: ${detail}`

    const allowBtn = createButton({ label: 'Allow', className: 'session-approval-allow' })
    allowBtn.addEventListener('click', () => this.onDecide(id, true))

    const denyBtn = createButton({ label: 'Deny', className: 'session-approval-deny' })
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
    }
  }
}

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionFeed } from '../../src/client/session-feed'

// Fake timers for all tests — the reconnect loop uses setTimeout, which fake timers
// control. Microtask-based stream reading is unaffected (microtasks are not timers).
beforeEach(() => {
  document.body.innerHTML = ''
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** Drain pending microtasks — each round resolves one Promise.resolve() level.
 * ReadableStream with sync-enqueued chunks resolves each read() as a microtask, so
 * 40 rounds covers startup + up to ~30 NDJSON lines comfortably. */
async function flush(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => queueMicrotask(r))
  }
}

function makeBody(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'))
      }
      controller.close()
    },
  })
}

function feedLine(seq: number, event: object): string {
  return JSON.stringify({ type: 'feed', seq, at: new Date().toISOString(), event })
}

/** Returns a fetchFn that yields the given lines as NDJSON and then closes the stream. */
function makeFetchFn(lines: string[], status = 200): typeof fetch {
  return ((_url: RequestInfo | URL, _init?: RequestInit) => {
    if (status !== 200) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'embedded session unavailable' }), { status }))
    }
    return Promise.resolve(
      new Response(makeBody(lines), {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
    )
  }) as typeof fetch
}

/** fetchFn that never resolves — hangs until the AbortController fires. */
function hangingFetch(onAbort?: () => void): typeof fetch {
  return ((_url: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, _reject) => {
      const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined
      if (signal) {
        signal.addEventListener('abort', () => {
          onAbort?.()
        })
      }
    })
  }) as typeof fetch
}

// ---------------------------------------------------------------------------
// Class shape
// ---------------------------------------------------------------------------

describe('class shape', () => {
  it('root has class session-feed and is hidden initially', () => {
    const feed = new SessionFeed()
    expect(feed.root.className).toBe('session-feed')
    expect(feed.root.hidden).toBe(true)
  })

  it('exposes onInterrupt and onDecide as assignable callbacks', () => {
    const feed = new SessionFeed()
    let interruptFired = false
    feed.onInterrupt = () => { interruptFired = true }
    let decided: [string, boolean] | null = null
    feed.onDecide = (id, allow) => { decided = [id, allow] }
    // callbacks are wired — just verify they're settable and callable
    feed.onInterrupt()
    feed.onDecide('x', true)
    expect(interruptFired).toBe(true)
    expect(decided).toEqual(['x', true])
  })
})

// ---------------------------------------------------------------------------
// Composer shell (composer consolidation Task 1): card, controls row, placeholder
// statuses — retires the status row, standalone Stop button, and .session-config-bar.
// ---------------------------------------------------------------------------

describe('composer shell', () => {
  it('builds .chat-composer with chip, textarea, and controls rows', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const composer = feed.root.querySelector('.chat-composer')
    expect(composer).not.toBeNull()
    expect(composer?.querySelector('.composer-chips')).not.toBeNull()
    expect(composer?.querySelector('.chat-textarea')).not.toBeNull()
    expect(composer?.querySelector('.composer-controls')).not.toBeNull()
  })

  it('the element chip lives inside .composer-chips', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const chips = feed.root.querySelector('.composer-chips')
    expect(chips?.querySelector('.chat-chip')).not.toBeNull()
  })

  it('the three pickers and composer-send live in .composer-controls, and .session-config-bar is gone', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const controls = feed.root.querySelector('.composer-controls')
    expect(controls).not.toBeNull()
    expect(controls?.querySelector('.session-model')).not.toBeNull()
    expect(controls?.querySelector('.session-effort')).not.toBeNull()
    expect(controls?.querySelector('.session-permission')).not.toBeNull()
    expect(controls?.querySelector('.composer-send')).not.toBeNull()
    expect(feed.root.querySelector('.session-config-bar')).toBeNull()
  })

  it('the status row and standalone Stop button are gone', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    expect(feed.root.querySelector('.session-status')).toBeNull()
    expect(feed.root.querySelector('.session-stop')).toBeNull()
  })

  it('getText/clearText round-trip: getText trims, clearText empties and re-evaluates the morph', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = '  hello world  '
    expect(feed.getText()).toBe('hello world')
    feed.clearText()
    expect(textarea.value).toBe('')
    expect(feed.getText()).toBe('')
  })

  it('placeholder mapping follows setSessionState', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    feed.setSessionState('idle')
    expect(textarea.placeholder).toBe('Message, or send your edits…')
    feed.setSessionState('ready')
    expect(textarea.placeholder).toBe('Message, or send your edits…')
    feed.setSessionState('starting')
    expect(textarea.placeholder).toBe('Starting session…')
    feed.setSessionState('busy')
    expect(textarea.placeholder).toBe('Working…')
    feed.setSessionState('failed')
    expect(textarea.placeholder).toBe('Message to retry…')
  })

  it("setSessionState('unavailable') leaves the placeholder untouched — setAvailability owns that path", () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    feed.setSessionState('busy')
    expect(textarea.placeholder).toBe('Working…')
    feed.setSessionState('unavailable')
    expect(textarea.placeholder).toBe('Working…') // unchanged
  })
})

// ---------------------------------------------------------------------------
// Drafts pill + disclosure (composer consolidation Task 2) — the pill lives in
// .composer-chips alongside the element chip; .draft-disclosure is a sibling block, above
// .composer-chips, hosting draftSlot (where index.ts appends the unmodified ChangeList's root).
// ---------------------------------------------------------------------------

describe('drafts pill + disclosure', () => {
  it('the drafts pill lives in .composer-chips alongside the element chip', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const chips = feed.root.querySelector('.composer-chips') as HTMLElement
    expect(chips.querySelector('.draft-pill')).not.toBeNull()
    expect(chips.querySelector('.chat-chip')).not.toBeNull()
  })

  it('.draft-disclosure is a sibling of .composer-chips inside .chat-composer, not nested in it', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const composer = feed.root.querySelector('.chat-composer') as HTMLElement
    const chips = composer.querySelector('.composer-chips') as HTMLElement
    const disclosure = composer.querySelector('.draft-disclosure') as HTMLElement
    expect(disclosure).not.toBeNull()
    expect(disclosure.parentElement).toBe(composer)
    expect(chips.contains(disclosure)).toBe(false)
  })

  it('draftSlot is reachable inside .draft-disclosure and hosts appended content', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const marker = document.createElement('div')
    marker.className = 'marker'
    feed.draftSlot.appendChild(marker)
    const disclosure = feed.root.querySelector('.draft-disclosure') as HTMLElement
    expect(disclosure.contains(marker)).toBe(true)
  })

  it('pill is hidden at zero drafts and not applying', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    expect(pill.hidden).toBe(true)
  })

  it('setDraftState(2, false) unhides the pill with the plural count copy', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setDraftState({ count: 2, applying: false })
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    expect(pill.hidden).toBe(false)
    expect(pill.textContent).toBe('2 edits drafted')
  })

  it('setDraftState(1, false) uses the singular copy', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setDraftState({ count: 1, applying: false })
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    expect(pill.textContent).toBe('1 edit drafted')
  })

  it('applying:true shows "applying…" and wins over a nonzero count', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setDraftState({ count: 3, applying: true })
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    expect(pill.hidden).toBe(false)
    expect(pill.textContent).toBe('applying…')
  })

  it('applying:true with count 0 still shows the pill', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setDraftState({ count: 0, applying: true })
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    expect(pill.hidden).toBe(false)
    expect(pill.textContent).toBe('applying…')
  })

  it('count===0 && !applying hides the pill and force-closes the disclosure', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    const disclosure = feed.root.querySelector('.draft-disclosure') as HTMLElement
    feed.setDraftState({ count: 2, applying: false })
    pill.click()
    expect(disclosure.classList.contains('open')).toBe(true)
    feed.setDraftState({ count: 0, applying: false })
    expect(pill.hidden).toBe(true)
    expect(disclosure.classList.contains('open')).toBe(false)
  })

  it('clicking the pill toggles .draft-disclosure open/closed', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setDraftState({ count: 1, applying: false })
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    const disclosure = feed.root.querySelector('.draft-disclosure') as HTMLElement
    expect(disclosure.classList.contains('open')).toBe(false)
    pill.click()
    expect(disclosure.classList.contains('open')).toBe(true)
    pill.click()
    expect(disclosure.classList.contains('open')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Stream consumption — rows rendered from events
// ---------------------------------------------------------------------------

describe('stream consumption', () => {
  // Composer consolidation (Task 1) retired the status row — a 'started' event no longer
  // writes chrome text anywhere; it just unhides the root and seeds the model select (the
  // model info's real home now).
  it('a started event unhides the feed root and seeds the model select (status row retired)', async () => {
    const feed = new SessionFeed({
      fetchFn: makeFetchFn([feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-3-5-sonnet', mcpLoaded: true })]),
    })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(feed.root.hidden).toBe(false)
    expect(feed.root.querySelector('.session-status')).toBeNull()
    const modelSelect = feed.root.querySelector('select.session-model') as HTMLSelectElement
    expect(modelSelect.value).toBe('claude-3-5-sonnet')
    feed.stop()
  })

  it('renders rows from replayed + live events', async () => {
    const lines = [
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true }),
      feedLine(2, { kind: 'assistant-text', text: 'Hello from Claude' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    // 'started' no longer adds a row of its own (status row retired) — only the text row.
    const rows = feed.root.querySelectorAll('.session-row')
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(feed.root.textContent).toContain('Hello from Claude')
    feed.stop()
  })

  it('renders an assistant-text bubble with the FULL text, no truncation (chat bubbles, unlike the old snippet row)', async () => {
    const longText = 'x'.repeat(300)
    const feed = new SessionFeed({ fetchFn: makeFetchFn([feedLine(1, { kind: 'assistant-text', text: longText })]) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubble = feed.root.querySelector('.chat-msg.chat-assistant')
    expect(bubble?.textContent).toBe(longText)
    feed.stop()
  })

  it('pairs tool-started spinner with tool-finished check', async () => {
    const lines = [
      feedLine(1, { kind: 'tool-started', toolId: 't1', name: 'Read', detail: 'src/App.tsx' }),
      feedLine(2, { kind: 'tool-finished', toolId: 't1' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const toolRow = feed.root.querySelector('[data-tool-id="t1"]')
    expect(toolRow).not.toBeNull()
    expect(toolRow?.querySelector('.session-spinner')?.textContent).toBe('✓')
    feed.stop()
  })

  it('unmatched tool-finished (no prior tool-started) does not crash', async () => {
    const lines = [feedLine(1, { kind: 'tool-finished', toolId: 'ghost' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    expect(() => feed.start()).not.toThrow()
    await flush()
    feed.stop()
  })

  it('in-band error (turn-complete isError) renders a session-error-row, not a crash', async () => {
    const lines = [feedLine(1, { kind: 'turn-complete', isError: true, errorText: 'Rate limit exceeded' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const errorRow = feed.root.querySelector('.session-error-row')
    expect(errorRow).not.toBeNull()
    expect(errorRow?.textContent).toContain('Rate limit exceeded')
    feed.stop()
  })

  it('session-error event renders an error row and morphs composer-send back to send mode', async () => {
    const lines = [feedLine(1, { kind: 'session-error', text: 'Spawn failed' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(feed.root.querySelector('.session-error-row')?.textContent).toContain('Spawn failed')
    const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement
    expect(sendBtn.textContent).toBe('↑')
    expect(sendBtn.getAttribute('aria-label')).toBe('Send')
    feed.stop()
  })

  it('ended event flips busyish off — composer-send morphs back to send mode (status row retired)', async () => {
    const lines = [
      feedLine(1, { kind: 'assistant-text', text: 'hi' }), // makes busyish=true
      feedLine(2, { kind: 'ended' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(feed.root.querySelector('.session-status')).toBeNull()
    const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement
    expect(sendBtn.textContent).toBe('↑')
    feed.stop()
  })

  it('composer-send morphs to ■ while busyish and the textarea is empty (after tool-started, before turn-complete)', async () => {
    // Only tool-started, no turn-complete → busyish stays true
    const lines = [feedLine(1, { kind: 'tool-started', toolId: 't1', name: 'Write', detail: 'x.ts' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement
    expect(sendBtn.textContent).toBe('■')
    expect(sendBtn.getAttribute('aria-label')).toBe('Stop')
    feed.stop()
  })

  it('composer-send in stop mode fires onInterrupt on click', async () => {
    const lines = [feedLine(1, { kind: 'assistant-text', text: 'working…' })]
    let fired = 0
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    feed.onInterrupt = () => fired++
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const stop = feed.root.querySelector('.composer-send') as HTMLButtonElement
    expect(stop.textContent).toBe('■')
    stop.click()
    expect(fired).toBe(1)
    feed.stop()
  })

  it('typing while busyish flips composer-send back to ↑, and click fires onSend, not onInterrupt', async () => {
    const lines = [feedLine(1, { kind: 'assistant-text', text: 'working…' })]
    let interrupts = 0
    let sends = 0
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    feed.onInterrupt = () => interrupts++
    feed.onSend = () => sends++
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    expect(sendBtn.textContent).toBe('■') // busyish + empty
    textarea.value = 'hold on'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    expect(sendBtn.textContent).toBe('↑') // typing flips the morph back immediately
    sendBtn.click()
    expect(sends).toBe(1)
    expect(interrupts).toBe(0)
    feed.stop()
  })

  it('malformed JSON lines are ignored without crashing', async () => {
    const lines = [
      'not json at all',
      feedLine(1, { kind: 'assistant-text', text: 'valid line' }),
      '{broken',
      '42', // not an object
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(feed.root.textContent).toContain('valid line')
    feed.stop()
  })

  it('unknown event kinds are ignored without crashing', async () => {
    const lines = [
      feedLine(1, { kind: 'future-unknown-event', data: 'whatever' }),
      feedLine(2, { kind: 'assistant-text', text: 'after unknown' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(feed.root.textContent).toContain('after unknown')
    feed.stop()
  })

  it('unknown stream line types are ignored without crashing', async () => {
    const lines = [
      JSON.stringify({ type: 'future-type', payload: 'x' }),
      feedLine(1, { kind: 'assistant-text', text: 'ok' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(feed.root.textContent).toContain('ok')
    feed.stop()
  })
})

// ---------------------------------------------------------------------------
// Approval rows
// ---------------------------------------------------------------------------

describe('approvals', () => {
  it('approval row has tool name, detail, and Allow/Deny buttons', async () => {
    const lines = [JSON.stringify({ type: 'approval', id: 'a1', toolName: 'BashTool', detail: 'rm -rf /tmp' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const row = feed.root.querySelector('.session-approval')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('BashTool')
    expect(row?.textContent).toContain('rm -rf /tmp')
    expect(row?.querySelector('.session-approval-allow')).not.toBeNull()
    expect(row?.querySelector('.session-approval-deny')).not.toBeNull()
    feed.stop()
  })

  it('Allow button fires onDecide(id, true)', async () => {
    const lines = [JSON.stringify({ type: 'approval', id: 'app1', toolName: 'BashTool', detail: 'ls' })]
    const decided: Array<[string, boolean]> = []
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    feed.onDecide = (id, allow) => decided.push([id, allow])
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const allowBtn = feed.root.querySelector('.session-approval-allow') as HTMLButtonElement
    allowBtn.click()
    expect(decided).toEqual([['app1', true]])
    feed.stop()
  })

  it('Deny button fires onDecide(id, false)', async () => {
    const lines = [JSON.stringify({ type: 'approval', id: 'app2', toolName: 'BashTool', detail: 'cat /etc/passwd' })]
    const decided: Array<[string, boolean]> = []
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    feed.onDecide = (id, allow) => decided.push([id, allow])
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const denyBtn = feed.root.querySelector('.session-approval-deny') as HTMLButtonElement
    denyBtn.click()
    expect(decided).toEqual([['app2', false]])
    feed.stop()
  })

  it('approval-resolved collapses the row to a resolution line', async () => {
    const lines = [
      JSON.stringify({ type: 'approval', id: 'a1', toolName: 'BashTool', detail: 'ls' }),
      JSON.stringify({ type: 'approval-resolved', id: 'a1', allow: true }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const row = feed.root.querySelector('.session-approval')
    expect(row?.textContent).toBe('Allowed')
    // buttons should be gone
    expect(row?.querySelector('.session-approval-allow')).toBeNull()
    expect(row?.querySelector('.session-approval-deny')).toBeNull()
    feed.stop()
  })

  it('deny resolution shows Denied text', async () => {
    const lines = [
      JSON.stringify({ type: 'approval', id: 'a2', toolName: 'Bash', detail: 'x' }),
      JSON.stringify({ type: 'approval-resolved', id: 'a2', allow: false }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const row = feed.root.querySelector('.session-approval')
    expect(row?.textContent).toBe('Denied')
    feed.stop()
  })

  it('a replayed approval (same id delivered twice) renders exactly one row, still collapsible', async () => {
    // Approval lines carry no seq, so the server re-emits pending approvals on EVERY
    // reconnect — a duplicate id must not append a second (ghost) row.
    const lines = [
      JSON.stringify({ type: 'approval', id: 'dup1', toolName: 'BashTool', detail: 'ls' }),
      JSON.stringify({ type: 'approval', id: 'dup1', toolName: 'BashTool', detail: 'ls' }),
      JSON.stringify({ type: 'approval-resolved', id: 'dup1', allow: true }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const rows = feed.root.querySelectorAll('.session-approval')
    expect(rows.length).toBe(1)
    // The one row must be the tracked one — approval-resolved collapses it
    expect(rows[0].textContent).toBe('Allowed')
    expect(rows[0].querySelector('.session-approval-allow')).toBeNull()
    feed.stop()
  })

  it('approval-resolved for unknown id is a no-op (no crash)', async () => {
    const lines = [JSON.stringify({ type: 'approval-resolved', id: 'ghost', allow: true })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    expect(() => feed.start()).not.toThrow()
    await flush()
    feed.stop()
  })
})

// ---------------------------------------------------------------------------
// stop() idle-zero — no timers or fetches survive stop()
// ---------------------------------------------------------------------------

describe('stop() idle-zero', () => {
  it('stop() aborts an in-flight fetch', () => {
    const aborted: boolean[] = []
    const feed = new SessionFeed({ fetchFn: hangingFetch(() => aborted.push(true)) })
    feed.start()
    feed.stop()
    expect(aborted).toEqual([true])
  })

  it('stop() clears a pending reconnect timer', async () => {
    // Stream closes immediately → scheduleReconnect fires setTimeout
    const feed = new SessionFeed({ fetchFn: makeFetchFn([]) })
    feed.start()
    await flush()
    // At this point a reconnect timer is pending (backoff 1000ms)
    expect(vi.getTimerCount()).toBe(1)
    feed.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop() before start() is a no-op', () => {
    const feed = new SessionFeed()
    expect(() => feed.stop()).not.toThrow()
  })

  it('start() during the reconnect-backoff window clears the parked timer (no leak)', async () => {
    // Stream closes immediately → a reconnect timer parks. A start() in that window
    // opens a fresh connection and must clear the parked timer, or it outlives stop().
    let calls = 0
    const fetchFn: typeof fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      calls++
      if (calls === 1) return Promise.resolve(new Response(makeBody([]), { status: 200 }))
      return new Promise<Response>(() => {
        void (init as RequestInit | undefined)?.signal
      })
    }) as typeof fetch
    const feed = new SessionFeed({ fetchFn })
    feed.start()
    await flush()
    expect(vi.getTimerCount()).toBe(1) // reconnect timer parked
    feed.start() // re-entry during backoff — must clear the parked timer
    expect(vi.getTimerCount()).toBe(0)
    feed.stop()
    expect(vi.getTimerCount()).toBe(0) // nothing survives stop()
  })

  it('double start() is idempotent — does not open a second fetch', async () => {
    let callCount = 0
    const fetchFn: typeof fetch = hangingFetch(() => { callCount++ })
    const feed = new SessionFeed({ fetchFn })
    feed.start()
    feed.start() // second call must be a no-op
    expect(callCount).toBe(0) // no aborts yet — just checking only one fetch was opened
    // stop() to clean up
    feed.stop()
    expect(callCount).toBe(1) // only one fetch was aborted
  })
})

// ---------------------------------------------------------------------------
// Reconnect behavior
// ---------------------------------------------------------------------------

describe('reconnect', () => {
  it('reconnects with since=<lastSeq> after stream closes', async () => {
    const urls: string[] = []
    let call = 0
    const fetchFn: typeof fetch = ((_url: RequestInfo | URL, _init?: RequestInit) => {
      urls.push(_url.toString())
      call++
      if (call === 1) {
        return Promise.resolve(
          new Response(makeBody([feedLine(7, { kind: 'assistant-text', text: 'hi' })]), { status: 200 }),
        )
      }
      return new Promise(() => {}) // hang subsequent calls
    }) as typeof fetch

    const feed = new SessionFeed({ fetchFn })
    feed.start()
    await flush()
    // Advance past the 1s initial backoff to trigger reconnect
    vi.advanceTimersByTime(1000)
    await flush()
    expect(urls.length).toBeGreaterThanOrEqual(2)
    expect(urls[1]).toContain('since=7')
    feed.stop()
  })

  it('404 parks quietly at cap backoff (no error row rendered)', async () => {
    const feed = new SessionFeed({ fetchFn: makeFetchFn([], 404) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    // No error row — 404 is silent
    expect(feed.root.querySelectorAll('.session-error-row').length).toBe(0)
    // Timer is at cap (30s), not the 1s initial
    expect(vi.getTimerCount()).toBe(1)
    // Advance by 29s — still pending (cap is 30s)
    vi.advanceTimersByTime(29_000)
    feed.stop()
  })

  it('resets backoff to 1s on a successful line', async () => {
    const urls: string[] = []
    let call = 0
    const fetchFn: typeof fetch = ((_url: RequestInfo | URL, _init?: RequestInit) => {
      urls.push(_url.toString())
      call++
      if (call === 1) {
        // return a line → backoff resets to 1s
        return Promise.resolve(
          new Response(makeBody([feedLine(1, { kind: 'assistant-text', text: 'hi' })]), { status: 200 }),
        )
      }
      return new Promise(() => {})
    }) as typeof fetch

    const feed = new SessionFeed({ fetchFn })
    feed.start()
    await flush()
    // If backoff reset, reconnect fires at 1s
    vi.advanceTimersByTime(1000)
    await flush()
    expect(urls.length).toBe(2)
    feed.stop()
  })
})

// ---------------------------------------------------------------------------
// Chat rendering (Task 5): bubbles, delta streaming, diff disclosures, config rows
// ---------------------------------------------------------------------------

describe('chat bubbles', () => {
  it('user-text renders a user bubble, with a ref line when an element is attached', async () => {
    const lines = [
      feedLine(1, {
        kind: 'user-text',
        text: 'Make this bigger',
        element: { source: 'src/App.tsx:12:3', tag: 'div' },
      }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubble = feed.root.querySelector('.chat-msg.chat-user')
    expect(bubble).not.toBeNull()
    expect(bubble?.textContent).toContain('Make this bigger')
    const ref = bubble?.querySelector('.chat-msg-ref')
    expect(ref).not.toBeNull()
    expect(ref?.textContent).toContain('src/App.tsx:12:3')
    feed.stop()
  })

  it('user-text without an element renders no ref line', async () => {
    const lines = [feedLine(1, { kind: 'user-text', text: 'plain message' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubble = feed.root.querySelector('.chat-msg.chat-user')
    expect(bubble?.textContent).toBe('plain message')
    expect(bubble?.querySelector('.chat-msg-ref')).toBeNull()
    feed.stop()
  })
})

describe('delta streaming', () => {
  it('deltas accumulate in one streaming bubble', async () => {
    const lines = [feedLine(0, { kind: 'assistant-delta', text: 'Hel' }), feedLine(0, { kind: 'assistant-delta', text: 'lo' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubbles = feed.root.querySelectorAll('.chat-msg.chat-assistant.chat-streaming')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].textContent).toBe('Hello')
    feed.stop()
  })

  it('final assistant-text replaces the streaming bubble (no duplicate)', async () => {
    const lines = [
      feedLine(0, { kind: 'assistant-delta', text: 'Wor' }),
      feedLine(0, { kind: 'assistant-delta', text: 'king...' }),
      feedLine(1, { kind: 'assistant-text', text: 'Working on it now.' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubbles = feed.root.querySelectorAll('.chat-msg.chat-assistant')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].textContent).toBe('Working on it now.')
    expect(bubbles[0].className).not.toContain('chat-streaming')
    feed.stop()
  })

  it('reconnect mid-stream (no deltas) still renders the final text as a fresh bubble', async () => {
    const lines = [feedLine(1, { kind: 'assistant-text', text: 'Reconnected, here is the answer.' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubbles = feed.root.querySelectorAll('.chat-msg.chat-assistant')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].textContent).toBe('Reconnected, here is the answer.')
    feed.stop()
  })

  it('seq-0 delta lines do not advance the reconnect cursor (next connect uses prior since)', async () => {
    // The ring never stores deltas — parseLine's seq-tracking already ignores seq 0
    // (`seq > this.lastSeq` is false at seq 0), so a burst of ephemeral deltas between
    // real feed events must not move ?since= past the last real seq on reconnect.
    const urls: string[] = []
    let call = 0
    const fetchFn: typeof fetch = ((_url: RequestInfo | URL, _init?: RequestInit) => {
      urls.push(_url.toString())
      call++
      if (call === 1) {
        return Promise.resolve(
          new Response(
            makeBody([
              feedLine(5, { kind: 'assistant-text', text: 'hi' }),
              feedLine(0, { kind: 'assistant-delta', text: ' there' }),
            ]),
            { status: 200 },
          ),
        )
      }
      return new Promise(() => {})
    }) as typeof fetch

    const feed = new SessionFeed({ fetchFn })
    feed.start()
    await flush()
    vi.advanceTimersByTime(1000)
    await flush()
    expect(urls[1]).toContain('since=5')
    feed.stop()
  })

  // Final-review fix 5: stale streaming bubble hygiene — turn-complete/session-error/ended
  // must null out streamingBubble/streamingText, or the NEXT turn's deltas silently append to
  // a bubble that belongs to a turn that already ended (in-band error, no final assistant-text
  // ever arrived to clear it via finalizeAssistantText's own path).
  it('error turn mid-stream: next turn\'s deltas start a FRESH bubble', async () => {
    const lines = [
      feedLine(0, { kind: 'assistant-delta', text: 'Old turn...' }),
      feedLine(1, { kind: 'turn-complete', isError: true, errorText: 'boom' }),
      feedLine(0, { kind: 'assistant-delta', text: 'New' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubbles = feed.root.querySelectorAll('.chat-msg.chat-assistant.chat-streaming')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].textContent).toBe('New') // not 'Old turn...New' — a fresh bubble, not a stale append
    feed.stop()
  })

  it('session-error mid-stream also starts a fresh bubble on the next turn', async () => {
    const lines = [
      feedLine(0, { kind: 'assistant-delta', text: 'Stalled...' }),
      feedLine(1, { kind: 'session-error', text: 'spawn failed' }),
      feedLine(0, { kind: 'assistant-delta', text: 'Recovered' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubbles = feed.root.querySelectorAll('.chat-msg.chat-assistant.chat-streaming')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].textContent).toBe('Recovered')
    feed.stop()
  })

  it('ended mid-stream also starts a fresh bubble on reconnect', async () => {
    const lines = [
      feedLine(0, { kind: 'assistant-delta', text: 'Mid...' }),
      feedLine(1, { kind: 'ended' }),
      feedLine(0, { kind: 'assistant-delta', text: 'Fresh' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const bubbles = feed.root.querySelectorAll('.chat-msg.chat-assistant.chat-streaming')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].textContent).toBe('Fresh')
    feed.stop()
  })

  it('evicted streaming bubble does not swallow the final text', async () => {
    // Seed one row, then start a stream (creates the bubble as row #2), then push enough
    // additional rows to push the streaming bubble itself out via the MAX_ROWS(200) cap
    // before the turn ever finalizes — the eventual final assistant-text must render as a
    // fresh, VISIBLE bubble rather than writing into an already-evicted (detached) node.
    const lines: string[] = [feedLine(1, { kind: 'user-text', text: 'seed' }), feedLine(0, { kind: 'assistant-delta', text: 'streaming...' })]
    for (let i = 2; i <= 201; i++) {
      lines.push(feedLine(i, { kind: 'user-text', text: `filler ${i}` }))
    }
    lines.push(feedLine(300, { kind: 'assistant-text', text: 'FINAL ANSWER' }))
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush(400)
    const bubbles = feed.root.querySelectorAll('.chat-msg.chat-assistant')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].textContent).toBe('FINAL ANSWER')
    expect(feed.root.textContent).toContain('FINAL ANSWER')
    feed.stop()
  })
})

describe('diff disclosure', () => {
  it('tool-started with an edit payload renders a collapsed diff disclosure', async () => {
    const lines = [
      feedLine(1, {
        kind: 'tool-started',
        toolId: 't1',
        name: 'Edit',
        detail: 'src/App.tsx',
        edit: { file: 'src/App.tsx', before: 'py-2.5', after: 'py-6' },
      }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const details = feed.root.querySelector('.session-diff') as HTMLDetailsElement | null
    expect(details).not.toBeNull()
    expect(details?.tagName).toBe('DETAILS')
    expect(details?.open).toBe(false) // collapsed by default
    expect(details?.querySelector('summary')?.textContent).toBe('App.tsx')
    expect(details?.querySelector('.diff-before')?.textContent).toBe('py-2.5')
    expect(details?.querySelector('.diff-after')?.textContent).toBe('py-6')
    feed.stop()
  })

  it('tool-started without an edit payload renders no diff disclosure', async () => {
    const lines = [feedLine(1, { kind: 'tool-started', toolId: 't1', name: 'Read', detail: 'x.ts' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(feed.root.querySelector('.session-diff')).toBeNull()
    feed.stop()
  })
})

describe('config-changed row', () => {
  it('renders a config row joining only the provided keys', async () => {
    const lines = [feedLine(1, { kind: 'config-changed', model: 'claude-opus-4-5', permissionMode: 'plan' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const row = feed.root.querySelector('.session-row.session-config')
    expect(row).not.toBeNull()
    expect(row?.textContent).toBe('model → claude-opus-4-5 · permissions → plan')
    feed.stop()
  })

  it('renders just effort when only effort is provided', async () => {
    const lines = [feedLine(1, { kind: 'config-changed', effort: 'high' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(feed.root.querySelector('.session-row.session-config')?.textContent).toBe('effort → high')
    feed.stop()
  })
})

// ---------------------------------------------------------------------------
// Row cap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Chat input cluster, element chip, config bar pickers (Task 6)
// ---------------------------------------------------------------------------

describe('chat input cluster', () => {
  // Composer consolidation (Task 1) decoupled the send GESTURE from onSay: trySend no longer
  // reads currentChip or awaits/clears anything itself — it just guards and fires onSend
  // (fire-and-forget). A host's onSend implementation is what reads getText()/getChip() and
  // decides what sending means (Task 3 wires the real one); these tests prove the feed's own
  // gesture-to-onSend wiring, not any particular onSend behavior.
  it('send fires onSend (not onSay) once text is non-empty — the feed no longer decides what sending means', () => {
    const sent: number[] = []
    const said: unknown[] = []
    const feed = new SessionFeed()
    feed.onSend = () => sent.push(1)
    feed.onSay = (text, element) => { said.push([text, element]) }
    document.body.appendChild(feed.root)

    feed.setChip({ source: 'src/App.tsx:12:3', tag: 'div', label: 'div · App.tsx:12' })
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = '  make it bigger  '
    const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement
    sendBtn.click()

    expect(sent).toEqual([1])
    expect(said).toEqual([]) // onSay is no longer invoked directly by the feed's own gesture
    // Text/chip are no longer cleared by the feed itself — that's the host onSend
    // implementation's job now, via getText()/clearText()/getChip()/setChip(null).
    expect(textarea.value).toBe('  make it bigger  ')
    expect((feed.root.querySelector('.chat-chip') as HTMLElement).hidden).toBe(false)
  })

  it('textarea has maxLength 4000 (mirrors CHAT_TEXT_MAX server cap)', () => {
    const feed = new SessionFeed()
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    expect(textarea.maxLength).toBe(4000)
  })

  it('Cmd-Enter fires onSend, not onSay', () => {
    const sent: number[] = []
    const said: string[] = []
    const feed = new SessionFeed()
    feed.onSend = () => sent.push(1)
    feed.onSay = (text) => { said.push(text) }
    document.body.appendChild(feed.root)
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'hello'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    expect(sent).toEqual([1])
    expect(said).toEqual([])
  })

  it('Ctrl-Enter also fires onSend', () => {
    const sent: number[] = []
    const feed = new SessionFeed()
    feed.onSend = () => sent.push(1)
    document.body.appendChild(feed.root)
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'hello'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(sent).toEqual([1])
  })

  it('plain Enter (no modifier) does not send', () => {
    const sent: number[] = []
    const feed = new SessionFeed()
    feed.onSend = () => sent.push(1)
    document.body.appendChild(feed.root)
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'hello'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(sent).toEqual([])
  })

  it('empty (or whitespace-only) text never fires onSend', () => {
    const sent: number[] = []
    const feed = new SessionFeed()
    feed.onSend = () => sent.push(1)
    document.body.appendChild(feed.root)
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement
    textarea.value = '   '
    sendBtn.click()
    expect(sent).toEqual([])
  })

  it('getChip() returns null with no chip attached, and {source, tag} once one is', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    expect(feed.getChip()).toBeNull()
    feed.setChip({ source: 'src/x.tsx:1:1', tag: 'div', label: 'div · x.tsx:1' })
    expect(feed.getChip()).toEqual({ source: 'src/x.tsx:1:1', tag: 'div' })
  })

  it('chip renders label and × clears it', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setChip({ source: 'src/x.tsx:1:1', tag: 'div', label: 'div · x.tsx:1' })
    const chip = feed.root.querySelector('.chat-chip') as HTMLElement
    expect(chip.hidden).toBe(false)
    expect(chip.textContent).toContain('div · x.tsx:1')
    const clearBtn = chip.querySelector('.chat-chip-clear') as HTMLButtonElement
    expect(clearBtn).not.toBeNull()
    clearBtn.click()
    expect(chip.hidden).toBe(true)
  })

  it('setChip(null) hides the chip directly', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setChip({ source: 'x:1:1', tag: 'div', label: 'div · x:1' })
    feed.setChip(null)
    expect((feed.root.querySelector('.chat-chip') as HTMLElement).hidden).toBe(true)
  })

  it('setAvailability disables input with reason and unhides the feed root', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    expect(feed.root.hidden).toBe(true)

    feed.setAvailability({ enabled: false, reason: 'Embedded sessions are disabled in config' })
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    const sendBtn = feed.root.querySelector('.chat-send') as HTMLButtonElement
    const reason = feed.root.querySelector('.chat-disabled-reason') as HTMLElement
    expect(textarea.disabled).toBe(true)
    expect(sendBtn.disabled).toBe(true)
    expect(reason.hidden).toBe(false)
    expect(reason.textContent).toBe('Embedded sessions are disabled in config')
    expect(feed.root.hidden).toBe(false)

    feed.setAvailability({ enabled: true })
    expect(textarea.disabled).toBe(false)
    expect(sendBtn.disabled).toBe(false)
    expect(reason.hidden).toBe(true)
  })

  it('disabled input never fires onSend even if trySend is somehow reached', () => {
    const sent: number[] = []
    const feed = new SessionFeed()
    feed.onSend = () => sent.push(1)
    document.body.appendChild(feed.root)
    feed.setAvailability({ enabled: false, reason: 'nope' })
    const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'hello'
    ;(feed.root.querySelector('.chat-send') as HTMLButtonElement).click()
    expect(sent).toEqual([])
  })

  // Final-review fix C1: availability (embedded:false) must gate the CHAT leg only — drafts
  // ride the queue/watcher path that opt-out deliberately preserves, so a terminal-only
  // consumer with drafted edits must still have a working send surface.
  describe('drafts-only send survives availability:false (final-review fix C1)', () => {
    it('sendBtn stays enabled when availability is disabled but drafts are present', () => {
      const feed = new SessionFeed()
      document.body.appendChild(feed.root)
      const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement
      const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement

      feed.setAvailability({ enabled: false, reason: 'Embedded sessions are disabled in config' })
      feed.setDraftState({ count: 2, applying: false })

      expect(textarea.disabled).toBe(true) // the textarea itself stays disabled — only chat is gated
      expect(sendBtn.disabled).toBe(false) // but the send surface stays usable for drafts
    })

    it('sendBtn re-disables once draftCount drops back to 0 while availability is still false', () => {
      const feed = new SessionFeed()
      document.body.appendChild(feed.root)
      const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement

      feed.setAvailability({ enabled: false, reason: 'nope' })
      feed.setDraftState({ count: 1, applying: false })
      expect(sendBtn.disabled).toBe(false)

      feed.setDraftState({ count: 0, applying: false })
      expect(sendBtn.disabled).toBe(true)
    })

    it('order-independence: setDraftState before setAvailability still lands on sendBtn enabled', () => {
      const feed = new SessionFeed()
      document.body.appendChild(feed.root)
      const sendBtn = feed.root.querySelector('.composer-send') as HTMLButtonElement

      feed.setDraftState({ count: 3, applying: false })
      feed.setAvailability({ enabled: false, reason: 'nope' })
      expect(sendBtn.disabled).toBe(false)
    })

    it('a disabled textarea with drafts present still fires onSend on click (drafts-only send)', () => {
      const sent: number[] = []
      const feed = new SessionFeed()
      feed.onSend = () => sent.push(1)
      document.body.appendChild(feed.root)

      feed.setAvailability({ enabled: false, reason: 'nope' })
      feed.setDraftState({ count: 1, applying: false })
      const textarea = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
      expect(textarea.disabled).toBe(true)

      ;(feed.root.querySelector('.composer-send') as HTMLButtonElement).click()
      expect(sent).toEqual([1])
    })
  })

  it('renderTransientError renders a session-error-row', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.renderTransientError('chat queue full — wait for the current turn')
    const row = feed.root.querySelector('.session-error-row')
    expect(row).not.toBeNull()
    expect(row?.textContent).toBe('chat queue full — wait for the current turn')
  })
})

describe('config bar pickers', () => {
  it('model select seeds from a started event: current model selected, plus the CLI aliases', async () => {
    const feed = new SessionFeed({
      fetchFn: makeFetchFn([feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true })]),
    })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const modelSelect = feed.root.querySelector('select.session-model') as HTMLSelectElement
    expect(modelSelect).not.toBeNull()
    expect(modelSelect.value).toBe('claude-opus-4-5')
    const values = [...modelSelect.options].map((o) => o.value)
    expect(values).toEqual(['claude-opus-4-5', 'sonnet', 'opus', 'haiku'])
    feed.stop()
  })

  it('model select dedupes when the started model IS one of the aliases', async () => {
    const feed = new SessionFeed({
      fetchFn: makeFetchFn([feedLine(1, { kind: 'started', sessionId: 's1', model: 'opus', mcpLoaded: true })]),
    })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const modelSelect = feed.root.querySelector('select.session-model') as HTMLSelectElement
    expect(modelSelect.value).toBe('opus')
    const values = [...modelSelect.options].map((o) => o.value)
    expect(values).toEqual(['opus', 'sonnet', 'haiku'])
    feed.stop()
  })

  it('model select shows only a placeholder before any started/config-changed event', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    const modelSelect = feed.root.querySelector('select.session-model') as HTMLSelectElement
    expect(modelSelect).not.toBeNull()
    expect(modelSelect.value).toBe('')
    const options = [...modelSelect.options]
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toBe('model…')
  })

  it('config-changed {model} updates the model select value (rebuilding options around it)', async () => {
    const lines = [
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, { kind: 'config-changed', model: 'claude-sonnet-4-5' }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const modelSelect = feed.root.querySelector('select.session-model') as HTMLSelectElement
    expect(modelSelect.value).toBe('claude-sonnet-4-5')
    const values = [...modelSelect.options].map((o) => o.value)
    expect(values).toEqual(['claude-sonnet-4-5', 'sonnet', 'opus', 'haiku'])
    feed.stop()
  })

  it('seeding the model select never fires onConfig (no echo loop)', async () => {
    const fired: Array<Record<string, string>> = []
    const feed = new SessionFeed({
      fetchFn: makeFetchFn([feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true })]),
    })
    feed.onConfig = (cfg) => fired.push(cfg)
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    expect(fired).toEqual([])
    feed.stop()
  })

  it('changing the model select fires onConfig with only model', async () => {
    const fired: Array<Record<string, string>> = []
    const feed = new SessionFeed({
      fetchFn: makeFetchFn([feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true })]),
    })
    feed.onConfig = (cfg) => fired.push(cfg)
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const modelSelect = feed.root.querySelector('select.session-model') as HTMLSelectElement
    modelSelect.value = 'sonnet'
    modelSelect.dispatchEvent(new Event('change'))
    expect(fired).toEqual([{ model: 'sonnet' }])
    feed.stop()
  })

  it('effort/permission selects seed from config-changed and stay silent (no onConfig fired)', async () => {
    const lines = [feedLine(1, { kind: 'config-changed', effort: 'high', permissionMode: 'plan' })]
    const fired: Array<Record<string, string>> = []
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    feed.onConfig = (cfg) => fired.push(cfg)
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const effortSelect = feed.root.querySelector('.session-effort') as HTMLSelectElement
    const permSelect = feed.root.querySelector('.session-permission') as HTMLSelectElement
    expect(effortSelect.value).toBe('high')
    expect(permSelect.value).toBe('plan')
    expect(fired).toEqual([])
    feed.stop()
  })

  it('partial config-changed (only effort) leaves the permission picker on its placeholder', async () => {
    const lines = [feedLine(1, { kind: 'config-changed', effort: 'low' })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const permSelect = feed.root.querySelector('.session-permission') as HTMLSelectElement
    expect(permSelect.value).toBe('')
    feed.stop()
  })

  it('changing the effort select fires onConfig with only effort', () => {
    const fired: Array<Record<string, string>> = []
    const feed = new SessionFeed()
    feed.onConfig = (cfg) => fired.push(cfg)
    document.body.appendChild(feed.root)
    const effortSelect = feed.root.querySelector('.session-effort') as HTMLSelectElement
    effortSelect.value = 'xhigh'
    effortSelect.dispatchEvent(new Event('change'))
    expect(fired).toEqual([{ effort: 'xhigh' }])
  })

  // Final-review fix 2 (client): the manager now re-applies model/permissionMode server-side
  // on every respawn's `started` event — the picker must agree with that reality rather than
  // relying on DOM inertia. `started` re-seeds ONLY the model select from the event (as
  // before); effort/permission are explicitly reset to their last-user-chosen values.
  it('started after config-changed keeps effort/permission picker selections consistent', async () => {
    const lines = [
      feedLine(1, { kind: 'config-changed', effort: 'high', permissionMode: 'plan' }),
      // A respawn's started event carries no effort/permissionMode field.
      feedLine(2, { kind: 'started', sessionId: 's2', model: 'claude-opus-4-5', mcpLoaded: true }),
    ]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const effortSelect = feed.root.querySelector('.session-effort') as HTMLSelectElement
    const permSelect = feed.root.querySelector('.session-permission') as HTMLSelectElement
    expect(effortSelect.value).toBe('high')
    expect(permSelect.value).toBe('plan')
    // Model still seeds from the started event itself, unaffected by the remembered values.
    const modelSelect = feed.root.querySelector('select.session-model') as HTMLSelectElement
    expect(modelSelect.value).toBe('claude-opus-4-5')
    feed.stop()
  })

  it('a started event before any config-changed leaves effort/permission on the placeholder', async () => {
    const lines = [feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })]
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush()
    const effortSelect = feed.root.querySelector('.session-effort') as HTMLSelectElement
    const permSelect = feed.root.querySelector('.session-permission') as HTMLSelectElement
    expect(effortSelect.value).toBe('')
    expect(permSelect.value).toBe('')
    feed.stop()
  })

  it('changing the permission select fires onConfig with only permissionMode', () => {
    const fired: Array<Record<string, string>> = []
    const feed = new SessionFeed()
    feed.onConfig = (cfg) => fired.push(cfg)
    document.body.appendChild(feed.root)
    const permSelect = feed.root.querySelector('.session-permission') as HTMLSelectElement
    permSelect.value = 'plan'
    permSelect.dispatchEvent(new Event('change'))
    expect(fired).toEqual([{ permissionMode: 'plan' }])
  })
})

describe('row cap', () => {
  it('caps rendered rows at 200, dropping oldest', async () => {
    const lines: string[] = []
    for (let i = 1; i <= 205; i++) {
      lines.push(feedLine(i, { kind: 'assistant-text', text: `line ${i}` }))
    }
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    document.body.appendChild(feed.root)
    feed.start()
    await flush(200) // more rounds for 205 lines
    // Query non-status rows via DOM (not textContent substring — "line 1" matches "line 10" etc.)
    const rows = [...feed.root.querySelectorAll('.session-row:not(.session-status)')]
    expect(rows.length).toBeLessThanOrEqual(200)
    // First 5 rows (line 1–5) were dropped; first remaining is line 6
    expect(rows[0]?.textContent).toBe('line 6')
    // Last row is the newest
    expect(rows[rows.length - 1]?.textContent).toBe('line 205')
    feed.stop()
  })
})

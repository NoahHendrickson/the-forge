import type { Meta, StoryObj } from '@storybook/html-vite'
import { SessionFeed } from '../src/client/session-feed'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'SessionFeed',
}
export default meta

type Story = StoryObj

const encoder = new TextEncoder()

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

/** Builds a SessionFeed with a scripted event script, wired the same way index.ts wires it —
 * returns both the instance (so a story can drive setChip/setAvailability post-construction)
 * and the mounted shadow host. */
function makeFeedInstance(lines: string[]): { feed: SessionFeed; host: HTMLElement } {
  const fetchFn: typeof fetch = ((_url: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(makeBody(lines), {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
    )) as typeof fetch

  const feed = new SessionFeed({ fetchFn })
  feed.onInterrupt = () => alert('Stop requested')
  feed.onDecide = (id, allow) => alert(`Decision: ${id} → ${allow ? 'Allow' : 'Deny'}`)
  feed.onSay = (text, element) => alert(`Say: "${text}"${element ? ` (${element.tag} · ${element.source})` : ''}`)
  // composer-send/Cmd-Enter now fire onSend (composer consolidation Task 1) — this story wires
  // the same read-text/read-chip/call-onSay/clear-on-success shape as index.ts's shim so the
  // catalog's Send control stays functional (Task 3 will replace both with the real verb).
  feed.onSend = () => {
    const text = feed.getText()
    const chip = feed.getChip()
    Promise.resolve(feed.onSay(text, chip ?? undefined)).then((ok) => {
      if (ok) {
        feed.clearText()
        feed.setChip(null)
      }
    })
  }
  feed.onConfig = (cfg) => alert(`Config: ${JSON.stringify(cfg)}`)
  feed.start()
  return { feed, host: mountInShadow(feed.root, 'panel') }
}

/** Creates a SessionFeed with a scripted event script and mounts it. */
function makeFeed(lines: string[]): HTMLElement {
  return makeFeedInstance(lines).host
}

/** Working state — session running, a few tool calls completed. */
export const Working: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, { kind: 'tool-started', toolId: 't1', name: 'Read', detail: 'src/App.tsx' }),
      feedLine(3, { kind: 'tool-finished', toolId: 't1' }),
      feedLine(4, { kind: 'tool-started', toolId: 't2', name: 'Edit', detail: 'src/App.tsx:12' }),
      feedLine(5, { kind: 'tool-finished', toolId: 't2' }),
      feedLine(6, { kind: 'assistant-text', text: 'I updated the padding to use `py-6` as requested.' }),
      feedLine(7, { kind: 'turn-complete', isError: false, costUsd: 0.0032 }),
    ]),
}

/** Approval-pending state — tool approval row with Allow / Deny buttons. */
export const ApprovalPending: Story = {
  render: () => {
    const lines = [
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, { kind: 'tool-started', toolId: 't1', name: 'BashTool', detail: 'npm run build' }),
      JSON.stringify({ type: 'approval', id: 'appr1', toolName: 'BashTool', detail: 'npm run build' }),
    ]
    return makeFeed(lines)
  },
}

/** Limit-hit / error state — turn-complete with isError, showing the error text. */
export const LimitHit: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, { kind: 'assistant-text', text: 'Analyzing the change request…' }),
      feedLine(3, {
        kind: 'turn-complete',
        isError: true,
        errorText: 'API rate limit exceeded. Please wait a moment before retrying.',
      }),
    ]),
}

/** Session error — spawn failure or protocol error. */
export const SessionError: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'session-error', text: 'Could not spawn claude: command not found in PATH' }),
    ]),
}

/** Streaming mid-delta — a user bubble with an element ref, followed by an in-progress
 * .chat-streaming assistant bubble built from several assistant-delta events (seq 0). */
export const StreamingMidDelta: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, {
        kind: 'user-text',
        text: 'Make this button bigger',
        element: { source: 'src/App.tsx:42:5', tag: 'button' },
      }),
      feedLine(0, { kind: 'assistant-delta', text: "I'll bump the padding " }),
      feedLine(0, { kind: 'assistant-delta', text: 'from py-2.5 to py-6 ' }),
      feedLine(0, { kind: 'assistant-delta', text: 'on that button now.' }),
    ]),
}

/** Finalized conversation — user bubble, then a completed assistant bubble (the streaming
 * bubble was replaced in place by the final assistant-text, no duplicate). */
export const FinalizedConversation: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, { kind: 'user-text', text: 'Make this button bigger' }),
      feedLine(0, { kind: 'assistant-delta', text: "I'll bump the padding" }),
      feedLine(3, { kind: 'assistant-text', text: "I'll bump the padding from py-2.5 to py-6 on that button now." }),
      feedLine(4, { kind: 'turn-complete', isError: false, costUsd: 0.0021 }),
    ]),
}

/** Diff-open — a tool-started edit with before/after; the story leaves the <details> collapsed
 * (matching the real default) so the spot-check confirms the summary/basename rendering. */
export const DiffDisclosure: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, {
        kind: 'tool-started',
        toolId: 't1',
        name: 'Edit',
        detail: 'src/App.tsx',
        edit: { file: 'src/App.tsx', before: '  <button className="px-4 py-2.5">', after: '  <button className="px-4 py-6">' },
      }),
      feedLine(3, { kind: 'tool-finished', toolId: 't1' }),
    ]),
}

/** Config row — a config-changed event showing model/permissions/effort joined into one line. */
export const ConfigChanged: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, { kind: 'config-changed', model: 'claude-opus-4-5', permissionMode: 'plan', effort: 'high' }),
    ]),
}

// ---------------------------------------------------------------------------
// Chat input cluster, element chip, config bar pickers (Task 6)
// ---------------------------------------------------------------------------

/** Chat input cluster with no chip attached — the config bar's effort/permission pickers
 * sit on their placeholder option until a started/config-changed event seeds them; the
 * model picker seeds from `started` (current model + the CLI aliases sonnet/opus/haiku). */
export const InputClusterIdle: Story = {
  render: () =>
    makeFeed([feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true })]),
}

/** Chat input cluster with an element chip attached — the state right after clicking the
 * panel's Prompt button on a selected element (index.ts's setChip + focusInput wiring). */
export const InputClusterWithChip: Story = {
  render: () => {
    const { feed, host } = makeFeedInstance([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
    ])
    feed.setChip({ source: 'src/App.tsx:42:5', tag: 'button', label: 'button · App.tsx:42' })
    return host
  },
}

/** Config bar seeded from config-changed (model, effort=high, permissionMode=plan) — all
 * three pickers reflect the current values instead of their 'model…'/'effort…'/
 * 'permissions…' placeholders; the model picker offers the current model + CLI aliases. */
export const ConfigBarSeeded: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, { kind: 'config-changed', model: 'claude-sonnet-4-5', effort: 'high', permissionMode: 'plan' }),
    ]),
}

/** Disabled input — setAvailability(false, reason), as index.ts drives it when the server's
 * /status reports sessionEnabled: false (DispatchConfig.embedded opted out). */
export const InputDisabled: Story = {
  render: () => {
    const { feed, host } = makeFeedInstance([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
    ])
    feed.setAvailability({ enabled: false, reason: 'Embedded sessions are disabled in config' })
    return host
  },
}

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

/** Creates a SessionFeed with a scripted event script and mounts it. */
function makeFeed(lines: string[]): HTMLElement {
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
  feed.start()
  return mountInShadow(feed.root, 'panel')
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

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

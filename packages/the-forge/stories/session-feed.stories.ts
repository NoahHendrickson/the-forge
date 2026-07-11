import type { Meta, StoryObj } from '@storybook/html-vite'
import { SessionFeed } from '../src/client/session-feed'
import { DraftStore } from '../src/client/drafts'
import { LifecycleSession } from '../src/client/lifecycle'
import { ChangeList } from '../src/client/changelist'
import type { TaggedElement } from '../src/client/source'
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
  // composer-send/Cmd-Enter fire onSend (composer consolidation Task 1); the real host
  // (index.ts) delegates this to ComposerSend#send (composer-send.ts), which owns the
  // read-text/read-chip/POST-/session/say/clear-on-success shape. This story just alerts
  // instead of POSTing, so the catalog's Send control stays functional without a live server.
  feed.onSend = () => {
    const text = feed.getText()
    const chip = feed.getChip()
    alert(`Say: "${text}"${chip ? ` (${chip.tag} · ${chip.source})` : ''}`)
    feed.clearText()
    feed.setChip(null)
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

/** Composer with Cursor selected (Task 5, C1) — HARNESS_VOCAB['cursor'] has empty
 * efforts/permissionModes, so setHarness hides both selects entirely; only the harness picker
 * itself and the model select (offering the session-reported model only — cursor has no
 * documented MODEL_ALIASES) remain in .composer-controls. */
export const ComposerHarnessCursor: Story = {
  render: () =>
    makeFeed([feedLine(1, { kind: 'config-changed', harness: 'cursor', model: 'gpt-5-high' })]),
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

// ---------------------------------------------------------------------------
// Unified chat composer states (composer consolidation Tasks 1–3)
// ---------------------------------------------------------------------------
// The composer's "ready" and "disabled-reason" states are already covered above by
// InputClusterIdle (idle placeholder, ↑ send glyph) and InputDisabled (setAvailability(false)).
// The three below add the states the consolidation introduced: the send↔stop morph, the drafts
// pill, and the drafts pill's disclosure hosting the (unmodified) Changes list.

/** Builds a TaggedElement stand-in for the drafts stories — a detached node carrying a
 * data-dc-source attr, the only thing DraftStore/ChangeList read off it. */
function taggedDiv(source: string, tag: string): TaggedElement {
  const el = document.createElement(tag)
  el.setAttribute('data-dc-source', source)
  return el as unknown as TaggedElement
}

/** Busy-morphed composer — a turn is in flight (started → tool-started, no turn-complete yet)
 * and the textarea is empty, so updateSendMorph() flips composer-send from ↑ to ■ (interrupt).
 * Typing into the textarea would flip it back to ↑ (a mid-turn message queues via the FIFO). */
export const ComposerBusyMorph: Story = {
  render: () =>
    makeFeed([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
      feedLine(2, { kind: 'assistant-text', text: 'On it — bumping the padding now.' }),
      feedLine(3, { kind: 'tool-started', toolId: 't1', name: 'Edit', detail: 'src/App.tsx:12' }),
      // No turn-complete: busyish stays true, so the send button renders ■.
    ]),
}

/** Drafts pill — setDraftState({ count: 2 }) surfaces the pill in the composer's chip row
 * ('2 edits drafted'); the disclosure stays closed (clicking the pill would open it — see
 * ComposerDraftDisclosureOpen). */
export const ComposerDraftsPill: Story = {
  render: () => {
    const { feed, host } = makeFeedInstance([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
    ])
    feed.setDraftState({ count: 2, applying: false })
    return host
  },
}

/** Drafts pill, applying — an in-flight send holds the pill on 'applying…' (setDraftState's
 * applying flag wins the label over the count). */
export const ComposerDraftsApplying: Story = {
  render: () => {
    const { feed, host } = makeFeedInstance([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
    ])
    feed.setDraftState({ count: 1, applying: true })
    return host
  },
}

/** Drafts pill with its disclosure open — the (unmodified) Changes list mounts inside
 * feed.draftSlot exactly as index.ts wires it (feed.draftSlot.appendChild(changeList.root)),
 * seeded with two drafted elements, and the pill's own click toggles the disclosure open so the
 * catalog shows the change rows above the chip/input/controls rows. */
export const ComposerDraftDisclosureOpen: Story = {
  render: () => {
    const { feed, host } = makeFeedInstance([
      feedLine(1, { kind: 'started', sessionId: 's1', model: 'claude-opus-4-5', mcpLoaded: true }),
    ])
    const drafts = new DraftStore()
    const session = new LifecycleSession()
    const changeList = new ChangeList(drafts, session, {
      onHover: () => {},
      onSelect: () => {},
      onResend: () => {},
    })
    const elA = taggedDiv('src/App.tsx:3:5', 'button')
    const elB = taggedDiv('src/App.tsx:12:7', 'div')
    drafts.apply(elA, 'padding-top', '24px')
    drafts.apply(elA, 'padding-bottom', '24px')
    drafts.apply(elB, 'background-color', 'rgb(37, 99, 235)')
    changeList.syncDrafts()
    feed.draftSlot.appendChild(changeList.root)
    feed.setDraftState({ count: 2, applying: false })
    // The pill's own click is the only opener — dispatch it so the story lands with the
    // disclosure already open (.draft-disclosure.open), matching a user tapping the pill.
    host.shadowRoot!.querySelector<HTMLButtonElement>('.draft-pill')!.click()
    return host
  },
}

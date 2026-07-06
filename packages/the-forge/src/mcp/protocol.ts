export interface QueueItemLike {
  id: string
  markdown: string
  createdAt: string
}

/** Outcome of one wait_for_design_edits cycle. A discriminated union, NOT free text from
 * the server: callTool maps each kind to a CONSTANT agent-facing instruction below, so
 * server response fields only ever SELECT between canned texts — they are never spliced
 * into the instructions the agent will follow. */
export type WaitOutcome =
  | { kind: 'items'; items: QueueItemLike[] }
  | { kind: 'empty' }
  | { kind: 'stop'; reason: 'idle' | 'replaced' | 'no-server' | 'unlinked' }
  | { kind: 'unreachable' }

export interface ForgeBackend {
  pull(): Promise<QueueItemLike[]>
  mark(ids: string[], status: string, note?: string): Promise<string[]>
  wait(): Promise<WaitOutcome>
}

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string }
}

const TOOLS = [
  {
    name: 'pull_design_edits',
    description:
      "Claim and return all pending design change requests from The Forge queue. Apply each request's markdown exactly, then call mark_applied.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mark_applied',
    description: 'Report the outcome of applying design change requests back to The Forge queue.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['applied', 'failed'] },
        note: { type: 'string' },
      },
      required: ['ids', 'status'],
    },
  },
  {
    name: 'wait_for_design_edits',
    description:
      'Long-poll The Forge for design change requests (the /forge-watch loop). Blocks until edits arrive or a short hold expires. Apply any returned edits, then follow the result text: call this tool again to keep watching, or stop when it says watching has ended.',
    inputSchema: { type: 'object', properties: {} },
  },
]

/** Canned wait-loop instruction texts — constants by the same rule as the dispatch
 * AppleScript scripts (see server/dispatch.ts): nothing dynamic is ever interpolated into
 * text the agent treats as instructions. The one templated value is the applied-items id
 * list, which mirrors pull_design_edits' existing reminder format. */
const WAIT_EMPTY_TEXT =
  'No design edits yet. Call wait_for_design_edits again now to keep watching. Do not add commentary between calls.'
const WAIT_STOP_TEXTS: Record<'idle' | 'replaced' | 'no-server' | 'unlinked', string> = {
  idle: 'Watching stopped — no design activity for a while. Tell the user: watching paused; run /forge-watch to resume. Do not call wait_for_design_edits again unless the user asks.',
  replaced:
    'Watching stopped — another session took over watching this project. Do not call wait_for_design_edits again unless the user asks.',
  'no-server':
    'No running dev server found. Tell the user to start their Vite dev server, then run /forge-watch again. Do not call wait_for_design_edits until then.',
  unlinked:
    'Watching stopped — the user unlinked this session from the design panel. Run /forge-watch to re-link if asked. Do not call wait_for_design_edits again unless the user asks.',
}
const WAIT_UNREACHABLE_TEXT =
  'The dev server did not respond. Wait a few seconds, then call wait_for_design_edits once more; if it fails again, stop watching and tell the user to run /forge-watch when the dev server is back.'

function textResult(text: string, isError?: boolean): { content: Array<{ type: 'text'; text: string }>; isError?: true } {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

/** Shared change-request rendering for pull_design_edits and the wait loop's items case —
 * one format, so the /forge-design and /forge-watch apply steps read identically. */
function renderItems(items: QueueItemLike[]): { body: string; ids: string } {
  const body = items
    .map((i) => `--- request ${i.id} (created ${i.createdAt}) ---\n${i.markdown}`)
    .join('\n\n')
  const ids = items.map((i) => i.id).join(', ')
  return { body, ids }
}

async function callTool(name: string, args: Record<string, unknown>, backend: ForgeBackend) {
  if (name === 'pull_design_edits') {
    const items = await backend.pull()
    if (items.length === 0) return textResult('No pending design edits.')
    const { body, ids } = renderItems(items)
    const reminder = `\n\nAfter applying these edits, call mark_applied with ids: ${ids}.`
    return textResult(body + reminder)
  }

  if (name === 'wait_for_design_edits') {
    const outcome = await backend.wait()
    if (outcome.kind === 'items') {
      const { body, ids } = renderItems(outcome.items)
      const reminder = `\n\nAfter applying these edits, call mark_applied with ids: ${ids}. Then call wait_for_design_edits again immediately to keep watching.`
      return textResult(body + reminder)
    }
    if (outcome.kind === 'stop') return textResult(WAIT_STOP_TEXTS[outcome.reason])
    if (outcome.kind === 'unreachable') return textResult(WAIT_UNREACHABLE_TEXT)
    return textResult(WAIT_EMPTY_TEXT)
  }

  if (name === 'mark_applied') {
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : []
    const status = typeof args.status === 'string' ? args.status : ''
    const note = typeof args.note === 'string' ? args.note : undefined
    const marked = await backend.mark(ids, status, note)
    return textResult(`Marked ${marked.length} request(s) as ${status}.`)
  }

  return textResult(`Unknown tool: ${name}`, true)
}

export async function handleMessage(msg: JsonRpcMessage, backend: ForgeBackend): Promise<JsonRpcResponse | null> {
  const { id, method } = msg

  if (method === 'notifications/initialized') return null

  if (id === undefined) return null

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'the-forge', version: '0.0.1' },
      },
    }
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  }

  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
    const name = params.name ?? ''
    const args = params.arguments ?? {}
    try {
      const result = await callTool(name, args, backend)
      return { jsonrpc: '2.0', id, result }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { jsonrpc: '2.0', id, result: textResult(message, true) }
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }
}

export interface QueueItemLike {
  id: string
  markdown: string
  createdAt: string
}

export interface ForgeBackend {
  pull(): Promise<QueueItemLike[]>
  mark(ids: string[], status: string, note?: string): Promise<string[]>
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
]

function textResult(text: string, isError?: boolean): { content: Array<{ type: 'text'; text: string }>; isError?: true } {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

async function callTool(name: string, args: Record<string, unknown>, backend: ForgeBackend) {
  if (name === 'pull_design_edits') {
    const items = await backend.pull()
    if (items.length === 0) return textResult('No pending design edits.')
    const body = items
      .map((i) => `--- request ${i.id} (created ${i.createdAt}) ---\n${i.markdown}`)
      .join('\n\n')
    const ids = items.map((i) => i.id).join(', ')
    const reminder = `\n\nAfter applying these edits, call mark_applied with ids: ${ids}.`
    return textResult(body + reminder)
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

import { describe, it, expect } from 'vitest'
import { handleMessage, type ForgeBackend } from '../../src/mcp/protocol'

function backend(overrides: Partial<ForgeBackend> = {}): ForgeBackend {
  return {
    pull: async () => [],
    mark: async (ids) => ids,
    ...overrides,
  }
}

describe('handleMessage', () => {
  it('responds to initialize with protocol shape', async () => {
    const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, backend())
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'the-forge', version: '0.0.1' },
      },
    })
  })

  it('returns null for notifications/initialized (no response)', async () => {
    const res = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, backend())
    expect(res).toBeNull()
  })

  it('tools/list returns both tools with schemas', async () => {
    const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, backend())
    expect(res?.id).toBe(2)
    const tools = (res as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } })
      .result.tools
    expect(tools).toHaveLength(2)

    const pull = tools.find((t) => t.name === 'pull_design_edits')
    expect(pull).toBeDefined()
    expect(pull?.description).toContain('mark_applied')
    expect(pull?.inputSchema).toEqual({ type: 'object', properties: {} })

    const mark = tools.find((t) => t.name === 'mark_applied')
    expect(mark).toBeDefined()
    expect(mark?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        ids: expect.any(Object),
        status: expect.any(Object),
        note: expect.any(Object),
      },
    })
  })

  it('tools/call pull_design_edits joins markdown with separators and a mark_applied reminder', async () => {
    const be = backend({
      pull: async () => [
        { id: 'a1', markdown: '## Change one', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b2', markdown: '## Change two', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
    })
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pull_design_edits', arguments: {} } },
      be
    )
    const result = (res as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }).result
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    const text = result.content[0].text
    expect(text).toContain('--- request a1 (created 2026-01-01T00:00:00.000Z) ---\n## Change one')
    expect(text).toContain('--- request b2 (created 2026-01-02T00:00:00.000Z) ---\n## Change two')
    expect(text).toContain('a1')
    expect(text).toContain('b2')
    expect(text.toLowerCase()).toContain('mark_applied')
  })

  it('tools/call pull_design_edits with empty queue says so', async () => {
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pull_design_edits', arguments: {} } },
      backend()
    )
    const result = (res as { result: { content: Array<{ type: string; text: string }> } }).result
    expect(result.content[0].text).toBe('No pending design edits.')
  })

  it('tools/call mark_applied reports the count and status', async () => {
    const be = backend({ mark: async (ids) => ids })
    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'mark_applied', arguments: { ids: ['a1', 'b2'], status: 'applied' } },
      },
      be
    )
    const result = (res as { result: { content: Array<{ type: string; text: string }> } }).result
    expect(result.content[0].text).toBe('Marked 2 request(s) as applied.')
  })

  it('unknown method returns a JSON-RPC -32601 error', async () => {
    const res = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'bogus/method' }, backend())
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 6,
      error: { code: -32601, message: 'method not found' },
    })
  })

  it('backend throwing during tools/call yields isError result, not a thrown exception', async () => {
    const be = backend({
      pull: async () => {
        throw new Error('dev server unreachable')
      },
    })
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pull_design_edits', arguments: {} } },
      be
    )
    const result = (res as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }).result
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('dev server unreachable')
  })

  it('tools/call with unknown tool name returns isError', async () => {
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      backend()
    )
    const result = (res as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }).result
    expect(result.isError).toBe(true)
  })
})

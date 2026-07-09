import { describe, it, expect } from 'vitest'
import { handleMessage, type ForgeBackend } from '../../src/mcp/protocol'

function backend(overrides: Partial<ForgeBackend> = {}): ForgeBackend {
  return {
    pull: async () => [],
    mark: async (ids) => ids,
    wait: async () => ({ kind: 'empty' }),
    approve: async () => ({ behavior: 'allow' }),
    ...overrides,
  }
}

/** Runs a tools/call for wait_for_design_edits and returns the result text. */
async function waitCallText(be: ForgeBackend): Promise<string> {
  const res = await handleMessage(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wait_for_design_edits', arguments: {} } },
    be
  )
  const result = (res as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }).result
  expect(result.isError).toBeUndefined()
  return result.content[0].text
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

  it('tools/list returns all four tools with schemas', async () => {
    const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, backend())
    expect(res?.id).toBe(2)
    const tools = (res as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } })
      .result.tools
    expect(tools).toHaveLength(4)

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

    const wait = tools.find((t) => t.name === 'wait_for_design_edits')
    expect(wait).toBeDefined()
    expect(wait?.description).toContain('/forge-watch')
    expect(wait?.inputSchema).toEqual({ type: 'object', properties: {} })

    const approve = tools.find((t) => t.name === 'approve')
    expect(approve).toBeDefined()
    expect(approve?.description).toBeTruthy()
    expect(approve?.inputSchema).toMatchObject({ type: 'object' })
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

  describe('wait_for_design_edits outcomes', () => {
    it('items: renders the same per-request blocks as pull, plus mark + re-arm instructions', async () => {
      const text = await waitCallText(
        backend({
          wait: async () => ({
            kind: 'items',
            items: [{ id: 'w1', markdown: '## Watched change', createdAt: '2026-01-03T00:00:00.000Z' }],
          }),
        })
      )
      expect(text).toContain('--- request w1 (created 2026-01-03T00:00:00.000Z) ---\n## Watched change')
      expect(text).toContain('call mark_applied with ids: w1')
      expect(text).toContain('call wait_for_design_edits again immediately to keep watching')
    })

    it('empty: standing re-arm instruction with no commentary invitation', async () => {
      const text = await waitCallText(backend({ wait: async () => ({ kind: 'empty' }) }))
      expect(text).toBe(
        'No design edits yet. Call wait_for_design_edits again now to keep watching. Do not add commentary between calls.'
      )
    })

    it('stop/idle: tells the user watching paused and forbids re-calling', async () => {
      const text = await waitCallText(backend({ wait: async () => ({ kind: 'stop', reason: 'idle' }) }))
      expect(text).toContain('watching paused; run /forge-watch to resume')
      expect(text).toContain('Do not call wait_for_design_edits again unless the user asks')
    })

    it('stop/replaced: forbids re-calling (no ping-pong between two watch sessions)', async () => {
      const text = await waitCallText(backend({ wait: async () => ({ kind: 'stop', reason: 'replaced' }) }))
      expect(text).toContain('another session took over')
      expect(text).toContain('Do not call wait_for_design_edits again unless the user asks')
    })

    it('stop/no-server: points at the dev server, forbids re-calling until then', async () => {
      const text = await waitCallText(backend({ wait: async () => ({ kind: 'stop', reason: 'no-server' }) }))
      expect(text).toContain('start their Vite dev server')
      expect(text).toContain('Do not call wait_for_design_edits until then')
    })

    it('stop/unlinked tells the agent the user unlinked from the panel', async () => {
      const text = await waitCallText(backend({ wait: async () => ({ kind: 'stop', reason: 'unlinked' }) }))
      expect(text).toBe(
        'Watching stopped — the user unlinked this session from the design panel. Run /forge-watch to re-link if asked. Do not call wait_for_design_edits again unless the user asks.'
      )
    })

    it('unreachable: exactly one retry then stop', async () => {
      const text = await waitCallText(backend({ wait: async () => ({ kind: 'unreachable' }) }))
      expect(text).toContain('call wait_for_design_edits once more')
      expect(text).toContain('if it fails again, stop watching')
    })
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

  describe('approve tool', () => {
    async function approveCall(
      args: Record<string, unknown>,
      be?: ForgeBackend
    ): Promise<{ text: string; isError?: boolean }> {
      const res = await handleMessage(
        { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'approve', arguments: args } },
        be ?? backend()
      )
      const result = (res as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }).result
      return { text: result.content[0].text, isError: result.isError }
    }

    it('allow decision echoes original input as updatedInput JSON', async () => {
      const input = { command: 'ls -la', cwd: '/tmp' }
      const be = backend({ approve: async () => ({ behavior: 'allow' }) })
      const { text, isError } = await approveCall({ tool_name: 'Bash', input }, be)
      expect(isError).toBeUndefined()
      const parsed = JSON.parse(text) as unknown
      expect(parsed).toMatchObject({ behavior: 'allow', updatedInput: input })
    })

    it('allow with absent input uses empty object as updatedInput', async () => {
      const be = backend({ approve: async () => ({ behavior: 'allow' }) })
      const { text } = await approveCall({ tool_name: 'Bash' }, be)
      const parsed = JSON.parse(text) as unknown
      expect(parsed).toMatchObject({ behavior: 'allow', updatedInput: {} })
    })

    it('allow echoes a nested input structure deep-equal as updatedInput', async () => {
      const input = { nested: { arr: [1, 2] }, flag: true }
      const be = backend({ approve: async () => ({ behavior: 'allow' }) })
      const { text } = await approveCall({ tool_name: 'Bash', input }, be)
      const parsed = JSON.parse(text) as { behavior: string; updatedInput: unknown }
      expect(parsed.behavior).toBe('allow')
      expect(parsed.updatedInput).toEqual(input)
    })

    it("deny reason 'user' maps to the constant overlay-deny message", async () => {
      const be = backend({ approve: async () => ({ behavior: 'deny', reason: 'user' }) })
      const { text, isError } = await approveCall({ tool_name: 'Bash', input: {} }, be)
      expect(isError).toBeUndefined()
      const parsed = JSON.parse(text) as unknown
      expect(parsed).toEqual({ behavior: 'deny', message: 'Denied from The Forge overlay.' })
    })

    it("deny reason 'timeout' maps to the constant timed-out message", async () => {
      const be = backend({ approve: async () => ({ behavior: 'deny', reason: 'timeout' }) })
      const { text } = await approveCall({ tool_name: 'Bash', input: {} }, be)
      const parsed = JSON.parse(text) as unknown
      expect(parsed).toEqual({
        behavior: 'deny',
        message: 'Denied — approval timed out in The Forge overlay. Re-send the change when ready.',
      })
    })

    it("deny reason 'unreachable' maps to the constant no-server message", async () => {
      const be = backend({ approve: async () => ({ behavior: 'deny', reason: 'unreachable' }) })
      const { text } = await approveCall({ tool_name: 'Bash', input: {} }, be)
      const parsed = JSON.parse(text) as unknown
      expect(parsed).toEqual({
        behavior: 'deny',
        message: 'Denied — The Forge dev server could not be reached.',
      })
    })

    it('missing tool_name short-circuits to deny without calling backend', async () => {
      let called = false
      const be = backend({
        approve: async () => {
          called = true
          return { behavior: 'allow' }
        },
      })
      const { text } = await approveCall({}, be)
      expect(called).toBe(false)
      const parsed = JSON.parse(text) as unknown
      expect(parsed).toEqual({ behavior: 'deny', message: 'Denied — malformed permission request.' })
    })

    it('non-string tool_name short-circuits to deny without calling backend', async () => {
      let called = false
      const be = backend({
        approve: async () => {
          called = true
          return { behavior: 'allow' }
        },
      })
      const { text } = await approveCall({ tool_name: 42 }, be)
      expect(called).toBe(false)
      const parsed = JSON.parse(text) as unknown
      expect(parsed).toEqual({ behavior: 'deny', message: 'Denied — malformed permission request.' })
    })

    it('backend transport failure → deny (never allow on error, never isError)', async () => {
      const be = backend({
        approve: async () => {
          throw new Error('network error')
        },
      })
      // Fail-closed, unconditionally: the approve branch's own catch must turn a throwing
      // backend into a parseable deny — an isError result here would mean the CLI gets no
      // decision JSON at all.
      const { text, isError } = await approveCall({ tool_name: 'Bash', input: {} }, be)
      expect(isError).toBeUndefined()
      const parsed = JSON.parse(text) as { behavior: string; message: string }
      expect(parsed.behavior).toBe('deny')
      expect(parsed.message).toBe('Denied — The Forge dev server could not be reached.')
    })
  })

  it('echoes id 0 correctly (falsy-id regression)', async () => {
    const be = backend()
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 0, method: 'tools/list' },
      be
    )
    expect(res).not.toBeNull()
    expect(res!.id).toBe(0)
    expect((res as { result?: unknown }).result).toBeTruthy()
  })
})

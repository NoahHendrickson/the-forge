// Fixture constants captured from the live smoke-test transcripts (2026-07-09, CLI 2.1.201).
// Trim irrelevant fields where the brief's mapping doesn't need them, but keep realistic shapes.

export const INIT_NO_MCP = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/Users/noey/Developer/the-forge',
  session_id: '84e31d6e-e76c-42f8-afdc-c92a91baa3dc',
  tools: ['Bash', 'Edit', 'Read'],
  mcp_servers: [],
  model: 'claude-haiku-4-5-20251001',
  permissionMode: 'default',
  apiKeySource: 'none',
})

export const INIT_WITH_MCP = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/Users/noey/Developer/the-forge',
  session_id: '84e31d6e-e76c-42f8-afdc-c92a91baa3dc',
  tools: ['Bash', 'Edit', 'Read'],
  mcp_servers: [{ name: 'the-forge', status: 'connected' }],
  model: 'claude-haiku-4-5-20251001',
  permissionMode: 'default',
  apiKeySource: 'none',
})

export const ASSISTANT_TEXT = JSON.stringify({
  type: 'assistant',
  session_id: '84e31d6e-e76c-42f8-afdc-c92a91baa3dc',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'I will update the file for you.' }],
  },
})

export const ASSISTANT_TOOL_USE = JSON.stringify({
  type: 'assistant',
  session_id: '84e31d6e-e76c-42f8-afdc-c92a91baa3dc',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Edit',
        input: { file_path: 'src/App.tsx' },
      },
    ],
  },
})

export const ASSISTANT_MULTI_BLOCK = JSON.stringify({
  type: 'assistant',
  session_id: '84e31d6e-e76c-42f8-afdc-c92a91baa3dc',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'First block.' },
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'Edit',
        input: { file_path: 'src/App.tsx' },
      },
      { type: 'text', text: 'Second block.' },
    ],
  },
})

export const USER_TOOL_RESULT = JSON.stringify({
  type: 'user',
  session_id: '84e31d6e-e76c-42f8-afdc-c92a91baa3dc',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
  },
})

export const RESULT_SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  result: 'done',
  session_id: '84e31d6e-e76c-42f8-afdc-c92a91baa3dc',
  total_cost_usd: 0.0034,
})

// In-band rate-limit error: arrives via exit 0 as a result, NOT a spawn/process error.
export const RESULT_RATE_LIMIT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  duration_ms: 622,
  num_turns: 1,
  result: "You've hit your weekly limit · resets Jul 12 at 12am (America/New_York)",
  session_id: '156fb16b-d04a-4206-b61c-9bc5d2adfa5e',
  total_cost_usd: 0,
})

export const RESULT_AUTH_FAILURE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  duration_ms: 200,
  num_turns: 1,
  result: 'Not logged in · Please run /login',
  session_id: '156fb16b-d04a-4206-b61c-9bc5d2adfa5e',
  total_cost_usd: 0,
})

export const UNKNOWN_TYPE = JSON.stringify({
  type: 'stream_event',
  delta: { type: 'text_delta', text: 'partial' },
})

export const UNPARSEABLE_LINE = 'not valid json at all {'

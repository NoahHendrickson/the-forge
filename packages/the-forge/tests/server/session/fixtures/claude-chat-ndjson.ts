// Fixture constants captured from live spike probes against the real `claude` CLI
// (2026-07-09, CLI 2.1.201) for milestone B (chat surface). See
// docs/specs/2026-07-09-chat-surface-design.md §6 for the full probe log and findings.
// Trim irrelevant fields where the brief's mapping doesn't need them, but keep realistic shapes.

// --- Step 1: stream_event delta shapes (--include-partial-messages) ---------------------

// Every stream_event line has this envelope: {type:'stream_event', event:{...}, session_id, parent_tool_use_id, uuid}.
// `event.type` carries the inner Anthropic-API-shaped streaming event.

export const STREAM_EVENT_MESSAGE_START = JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'message_start',
    message: {
      model: 'claude-haiku-4-5-20251001',
      id: 'msg_011CcsFvfL6k8o9cxeh1brrm',
      type: 'message',
      role: 'assistant',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 13184, output_tokens: 2 },
    },
  },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: '99a74bbb-7080-4f99-bbcc-0f56d651cc3e',
})

// Thinking block opens before the text block — content_block index 0 is 'thinking', index 1 is 'text'.
export const STREAM_EVENT_CONTENT_BLOCK_START_THINKING = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: '8f5efd8d-f3be-4efe-82fb-515de18e7b58',
})

// The thinking block's only delta observed in this probe was a signature_delta (no thinking_delta text
// chunks arrived for a short reply) — adapters must handle signature_delta as a no-op for chat text purposes.
export const STREAM_EVENT_CONTENT_BLOCK_DELTA_SIGNATURE = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'ErkD...(truncated)' } },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: 'd70a975c-ce34-4f80-8e4d-c931eb3c402e',
})

export const STREAM_EVENT_CONTENT_BLOCK_STOP_THINKING = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_stop', index: 0 },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: '96f468f1-1b27-47a0-aa71-9559635ebb3e',
})

export const STREAM_EVENT_CONTENT_BLOCK_START_TEXT = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: '8a176827-7dba-4745-9ceb-898a72c5894f',
})

// This is the delta shape assistant-delta {text} maps from: event.type === 'content_block_delta'
// && event.delta.type === 'text_delta'. Several of these arrive per reply (one per model-side chunk).
export const STREAM_EVENT_CONTENT_BLOCK_DELTA_TEXT = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Octopuses have three h' } },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: 'faea8f57-04e9-4bfa-b405-ead37543fa17',
})

export const STREAM_EVENT_CONTENT_BLOCK_STOP_TEXT = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_stop', index: 1 },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: '4c33ee31-5908-4dc9-906d-657a1f1d727a',
})

export const STREAM_EVENT_MESSAGE_DELTA = JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: 13184, output_tokens: 251 },
  },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: '7eaa8a04-eaa7-4b7c-8119-ae4ee334e77d',
})

export const STREAM_EVENT_MESSAGE_STOP = JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_stop' },
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  parent_tool_use_id: null,
  uuid: '70885495-213a-463b-9291-4ab2f580f567',
})

// IMPORTANT finding: under --include-partial-messages, `assistant` NDJSON lines are NOT a single
// cumulative snapshot — one arrives per content block as it finalizes, each carrying ONLY that
// block (this one has just the thinking block; a separate later `assistant` line carries just
// the completed text block). Adapters must key off the LAST `assistant` line with a `text` content
// block (immediately preceding message_stop) as the complete reply — not the first one seen, and
// not by merging deltas across `assistant` lines.
export const ASSISTANT_THINKING_BLOCK_SNAPSHOT = JSON.stringify({
  type: 'assistant',
  message: {
    model: 'claude-haiku-4-5-20251001',
    id: 'msg_011CcsFvfL6k8o9cxeh1brrm',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '', signature: 'ErkD...(truncated)' }],
    stop_reason: null,
  },
  parent_tool_use_id: null,
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  uuid: 'f4acae68-21e3-4eea-8ed4-15b51bc4a3ba',
  request_id: 'req_011CcsFveUkcntoe6BCatT4E',
})

// The complete-reply snapshot: same message id/request_id as above, but content is the finished
// text block. This is the one to push to the ring as the final `assistant-text`.
export const ASSISTANT_TEXT_BLOCK_SNAPSHOT_FINAL = JSON.stringify({
  type: 'assistant',
  message: {
    model: 'claude-haiku-4-5-20251001',
    id: 'msg_011CcsFvfL6k8o9cxeh1brrm',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Octopuses have three hearts: two pump blood through the gills, while the third circulates it to the rest of the body...' }],
    stop_reason: null,
  },
  parent_tool_use_id: null,
  session_id: 'd3a8b827-9d9c-4fd4-8929-2095bd3452cd',
  uuid: 'ff016a1a-e7a2-4f4a-b294-65d5438410f0',
  request_id: 'req_011CcsFveUkcntoe6BCatT4E',
})

// --- Step 2: config control requests (set_model / set_permission_mode) ------------------

export const CONTROL_REQUEST_SET_MODEL = JSON.stringify({
  type: 'control_request',
  request_id: 'e1c2d3e4-4444-4444-8888-aa8be24c6666',
  request: { subtype: 'set_model', model: 'claude-haiku-4-5-20251001' },
})

// set_model's ack carries NO echo of the model — just bare success + request_id. Confirmation that
// the change landed has to come from the model field of the next assistant/result event.
export const CONTROL_RESPONSE_SET_MODEL_SUCCESS = JSON.stringify({
  type: 'control_response',
  response: { subtype: 'success', request_id: 'e1c2d3e4-4444-4444-8888-aa8be24c6666' },
})

export const CONTROL_REQUEST_SET_PERMISSION_MODE = JSON.stringify({
  type: 'control_request',
  request_id: 'f1c2d3e4-5555-4444-8888-aa8be24c5555',
  request: { subtype: 'set_permission_mode', mode: 'acceptEdits' },
})

// Unlike set_model, set_permission_mode's ack DOES echo the applied value under response.response.mode.
export const CONTROL_RESPONSE_SET_PERMISSION_MODE_SUCCESS = JSON.stringify({
  type: 'control_response',
  response: { subtype: 'success', request_id: 'f1c2d3e4-5555-4444-8888-aa8be24c5555', response: { mode: 'acceptEdits' } },
})

// A `system/status` line follows immediately (no turn required) confirming the mode is live —
// config-changed does not have to wait for the next turn to be observable.
export const SYSTEM_STATUS_AFTER_PERMISSION_MODE_CHANGE = JSON.stringify({
  type: 'system',
  subtype: 'status',
  status: null,
  permissionMode: 'acceptEdits',
  uuid: '42587f9d-4963-439f-9ab9-cb2028a2d0fb',
  session_id: '5e83b547-1ea8-4c95-9751-dcf9f91b984c',
})

// Sending set_model as literally the first stdin line (before any real chat turn) produces a
// SYNTHETIC `user` line echoing the change as a fake slash-command result — this is NOT chat
// content and must be filtered from any `user-text` mapping (it has no `content[].type: 'text'`
// shape; `content` is a bare string starting with '<local-command-stdout>'). set_permission_mode
// alone (probed separately) produced no such echo — this quirk is set_model-specific.
export const USER_SYNTHETIC_SET_MODEL_ECHO = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: '<local-command-stdout>Set model to claude-haiku-4-5-20251001</local-command-stdout>' },
  session_id: '5e83b547-1ea8-4c95-9751-dcf9f91b984c',
  parent_tool_use_id: null,
})

// Confirmation that a subsequent turn reflects both config changes: model field on the final
// assistant/result matches the set_model value, num_turns/result show the acceptEdits-mode turn
// completed normally (no extra approval friction surfaced in-band for a plain text reply).
export const RESULT_AFTER_CONFIG_CHANGE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  result: 'ok',
  stop_reason: 'end_turn',
  session_id: '5e83b547-1ea8-4c95-9751-dcf9f91b984c',
  total_cost_usd: 0.04217,
})

// --- Step 3: effort mechanism ------------------------------------------------------------

// `claude --help` (2.1.201): `--effort <level>` spawn flag, choices low|medium|high|xhigh|max.
// No config-control equivalent exists — probed below.

export const CONTROL_REQUEST_SET_EFFORT_ATTEMPT = JSON.stringify({
  type: 'control_request',
  request_id: 'c1c2d3e4-2222-4444-8888-aa8be24c8888',
  request: { subtype: 'set_effort', effort: 'high' },
})

// CONFIRMED: no set_effort (or any effort-related) control_request subtype exists in CLI 2.1.201.
// The error message is generic ("Unsupported control request subtype: <subtype>") regardless of
// the subtype name tried (also probed with a nonsense subtype — same message shape, no enumeration
// of valid subtypes). Effort is spawn-flag-only: adapters must respawn with `--resume <session_id>
// --effort <level>` to change it mid-session (Task 3's respawn branch applies, not the control-
// request branch).
export const CONTROL_RESPONSE_SET_EFFORT_UNSUPPORTED = JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'error',
    request_id: 'c1c2d3e4-2222-4444-8888-aa8be24c8888',
    error: 'Unsupported control request subtype: set_effort',
  },
})

// --- Step 4: mid-turn second user turn ----------------------------------------------------

// Verdict: writing a second `user` turn line ~2s into a slow first turn is HARMLESS — the CLI
// queues it cleanly and processes it only after the first turn's `result` event, with its own
// full turn (a fresh `system/init` line recurs before EVERY turn in this CLI version, not just
// at boot — adapters must not assume init is a once-per-process event). No interleaving, no
// error, no dropped turn was observed. This documents (not guards) that a manager-side race
// writing mid-turn would be harmless — the flush-on-turn-complete FIFO design remains the
// primary mechanism regardless.

export const RESULT_FIRST_TURN_BEFORE_SECOND_WRITTEN = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  result: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30',
  stop_reason: 'end_turn',
  session_id: '76d41f74-f229-4a1e-ac9a-c8626c9c0c8a',
  total_cost_usd: 0.042287,
})

// Same session_id as the first turn's result — confirms it's the same session/process, second
// `system/init` recurs (trimmed to the fields that matter here) ahead of the queued second turn.
export const SYSTEM_INIT_RECURS_BEFORE_SECOND_TURN = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/Users/noey/Developer/the-forge/.claude/worktrees/jolly-sinoussi-82efa9',
  session_id: '76d41f74-f229-4a1e-ac9a-c8626c9c0c8a',
  model: 'claude-haiku-4-5-20251001',
  permissionMode: 'default',
})

export const RESULT_SECOND_TURN_CLEAN = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  result: 'second',
  stop_reason: 'end_turn',
  session_id: '76d41f74-f229-4a1e-ac9a-c8626c9c0c8a',
  total_cost_usd: 0.0502258,
})

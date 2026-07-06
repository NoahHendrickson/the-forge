# Prompt mode — free-form prompts on a selected element

**Date:** 2026-07-05
**Status:** Approved design, pre-plan
**Depends on:** existing design-mode loop (panel, queue, dispatch, lifecycle, MCP contract) — no server or MCP changes

## Summary

Add a second way to talk to the agent from design mode: alongside the precise property
panel, a **Prompt** button in the panel header opens a floating textarea anchored to the
selected element. The user types a free-form instruction ("make this feel more prominent"),
hits send, and The Forge packages the prompt plus the element's exact source context
(`file:line:col`, tag, classes, text, selector) into a queue item that rides the existing
queue → dispatch → watcher → `mark_applied` loop unchanged.

Microphone dictation is **deferred** to a follow-up milestone; this spec records the
research so that milestone starts warm (see "Deferred: microphone").

## User-ratified decisions

| Decision | Choice |
| --- | --- |
| Send scope | Prompt sends are **independent** of draft sends — separate queue items, separate lifecycles. The prompt flow never reads or flushes the DraftStore. |
| Microphone | **Deferred** to a follow-up milestone; prompt box layout reserves a slot for the button. |
| Terminal lifecycle state | `done` on `mark_applied` status `applied` — no computed-style verification attempted for prompt sends. `failed` (with agent note) on status `failed`. |
| Placement | **Anchored to the element** (floating box in the shadow overlay near the selection outline), not docked in the panel. |
| Prompt text persistence | Discarded when the box closes (Esc, re-click Prompt, selection change). Kept while the box stays open. v1 simplification. |
| Multi-select | Allowed — one element-context block per selected element; the prompt applies to the whole selection. |

## UX flow

1. Select an element → panel shows as today, with a new **Prompt** button in the panel
   header, created via the `ui/button.ts` factory (convention: no raw `createElement` for
   buttons).
2. Click Prompt → a floating prompt box opens in the shadow-DOM overlay, anchored to the
   selected element's outline: positioned below the element, flipping above when it would
   leave the viewport. Repositioned on scroll/resize **only while open** — no listeners
   exist when the box is closed (zero-idle-overhead constraint).
3. The box contains a textarea (autofocused) and a Send button. `Cmd/Ctrl+Enter` sends.
   `Esc` or re-clicking Prompt closes. Changing selection closes and discards.
4. Send is disabled while the textarea is empty or a queue POST is in flight
   (re-entrancy guard). Prompt sends **bypass the draft duplicate filter** — every typed
   prompt is intentional — but never allow two concurrent POSTs from one box.
5. After a successful queue POST, the same fire-and-forget `/dispatch` call runs and the
   box closes; the send lands as a row in the Changes list.

## Request format

New `renderPromptMarkdown()` in `src/client/request.ts`, beside `renderMarkdown()`:

```markdown
# Design prompt

The user selected the element(s) below in the running app and typed a free-form
instruction. Apply it to the identified source location(s). Drafted at viewport 1440×900.

## 1. <button> — src/components/Hero.tsx:42:8
Text: "Get started"
Current classes: `px-4 py-2 rounded-md bg-blue-600`
Selector: `div#hero > div > button`

## Instruction

<the user's prompt, verbatim>

Scope: apply to this call site only. If a change would modify a shared component rendered
elsewhere, skip it and report it back as needing confirmation — do not pause waiting for
an answer.
Do not run the app, take screenshots, or preview the result — the user is watching the
live app.
```

- Element context reuses existing helpers: `parseSourceAttr` for `file:line:col`,
  `cssPath()` for the selector, the same 80-char text trim as `buildChangeRequestWithElements`.
- The two guardrail lines are shared constants with the precise flow (single source of
  truth), except the verifier sentence drops "The Forge verifies the changes
  automatically" — for prompt sends it doesn't.
- Queue payload: `POST /__the-forge/queue` with
  `{ request: { kind: 'prompt', prompt, viewport, elements }, markdown }` plus the
  `X-Forge-Secret` header. The stored `request` is write-only server-side (existing
  behavior) — agents only ever see the markdown, which is why **no server, queue, or MCP
  changes are needed**.

## Lifecycle

- Prompt sends register with `LifecycleSession` like draft sends, with seeds carrying
  `kind: 'prompt'` and the prompt text (truncated to 80 chars, matching the element-text
  trim) as the Changes-list row label in place of property deltas.
- Stages: `sent` → `applying` (queue status `claimed`) → `done` on `mark_applied`
  `applied`, `failed` (with the agent's note) on `failed`. The verifier's computed-style
  path is skipped for prompt seeds; the `/status` polling machinery is reused as-is.
- Re-send and dismiss work unchanged. sessionStorage persistence/restore
  (`lifecycle-store.ts`) includes prompt seeds; restore does not need element resolution
  to verify styles (there's nothing to verify), only for row display.

## Module changes

| Module | Change |
| --- | --- |
| `src/client/prompt.ts` (new) | `PromptBox` — floating box UI, anchoring/flip/reposition, open/close state, send wiring |
| `src/client/panel.ts` | Prompt button in the panel header (via `ui/button.ts`); toggles the box |
| `src/client/request.ts` | `renderPromptMarkdown()` + shared guardrail constants; prompt request type |
| `src/client/index.ts` | Wires PromptBox into selection changes and the shared queue→dispatch send helper |
| `src/client/lifecycle.ts` | `kind: 'prompt'` on seeds; `done` on applied without style verification |
| `src/client/changelist.ts` | Prompt rows render the prompt text instead of property deltas |
| `src/client/overlay.ts` | CSS for `.prompt-box`, `.prompt-textarea`, `.prompt-send` (class names are test hooks) |
| `stories/` | Story rendering the real PromptBox |

Explicitly unchanged: `src/transform.ts`, all of `src/server/`, `src/mcp/`, `src/next/`,
the verifier's style-checking path, `drafts.ts`.

## Constraints honored

- Zero new runtime dependencies; zero production footprint (client-only, dev-served
  bundle); zero idle overhead (no listeners until the box is open).
- Complementary to the user's agent — the prompt travels the same subscription-only
  queue/dispatch path; no new chat surface (the box is fire-and-forget, replies land as
  code changes + `mark_applied` notes, not conversation).
- Panel/overlay CSS class names extend, never rename.

## Testing

- `tests/client/prompt.test.ts` — markdown rendering (single + multi-select, no-source
  fallback), open/close/discard state machine, send path with mocked fetch (disabled
  states, re-entrancy), lifecycle flips from mocked `/status` responses.
- Panel test: header button presence + toggle behavior.
- Storybook story for the box.
- **Real-browser E2E against the demo app before merge** — jsdom cannot see the
  anchoring/flip positioning (project gotcha).

## Deferred: microphone (research record)

Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) is the only option
compatible with the hard constraints (zero deps, zero API keys, 250KB budget):

- Supported: Chrome, Edge, Safari 14.1+ (webkit prefix), Opera. Firefox ships it disabled
  behind `dom.webspeech.recognition.enable` — the mic button must hide entirely when the
  API is absent; typing is the fallback.
- Chrome processes audio on Google's servers (no offline); Safari uses the OS engine.
  On-device recognition is emerging (`processLocally`, Edge 150+ Canary,
  `on-device-speech-recognition` Permissions-Policy) but not baseline in mid-2026.
- Works on `localhost` (secure context); one-time mic permission prompt; `interimResults`
  enables live type-as-you-speak into the textarea. Estimated ~60 lines.
- Rejected alternatives: WASM Whisper (~40MB model — footprint), cloud STT (API keys —
  subscription-only constraint).

Sources: [MDN Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API),
[caniuse speech-recognition](https://caniuse.com/speech-recognition),
[MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition),
[Edge on-device speech recognition](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api).

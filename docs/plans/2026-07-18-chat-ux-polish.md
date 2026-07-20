# 2026-07-18 — Chat UX polish (best-in-class messaging pass)

Benchmark pass over the chat surface against Cursor, Claude Code, ChatGPT, and claude.ai:
how they render the user↔assistant exchange, afford tool calls in flight vs. finished,
show attachments, and mark completion. Everything below stays inside the hard product
constraints: zero new runtime dependencies, shadow-DOM CSS only, class names extended
never renamed, `session-feed.ts` under 1k lines.

## Contract

1. **Assistant markdown** (`chat-markdown.ts`, new): assistant bubbles render markdown —
   paragraphs, `#`–`####` headings, fenced code blocks, `- `/`1. ` lists, `> ` quotes,
   inline code/bold/italic/links. Hand-rolled and XSS-safe by construction: DOM built
   exclusively with `createElement`/`textContent`, never `innerHTML` on model output;
   links get an `href` only when the target parses as http(s), always
   `target="_blank" rel="noreferrer noopener"`. Plain text stays byte-identical through
   `textContent` (pinned by the existing full-text bubble test). Streaming deltas
   re-render the accumulated text each tick — same "markdown reflows as it streams"
   behavior as claude.ai/ChatGPT; an unclosed marker renders literally until closed.
   User bubbles deliberately stay plain text (every reference product renders the user's
   own words verbatim).

2. **Thinking indicator** (`.chat-working`): a `user-text` event inserts a single
   "Thinking" row with animated dots after the user bubble; the next signal of activity
   (delta, final text, tool-started, approval, turn-complete, session-error, ended)
   removes it. Fills the dead air between send and first token — the gap ChatGPT/Claude
   cover with a shimmer. Singleton, lives outside the MAX_ROWS bookkeeping (it is
   ephemeral chrome, not history), always inserted before the anchor spacer.

3. **Tool rows restyled as steps**: category icon (edit/read/terminal/search/web/task,
   derived from the tool name), `.tool-name` medium-weight label, `.tool-detail`
   muted mono ellipsized to one line, spinner pushed to the row's right edge and
   CSS-animated while running. `tool-finished` still flips `.session-spinner` text to
   `✓` (pinned hook) and now also adds `.done` to the spinner and `.tool-done` to the
   row so CSS can settle the step (green check, spin stops).

4. **Completion marker** (`.turn-done`): a clean `turn-complete` appends a muted
   `✓ Done` row, with `· $<cost>` when the event carries `costUsd` (Claude Code shows
   per-turn cost; Cursor draws a checkpoint line). Error turns keep the error row and
   never get one.

5. **Diff stats** (`.session-diff`): the disclosure summary becomes
   `<file> +N −M` — `.diff-file` basename plus green/red line-delta counts computed by a
   multiset line comparison (no diff library). Pre blocks get max-height + scroll.
   The three summary-text assertions move from `summary.textContent` to `.diff-file`.

6. **Message alignment + attachment chip**: user bubbles right-aligned at max-width 85%
   with asymmetric radius (ChatGPT/claude.ai), assistant stays left/plain; the
   `.chat-msg-ref` element reference renders as a bordered chip, echoing the composer
   pill it came from.

7. **Composer**: plain **Enter sends**, Shift+Enter inserts a newline, IME composition
   guarded, Cmd/Ctrl-Enter kept — this deliberately flips the 2026-07-05 prompt-mode-era
   "plain Enter does not send" choice: that decision predates the composer being a chat
   surface, and every reference product (ChatGPT, Cursor, Claude Code, claude.ai) treats
   Enter as send in a chat context. Textarea auto-grows with typed content
   (JS autosize, 140px cap, `resize: none`) like every modern composer.

8. **Approval + error cards**: approvals get an accent-tinted card with the tool name
   emphasized, detail in mono, Allow as the primary action; errors get a red-tinted card
   with a ⚠ glyph. Resolution still collapses to the bare Allowed/Denied line.

## Structure

`session-feed.ts` sheds its row builders to a new `chat-rows.ts` (same extraction seam
as `composer-config.ts`/`feed-anchor.ts` — presentation, not stream state) to stay under
1k lines; `chat-markdown.ts` is the renderer. Why-comments move verbatim.

## Test sketch

- `tests/client/chat-markdown.test.ts` (new): plain-text passthrough (textContent
  byte-identical), code fence, inline code/bold/italic, safe-link vs `javascript:` href
  suppression, lists, headings, quote, paragraph splits.
- `session-feed.test.ts` additions: working row appears on user-text / clears on first
  delta and on turn-complete; turn-done row on clean complete (with + without cost),
  absent on error turns; `.tool-done`/`.done` classes land on tool-finished; diff summary
  stats (`+1 −1` for a one-line swap); Enter sends / Shift+Enter doesn't / IME guard;
  updated pins: diff summary queries `.diff-file`, "plain Enter does not send" replaced.
- Existing suites stay green: bubbles keep exact `textContent`, spinner keeps `✓`,
  approval resolve keeps bare `Allowed`/`Denied`, MAX_ROWS/anchor invariants untouched.

## Real-browser check

jsdom cannot see any of this (layout, animation, markdown block flow) — verified via a
scratch Vite harness page that mounts `SessionFeed` + overlay CSS with a scripted event
stream, screenshotted in headless Chromium before merge.

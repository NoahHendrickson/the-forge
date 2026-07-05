# Send-pipeline review: how an edit reaches the agent

Review pass, 2026-07-05, over the full delivery path: Send click → `buildChangeRequest` /
`renderMarkdown` (client/request.ts) → `POST /queue` (server/endpoints.ts → queue.ts) →
`WatcherHub.notify` / dispatch ladder (watchers.ts, dispatch.ts) → MCP bin
(mcp/index.ts, discover.ts, protocol.ts) → `mark_applied` → verifier poll (client/verifier.ts).
Findings ranked by impact; code references verified against the current branch.

## Issues

### 1. All-no-op requests still queue and dispatch (medium)

`DraftStore.apply()` keeps a draft whose value was scrubbed back to its original
(`existing.value = value` — no equality check against `original`), so `draftCount > 0` and the
Send button stays visible (`overlay.ts:461` hides it only at zero). `renderMarkdown` filters
no-op *bullets* (`if (c.beforeCss === c.afterCss) continue`, request.ts:260) but keeps the
element *section header*. Net effect: the agent can receive a request whose sections contain
zero edit bullets — or an entire request with nothing actionable — and burns a full
deliver → puzzle → mark cycle on it. In watch mode this also resets the idle clock
(`lastActivity`) for nothing.

Fix shape: drop no-op `ChangeItem`s in `buildChangeRequestWithElements`, drop elements with no
surviving changes, and skip the queue POST (flash "no changes") when nothing survives.

### 2. The agent's failure note dies at the verifier (medium, UX)

`mark_applied` carries a one-line failure reason end to end — `note` is stored on the queue
item and returned by `GET /status` — and then `Verifier.handleFailed()` (verifier.ts:255)
ignores it. The user sees `1 failed ✗` with no reason, even though the agent wrote one. The
whole point of the `note` field is this surface. Fix: thread `note` through
`handleFailed`/`renderSummary` (e.g. tooltip or appended text on the failed part).

### 3. No duplicate-send guard (medium)

After a successful send, drafts stay live — they only commit when verification passes. Nothing
stops a second Send of the same drafts (the button re-enables once dispatch settles). The
second request is worse than a no-op: it says ``change `py-2.5` → `py-6` `` but the first apply
already removed `py-2.5`, so the instruction no longer matches the source and the agent must
improvise, fail, or "apply" a lie. `SentRegistry` already knows which elements are in flight —
either exclude in-flight elements from a new request, or dedupe in `Queue.add` by markdown
hash while a matching item is pending/claimed.

### 4. "Pause and confirm first" fights the queue lifecycle in watch mode (medium)

The markdown footer instructs: shared-component edits → "pause and confirm first". In a watch
session, pausing leaves the item `claimed` and unmarked; after `CLAIM_TIMEOUT_MS` (5 min) the
claim goes stale and `pull()` re-delivers it on a later wait cycle — so an unattended watch
session re-asks the same confirmation every ~5 minutes until idle-stop. Better protocol: tell
the agent to `mark_applied` with `status: "failed"` and `note: "needs confirmation: <reason>"`
instead of leaving the item unresolved. Combined with finding 2, the reason then lands in the
panel where the user actually is.

### 5. The 15-second re-arm margin can drop a live watcher between cycles (medium)

`lastSeen` is stamped at wait *entry* (watchers.ts:138); the hold runs `WAIT_HOLD_MS` (20s);
freshness is `WATCHER_FRESH_MS` (35s). So after a hold expires, the agent has ~15s to process
the result and re-invoke the tool before `state()` reads `asleep`. A slow turn — big session
context, thinking, MCP round-trip overhead — blows that margin routinely. A Send landing in
the gap takes the keystroke ladder and types `/forge-design` into the very session that is
watching (the double-nudge the `applying()` guard exists to prevent mid-apply, resurfacing
between idle cycles).

Cheap fix: stamp `lastSeen = now()` when the hold-expiry timer settles the waiter (the watcher
was verifiably connected for the whole 20s hold — the socket-close path already flips
`watching` off, so a dead bin can't benefit). That gives the full 35s for re-arm instead of
15s, with no change to the idle bound (`lastActivity` untouched).

### 6. The Cursor deeplink rung never closes the loop (medium, known-ish gap)

The deeplink carries `pending.markdown` — raw `renderMarkdown` output with no queue id and no
`mark_applied` instruction — and the plugin installs MCP config for Claude only (`.mcp.json`
+ `.claude/commands/`). On the cursor path, nothing ever pulls or marks: the item stays
`pending` forever, the verifier can never flip drafts to Implemented, and the status line
shows the queued/manual copy indefinitely even after Cursor applied the edit perfectly.
Options, cheapest first: (a) accept + document (verification is a Claude-linked feature);
(b) include the item id and a "verification will not auto-complete" note in the deeplink text;
(c) also write `.cursor/mcp.json` so Cursor sessions get the same pull/mark contract.

## Optimizations

### 7. Dead id + duplicate id in the delivered text (small)

`ChangeRequest.id` (client-side `crypto.randomUUID()`, request.ts:230) is stored in the queue
item's `request` blob and never read by anything — the queue item's own id is the real
identity everywhere. Drop it, or use it as the queue id (pass through `Queue.add`) so client
logs and server state share one identity. Separately, the full 36-char UUID appears twice per
delivered item (wrapper line + reminder), ~20 tokens each; an 8-char prefix in the reminder
would be unambiguous at queue scale (≤200 items).

### 8. The structured `request` blob is write-only (small)

`queue.add(request ?? null, markdown)` persists the full structured request per item; no
consumer reads `item.request` (agent gets markdown; `/status` returns id/status/note). It
roughly doubles per-item disk size for debugging value only. Fine to keep deliberately — but
worth a comment saying it's a debugging artifact, so it doesn't read as a half-wired feature.

### 9. MCP bin could walk up to find `.the-forge` (small, kills a documented gotcha)

`discover.ts` reads exactly `<cwd>/.the-forge`, which is why the "agent session must run at
the git root" gotcha exists. A bounded parent-walk (same shape as `resolveProjectRoot`'s
10-level `.git` walk, stopping at the first directory containing `.the-forge` with a live
endpoint) removes the failure mode entirely — a session opened in `packages/foo` would still
find the project's endpoint. Low risk: the walk only ever *adds* discovery, and monorepo
nested-`.the-forge` ambiguity is already resolved by nearest-first ordering.

## What's already solid (don't touch)

- **Injection posture**: agent-followed texts are compile-time constants; server data only
  selects between them; element text is backtick-stripped + truncated; dispatch never types
  request content (only the literal `/forge-design`); AppleScript scripts are constants with a
  front-window ownership check before any keystroke.
- **Queue durability**: atomic tmp+rename writes scoped by pid, corrupt-file quarantine (never
  silent discard), additive disk merge for two-server setups, stale-claim recovery, terminal
  items never clobbered by a late duplicate mark.
- **Watcher hub**: single slot with mechanical no-ping-pong (token absorb), the `applying()`
  liveness hold with its CLAIM_TIMEOUT bound, idle auto-stop as a hard token-cost bound,
  socket-close cancel to kill ghost liveness, notify-after-200 so delivery can't fail a Send.
- **Dispatch ladder discipline**: settled-ref checks before every mutating exec, overall
  timeout resolving to manual, deeplink length cap falling through instead of truncating.
- **Verifier**: inline-style neutralization before measuring (so the draft can't verify
  itself), per-element commit granularity, generation-tagged poll chains, failure backoff with
  distinct reachable-vs-unreachable copy.

## Suggested order if we fix

1 and 3 are the same neighborhood (request building + send guard) — one small milestone.
2 and 4 pair naturally (failure-note surfacing + watch-mode confirmation protocol). 5 is a
two-line hub change plus a test. 6 needs a product decision (is verification Claude-only?).
7–9 are opportunistic.

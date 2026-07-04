import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type Rung = 'channels' | 'tmux' | 'applescript' | 'deeplink' | 'manual'

export interface DispatchResult {
  rung: Rung
  detail: string
}

export interface DispatchOpts {
  agent: 'claude-code' | 'cursor' | 'codex'
  channelsFlag: boolean
  markdown: string
  /** Injectable for tests — never read process.platform directly inside adapters. Defaults to
   * the real process.platform. */
  platform?: NodeJS.Platform
  /** Injectable cwd for the channels marker-file check. Defaults to process.cwd(). */
  cwd?: string
  /** Injectable overall ladder timeout (ms) — never a hardcoded real 5s wait in tests. Defaults
   * to LADDER_TIMEOUT_MS (5000). */
  ladderTimeoutMs?: number
}

export type ExecFileFn = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string }>

const EXEC_TIMEOUT_MS = 2000
const DEEPLINK_MAX_ENCODED_LENGTH = 6000
const LADDER_TIMEOUT_MS = 5000

/** Default ExecFileFn — always invoked as an argv array (execFile), NEVER a shell string.
 * This is the only place real child processes are spawned; every adapter below takes its
 * exec function as a parameter so tests can inject a fake and assert exact argv with zero
 * real tmux/osascript/open invocations. */
export const defaultExec: ExecFileFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts?.timeout ?? EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err)
      else resolve({ stdout: stdout.toString() })
    })
  })

/** The literal, constant text ever typed into a terminal on the user's behalf. Request content
 * (the change-request markdown) NEVER travels through tmux/AppleScript — only this literal
 * slash command reaches a terminal keystroke-by-keystroke. */
const DESIGN_COMMAND = '/design'

/** Shared mutable ref threaded through the ladder so `dispatch`'s overall-timeout callback can
 * flip `settled = true` and every adapter can check it immediately before a MUTATING exec call
 * (tmux send-keys, an osascript keystroke script, or `open` for the Cursor deeplink). Once the
 * ladder has timed out and resolved to 'manual', a slow adapter step that only resolves LATER
 * (e.g. a hung `tmux list-panes`) must never go on to actually type/click on the user's behalf —
 * the caller already got its answer and may have moved on. */
export interface SettledRef {
  settled: boolean
}

/** tmux adapter: finds the first pane whose current command matches `paneCommand` exactly and
 * sends the literal `/design` + Enter into it. Any failure (missing tmux binary, no server
 * running, no matching pane, send-keys failing) resolves to null so the caller falls through
 * to the next rung — this adapter never throws. */
async function tryTmux(paneCommand: 'claude' | 'codex', exec: ExecFileFn, settledRef: SettledRef): Promise<DispatchResult | null> {
  let stdout: string
  try {
    ;({ stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_current_command}'], {
      timeout: EXEC_TIMEOUT_MS,
    }))
  } catch {
    return null
  }
  // The ladder's overall timeout may have already fired while list-panes was in flight — the
  // caller has moved on with 'manual', so sending keystrokes now would be an unsolicited,
  // unaccountable mutation. Bail before evaluating panes or calling send-keys.
  if (settledRef.settled) return null

  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  let paneId: string | null = null
  for (const line of lines) {
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx === -1) continue
    const id = line.slice(0, spaceIdx)
    const cmd = line.slice(spaceIdx + 1).trim()
    if (cmd === paneCommand) {
      paneId = id
      break
    }
  }
  if (!paneId) return null
  if (settledRef.settled) return null

  try {
    await exec('tmux', ['send-keys', '-t', paneId, DESIGN_COMMAND, 'Enter'], { timeout: EXEC_TIMEOUT_MS })
  } catch {
    return null
  }

  return { rung: 'tmux', detail: `typed /design into tmux pane ${paneId}` }
}

/** Best-effort AppleScript scripts — CONSTANTS, zero interpolation of any dynamic content
 * (request markdown never appears here; only the literal /design command and the literal
 * agent-name marker checked for in the title/session-name heuristic below). Tries iTerm2 first,
 * then Terminal.app.
 *
 * Controller ruling (brief conflict adjudication): keystroking into the front window is only
 * safe once we've verified that window actually belongs to the target agent session — otherwise
 * we'd type /design into an unrelated shell and still report success. Each script therefore
 * checks a title/session-name heuristic FIRST:
 *   - iTerm2: `name of current session of current window` contains the agent marker
 *     ("claude" or "codex" — two separate constants, one per agent).
 *   - Terminal: `name of front window` contains the agent marker.
 * If the check fails, the script returns the sentinel string "no-session" and types nothing.
 * If it passes, it types the literal /design + Enter and returns "ok". A denied automation
 * permission, the app not running, or any other osascript failure moves on to the next app /
 * next rung — never throws. */
const ITERM_CLAUDE_MARKER = 'claude'
const ITERM_CODEX_MARKER = 'codex'
const TERMINAL_CLAUDE_MARKER = 'claude'
const TERMINAL_CODEX_MARKER = 'codex'

const ITERM_SCRIPT_CLAUDE = `
tell application "System Events"
  if not (exists process "iTerm2") then error "iTerm2 not running"
end tell
tell application "iTerm2"
  set sessionName to name of current session of current window
  if sessionName does not contain "${ITERM_CLAUDE_MARKER}" then return "no-session"
  activate
end tell
tell application "System Events"
  tell process "iTerm2"
    keystroke "/design"
    keystroke return
  end tell
end tell
return "ok"
`

const ITERM_SCRIPT_CODEX = `
tell application "System Events"
  if not (exists process "iTerm2") then error "iTerm2 not running"
end tell
tell application "iTerm2"
  set sessionName to name of current session of current window
  if sessionName does not contain "${ITERM_CODEX_MARKER}" then return "no-session"
  activate
end tell
tell application "System Events"
  tell process "iTerm2"
    keystroke "/design"
    keystroke return
  end tell
end tell
return "ok"
`

const TERMINAL_SCRIPT_CLAUDE = `
tell application "System Events"
  if not (exists process "Terminal") then error "Terminal not running"
end tell
tell application "Terminal"
  set windowName to name of front window
  if windowName does not contain "${TERMINAL_CLAUDE_MARKER}" then return "no-session"
  activate
end tell
tell application "System Events"
  tell process "Terminal"
    keystroke "/design"
    keystroke return
  end tell
end tell
return "ok"
`

const TERMINAL_SCRIPT_CODEX = `
tell application "System Events"
  if not (exists process "Terminal") then error "Terminal not running"
end tell
tell application "Terminal"
  set windowName to name of front window
  if windowName does not contain "${TERMINAL_CODEX_MARKER}" then return "no-session"
  activate
end tell
tell application "System Events"
  tell process "Terminal"
    keystroke "/design"
    keystroke return
  end tell
end tell
return "ok"
`

/** Note on "CONSTANTS, zero interpolation": the four scripts above are fixed, hardcoded string
 * literals selected by agent — never built via runtime string interpolation of request content
 * or any other dynamic/user-controlled value. The `${...}` occurrences are TypeScript template
 * literal syntax splicing in OTHER top-level string CONSTANTS (the marker words themselves), not
 * dynamic data; the resulting script text is identical on every run for a given agent. */
async function tryAppleScript(
  platform: NodeJS.Platform,
  paneCommand: 'claude' | 'codex',
  exec: ExecFileFn,
  settledRef: SettledRef
): Promise<DispatchResult | null> {
  if (platform !== 'darwin') return null

  const scripts =
    paneCommand === 'codex'
      ? ([
          ['iTerm2', ITERM_SCRIPT_CODEX],
          ['Terminal', TERMINAL_SCRIPT_CODEX],
        ] as const)
      : ([
          ['iTerm2', ITERM_SCRIPT_CLAUDE],
          ['Terminal', TERMINAL_SCRIPT_CLAUDE],
        ] as const)

  for (const [appName, script] of scripts) {
    // Each osascript call below both verifies the front session/window AND (if verified) types
    // the keystroke — it's a single atomic mutating call from our side. Once the ladder has
    // already timed out, no FURTHER such calls may be issued (an already-in-flight call can't be
    // un-invoked, but we must not proceed to try the next app's script after it resolves).
    if (settledRef.settled) return null
    try {
      const { stdout } = await exec('osascript', ['-e', script], { timeout: EXEC_TIMEOUT_MS })
      if (settledRef.settled) return null
      if (stdout.trim() !== 'ok') continue // verification failed (sentinel "no-session") — try next app
      return { rung: 'applescript', detail: `typed /design into ${appName} via AppleScript` }
    } catch {
      // try the next app
    }
  }
  return null
}

/** Cursor deeplink — the ONE place request content (markdown) travels anywhere near a
 * terminal/URL: it is URL-encoded into a `cursor://` deeplink opened via `open`, which hands
 * the URL to the OS/Cursor — never interpreted by a shell. User still presses Enter in Cursor
 * (spec hard floor: dispatch never submits on the user's behalf). Oversized markdown (deeplink
 * length limits) falls through to manual instead of risking a truncated/broken deeplink. */
async function tryDeeplink(markdown: string, exec: ExecFileFn, settledRef: SettledRef): Promise<DispatchResult | null> {
  const encoded = encodeURIComponent(markdown)
  if (encoded.length > DEEPLINK_MAX_ENCODED_LENGTH) return null
  // Defensive only: deeplink is the FIRST rung of the cursor ladder and makes a single
  // exec call, so settled-before-entry is unreachable through dispatch() by construction
  // (mutation-untestable via the public API — unlike the tmux/osascript guards, which are
  // mutation-proven). Kept because a future ladder reordering would silently need it.
  if (settledRef.settled) return null

  const url = `cursor://anysphere.cursor-deeplink/prompt?text=${encoded}`
  try {
    await exec('open', [url], { timeout: EXEC_TIMEOUT_MS })
  } catch {
    return null
  }
  return { rung: 'deeplink', detail: 'opened Cursor deeplink' }
}

/**
 * Channels stub (experimental, claude-code only). Real Channels integration is blocked on
 * Claude Code preview availability (parked question — revisit once Channels ships). Tonight
 * this rung only checks for a marker the companion process would create
 * (`.the-forge/channel-<pid>`) and ALWAYS falls through, since no real companion writes that
 * marker yet — this is intentionally inert until Channels preview access lands.
 */
async function tryChannels(cwd: string): Promise<DispatchResult | null> {
  const marker = path.join(cwd, '.the-forge', `channel-${process.pid}`)
  if (!fs.existsSync(marker)) {
    // Tonight there is no companion process that ever creates this marker, so this rung
    // always falls through with fallthrough reason "channels: no channel found (preview)" —
    // parked here as a comment (not surfaced anywhere yet) for whoever wires up real Channels
    // support later, once the Claude Code preview is available.
    return null
  }
  // Unreachable in practice tonight (marker is never created by anything), but kept as the
  // real check so this rung "just works" once a companion starts writing the marker.
  return null
}

/** The actual per-agent ladder walk — factored out so `dispatch` can race it against the overall
 * timeout below without duplicating the ladder logic. `settledRef` is shared with `dispatch`,
 * which flips it to true the instant the overall timeout fires — every adapter checks it
 * immediately before its mutating exec call so a ladder that keeps running in the background
 * after a timeout can never type/click on the user's behalf. */
async function runLadder(opts: DispatchOpts, exec: ExecFileFn, settledRef: SettledRef): Promise<DispatchResult> {
  const platform = opts.platform ?? process.platform
  const cwd = opts.cwd ?? process.cwd()

  if (opts.agent === 'cursor') {
    const deeplink = await tryDeeplink(opts.markdown, exec, settledRef)
    if (deeplink) return deeplink
    return { rung: 'manual', detail: 'deeplink unavailable — type /design in Cursor' }
  }

  const paneCommand = opts.agent === 'codex' ? 'codex' : 'claude'

  if (opts.agent === 'claude-code' && opts.channelsFlag) {
    const channels = await tryChannels(cwd)
    if (channels) return channels
  }

  const tmuxResult = await tryTmux(paneCommand, exec, settledRef)
  if (tmuxResult) return tmuxResult

  const appleScriptResult = await tryAppleScript(platform, paneCommand, exec, settledRef)
  if (appleScriptResult) return appleScriptResult

  return { rung: 'manual', detail: `type /design in ${opts.agent === 'codex' ? 'Codex' : 'Claude Code'}` }
}

/**
 * Runs the dispatch ladder for the configured agent and returns the rung that succeeded (or
 * 'manual' if every automated rung fell through). NEVER spawns an agent CLI with an API key and
 * NEVER touches the Agent SDK — this only reaches for the user's already-RUNNING session via
 * tmux send-keys, AppleScript keystrokes, or (cursor) a deeplink. The only text ever typed into
 * a terminal is the literal `/design` + Enter; request content only ever travels (URL-encoded)
 * through the Cursor deeplink.
 *
 * The whole ladder is capped at `opts.ladderTimeoutMs` (default 5000ms, injectable for tests) via
 * Promise.race — a hung adapter (e.g. an execFile call whose timeout option was somehow bypassed,
 * or an unexpected OS-level hang) must never leave the caller (the /dispatch HTTP endpoint)
 * waiting forever. On a timeout this resolves to the manual rung with detail 'dispatch timed
 * out' rather than rejecting, so callers can treat it exactly like any other fallthrough.
 */
export async function dispatch(opts: DispatchOpts, exec: ExecFileFn = defaultExec): Promise<DispatchResult> {
  const timeoutMs = opts.ladderTimeoutMs ?? LADDER_TIMEOUT_MS
  const settledRef: SettledRef = { settled: false }
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<DispatchResult>((resolve) => {
    timer = setTimeout(() => {
      // The caller is about to get 'manual' back — from this instant on, the still-running
      // ladder (if any adapter is mid-flight) must never proceed to a mutating exec call.
      settledRef.settled = true
      resolve({ rung: 'manual', detail: 'dispatch timed out' })
    }, timeoutMs)
  })

  try {
    return await Promise.race([runLadder(opts, exec, settledRef), timeout])
  } finally {
    clearTimeout(timer!)
  }
}

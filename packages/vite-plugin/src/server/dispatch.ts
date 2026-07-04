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
}

export type ExecFileFn = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string }>

const EXEC_TIMEOUT_MS = 2000
const DEEPLINK_MAX_ENCODED_LENGTH = 6000

/** Default ExecFileFn — always invoked as an argv array (execFile), NEVER a shell string.
 * This is the only place real child processes are spawned; every adapter below takes its
 * exec function as a parameter so tests can inject a fake and assert exact argv with zero
 * real tmux/osascript/open invocations. */
const defaultExec: ExecFileFn = (cmd, args, opts) =>
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

/** tmux adapter: finds the first pane whose current command matches `paneCommand` exactly and
 * sends the literal `/design` + Enter into it. Any failure (missing tmux binary, no server
 * running, no matching pane, send-keys failing) resolves to null so the caller falls through
 * to the next rung — this adapter never throws. */
async function tryTmux(paneCommand: 'claude' | 'codex', exec: ExecFileFn): Promise<DispatchResult | null> {
  let stdout: string
  try {
    ;({ stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_current_command}'], {
      timeout: EXEC_TIMEOUT_MS,
    }))
  } catch {
    return null
  }

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

  try {
    await exec('tmux', ['send-keys', '-t', paneId, DESIGN_COMMAND, 'Enter'], { timeout: EXEC_TIMEOUT_MS })
  } catch {
    return null
  }

  return { rung: 'tmux', detail: `typed /design into tmux pane ${paneId}` }
}

/** Best-effort AppleScript scripts — CONSTANTS, zero interpolation of any dynamic content
 * (request markdown never appears here; only the literal /design command). Tries iTerm2 first,
 * then Terminal.app. A denied automation permission, the app not running, or any other osascript
 * failure moves on to the next app / next rung — never throws. */
const ITERM_SCRIPT = `
tell application "System Events"
  if not (exists process "iTerm2") then error "iTerm2 not running"
end tell
tell application "iTerm2" to activate
tell application "System Events"
  tell process "iTerm2"
    keystroke "/design"
    keystroke return
  end tell
end tell
`

const TERMINAL_SCRIPT = `
tell application "System Events"
  if not (exists process "Terminal") then error "Terminal not running"
end tell
tell application "Terminal" to activate
tell application "System Events"
  tell process "Terminal"
    keystroke "/design"
    keystroke return
  end tell
end tell
`

async function tryAppleScript(platform: NodeJS.Platform, exec: ExecFileFn): Promise<DispatchResult | null> {
  if (platform !== 'darwin') return null

  for (const [appName, script] of [
    ['iTerm2', ITERM_SCRIPT],
    ['Terminal', TERMINAL_SCRIPT],
  ] as const) {
    try {
      await exec('osascript', ['-e', script], { timeout: EXEC_TIMEOUT_MS })
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
async function tryDeeplink(markdown: string, exec: ExecFileFn): Promise<DispatchResult | null> {
  const encoded = encodeURIComponent(markdown)
  if (encoded.length > DEEPLINK_MAX_ENCODED_LENGTH) return null

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

/**
 * Runs the dispatch ladder for the configured agent and returns the rung that succeeded (or
 * 'manual' if every automated rung fell through). NEVER spawns an agent CLI with an API key and
 * NEVER touches the Agent SDK — this only reaches for the user's already-RUNNING session via
 * tmux send-keys, AppleScript keystrokes, or (cursor) a deeplink. The only text ever typed into
 * a terminal is the literal `/design` + Enter; request content only ever travels (URL-encoded)
 * through the Cursor deeplink.
 */
export async function dispatch(opts: DispatchOpts, exec: ExecFileFn = defaultExec): Promise<DispatchResult> {
  const platform = opts.platform ?? process.platform
  const cwd = opts.cwd ?? process.cwd()

  if (opts.agent === 'cursor') {
    const deeplink = await tryDeeplink(opts.markdown, exec)
    if (deeplink) return deeplink
    return { rung: 'manual', detail: 'deeplink unavailable — type /design in Cursor' }
  }

  const paneCommand = opts.agent === 'codex' ? 'codex' : 'claude'

  if (opts.agent === 'claude-code' && opts.channelsFlag) {
    const channels = await tryChannels(cwd)
    if (channels) return channels
  }

  const tmuxResult = await tryTmux(paneCommand, exec)
  if (tmuxResult) return tmuxResult

  const appleScriptResult = await tryAppleScript(platform, exec)
  if (appleScriptResult) return appleScriptResult

  return { rung: 'manual', detail: `type /design in ${opts.agent === 'codex' ? 'Codex' : 'Claude Code'}` }
}

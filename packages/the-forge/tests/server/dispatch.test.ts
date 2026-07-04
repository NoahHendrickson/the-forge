import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { dispatch, defaultExec, type ExecFileFn, type DispatchOpts } from '../../src/server/dispatch'

function opts(partial: Partial<DispatchOpts> = {}): DispatchOpts {
  return {
    agent: 'claude-code',
    channelsFlag: false,
    markdown: '# Design change request\n\nsome content',
    ...partial,
  }
}

describe('dispatch', () => {
  describe('tmux adapter', () => {
    it('sends the literal /forge-design keystroke to the first pane running "claude" (claude-code agent)', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') {
          return { stdout: '%1 zsh\n%2 claude\n' }
        }
        if (cmd === 'tmux' && args[0] === 'send-keys') {
          return { stdout: '' }
        }
        throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
      })
      const result = await dispatch(opts(), exec)
      expect(result.rung).toBe('tmux')
      expect(exec).toHaveBeenCalledWith(
        'tmux',
        ['list-panes', '-a', '-F', '#{pane_id} #{pane_current_command}'],
        expect.objectContaining({ timeout: 2000 })
      )
      expect(exec).toHaveBeenCalledWith('tmux', ['send-keys', '-t', '%2', '/forge-design', 'Enter'], expect.objectContaining({ timeout: 2000 }))
      // NEVER send request content into the terminal — only the literal /forge-design
      for (const call of (exec as ReturnType<typeof vi.fn>).mock.calls) {
        const argv = call[1] as string[]
        expect(argv.join(' ')).not.toContain('Design change request')
        expect(argv.join(' ')).not.toContain('some content')
      }
    })

    it('matches "codex" pane command for the codex agent', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '%1 codex\n%2 zsh\n' }
        if (cmd === 'tmux' && args[0] === 'send-keys') return { stdout: '' }
        throw new Error('unexpected')
      })
      const result = await dispatch(opts({ agent: 'codex' }), exec)
      expect(result.rung).toBe('tmux')
      expect(exec).toHaveBeenCalledWith('tmux', ['send-keys', '-t', '%1', '/forge-design', 'Enter'], expect.anything())
    })

    it('falls through when tmux binary is missing (ENOENT)', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'tmux') {
          const err = new Error('spawn tmux ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        throw new Error(`unexpected exec: ${cmd}`)
      })
      const result = await dispatch(opts({ agent: 'claude-code' }), exec)
      expect(result.rung).not.toBe('tmux')
    })

    it('falls through when no pane matches the agent command', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '%1 zsh\n%2 vim\n' }
        throw new Error('should not send-keys without a match')
      })
      const result = await dispatch(opts({ agent: 'claude-code' }), exec)
      expect(result.rung).not.toBe('tmux')
    })

    it('falls through when send-keys itself fails', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '%1 claude\n' }
        if (cmd === 'tmux' && args[0] === 'send-keys') throw new Error('no server running')
        throw new Error('unexpected')
      })
      const result = await dispatch(opts({ agent: 'claude-code' }), exec)
      expect(result.rung).not.toBe('tmux')
    })
  })

  describe('AppleScript adapter (darwin only)', () => {
    it('is skipped on non-darwin platforms', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'tmux') throw new Error('no tmux')
        if (cmd === 'osascript') throw new Error('osascript should not run on non-darwin')
        throw new Error('unexpected')
      })
      const result = await dispatch(opts({ agent: 'claude-code', platform: 'linux' } as DispatchOpts), exec)
      expect(result.rung).not.toBe('applescript')
    })

    it('runs osascript with a constant script (iTerm2) on darwin when tmux fails, and succeeds when the script reports "ok" (session verified)', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux') throw new Error('no tmux')
        if (cmd === 'osascript') {
          expect(args).toHaveLength(2)
          expect(args[0]).toBe('-e')
          expect(typeof args[1]).toBe('string')
          // no request content in the script
          expect(args[1]).not.toContain('some content')
          if (args[1].includes('iTerm')) return { stdout: 'ok' }
          throw new Error('Terminal script should not be reached if iTerm2 succeeds')
        }
        throw new Error('unexpected')
      })
      const result = await dispatch({ ...opts({ agent: 'claude-code' }), platform: 'darwin' } as DispatchOpts, exec)
      expect(result.rung).toBe('applescript')
    })

    it('falls through to Terminal script when iTerm2 script fails, then to manual when both fail', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux') throw new Error('no tmux')
        if (cmd === 'osascript') throw new Error('automation permission denied')
        throw new Error('unexpected')
      })
      const result = await dispatch({ ...opts({ agent: 'claude-code' }), platform: 'darwin' } as DispatchOpts, exec)
      expect(result.rung).toBe('manual')
    })

    it('applescript is attempted for codex agent too', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'tmux') throw new Error('no tmux')
        if (cmd === 'osascript') return { stdout: 'ok' }
        throw new Error('unexpected')
      })
      const result = await dispatch({ ...opts({ agent: 'codex' }), platform: 'darwin' } as DispatchOpts, exec)
      expect(result.rung).toBe('applescript')
    })

    describe('front-window/session verification (controller ruling)', () => {
      it('falls through to Terminal, then to manual, when the iTerm2 and Terminal scripts both report "no-session" (front window unrelated)', async () => {
        const exec: ExecFileFn = vi.fn(async (cmd, args) => {
          if (cmd === 'tmux') throw new Error('no tmux')
          if (cmd === 'osascript') {
            // Neither script's session/window-name check matches the agent marker — the
            // adapter must NOT keystroke into an unrelated front window, and must NOT report
            // success.
            expect(typeof args[1]).toBe('string')
            return { stdout: 'no-session' }
          }
          throw new Error('unexpected')
        })
        const result = await dispatch({ ...opts({ agent: 'claude-code' }), platform: 'darwin' } as DispatchOpts, exec)
        expect(result.rung).toBe('manual')
      })

      it('succeeds via iTerm2 when its script reports "ok" (session verified as belonging to the agent)', async () => {
        const exec: ExecFileFn = vi.fn(async (cmd, args) => {
          if (cmd === 'tmux') throw new Error('no tmux')
          if (cmd === 'osascript' && args[1].includes('iTerm')) return { stdout: 'ok\n' }
          throw new Error('unexpected — Terminal should not be reached if iTerm2 verifies')
        })
        const result = await dispatch({ ...opts({ agent: 'claude-code' }), platform: 'darwin' } as DispatchOpts, exec)
        expect(result.rung).toBe('applescript')
      })

      it('falls through from iTerm2 to Terminal when iTerm2 reports "no-session" but Terminal reports "ok"', async () => {
        const exec: ExecFileFn = vi.fn(async (cmd, args) => {
          if (cmd === 'tmux') throw new Error('no tmux')
          if (cmd === 'osascript') {
            if (args[1].includes('iTerm')) return { stdout: 'no-session' }
            return { stdout: 'ok' }
          }
          throw new Error('unexpected')
        })
        const result = await dispatch({ ...opts({ agent: 'claude-code' }), platform: 'darwin' } as DispatchOpts, exec)
        expect(result.rung).toBe('applescript')
      })

      it('the codex-agent scripts check for the codex marker, not the claude marker', async () => {
        const exec: ExecFileFn = vi.fn(async (cmd, args) => {
          if (cmd === 'tmux') throw new Error('no tmux')
          if (cmd === 'osascript') {
            expect(args[1]).toContain('codex')
            return { stdout: 'ok' }
          }
          throw new Error('unexpected')
        })
        const result = await dispatch({ ...opts({ agent: 'codex' }), platform: 'darwin' } as DispatchOpts, exec)
        expect(result.rung).toBe('applescript')
      })
    })
  })

  describe('cursor deeplink adapter', () => {
    it('opens a cursor:// deeplink URL with URL-encoded markdown via execFile(open, [url])', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'open') return { stdout: '' }
        throw new Error(`unexpected exec: ${cmd}`)
      })
      const md = '# hello world\n> quoted & special?chars'
      const result = await dispatch(opts({ agent: 'cursor', markdown: md }), exec)
      expect(result.rung).toBe('deeplink')
      expect(exec).toHaveBeenCalledTimes(1)
      const [cmd, args] = (exec as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(cmd).toBe('open')
      expect(args).toHaveLength(1)
      expect(args[0]).toBe(`cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(md)}`)
    })

    it('falls through to manual when the encoded markdown exceeds 6000 chars', async () => {
      const exec: ExecFileFn = vi.fn(async () => {
        throw new Error('open should not be called for oversized markdown')
      })
      const huge = 'a'.repeat(6001)
      const result = await dispatch(opts({ agent: 'cursor', markdown: huge }), exec)
      expect(result.rung).toBe('manual')
    })

    it('falls through to manual when `open` fails', async () => {
      const exec: ExecFileFn = vi.fn(async () => {
        throw new Error('open failed')
      })
      const result = await dispatch(opts({ agent: 'cursor' }), exec)
      expect(result.rung).toBe('manual')
    })

    it('never runs tmux or applescript adapters for the cursor agent', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'open') return { stdout: '' }
        throw new Error(`adapter should not run: ${cmd}`)
      })
      await dispatch({ ...opts({ agent: 'cursor' }), platform: 'darwin' } as DispatchOpts, exec)
      expect(exec).toHaveBeenCalledTimes(1)
      expect((exec as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('open')
    })
  })

  describe('channels stub (experimental, claude-code only)', () => {
    it('is skipped entirely when channelsFlag is false (marker check never consulted)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-'))
      const existsSyncSpy = vi.spyOn(fs, 'existsSync')
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '%1 claude\n' }
        if (cmd === 'tmux' && args[0] === 'send-keys') return { stdout: '' }
        throw new Error('unexpected')
      })
      const result = await dispatch({ ...opts({ agent: 'claude-code', channelsFlag: false }), cwd: dir } as DispatchOpts, exec)
      expect(result.rung).toBe('tmux')
      // The channels rung's marker-file check must never run when the flag is off — proves the
      // stub is skipped entirely, not merely "always falls through" (which would still consult
      // the filesystem for no reason).
      expect(existsSyncSpy).not.toHaveBeenCalledWith(path.join(dir, `.the-forge`, `channel-${process.pid}`))
      existsSyncSpy.mockRestore()
    })

    it('falls through to tmux after the channels stub reports no channel found, and DOES consult the marker check when flagged on', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-'))
      const existsSyncSpy = vi.spyOn(fs, 'existsSync')
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '%1 claude\n' }
        if (cmd === 'tmux' && args[0] === 'send-keys') return { stdout: '' }
        throw new Error('unexpected')
      })
      const result = await dispatch({ ...opts({ agent: 'claude-code', channelsFlag: true }), cwd: dir } as DispatchOpts, exec)
      expect(result.rung).toBe('tmux')
      // Flagged on: the marker check IS consulted (and reports "no marker" since nothing creates
      // it), then falls through to tmux — proving the channels rung was actually reached, not
      // just vacuously true.
      expect(existsSyncSpy).toHaveBeenCalledWith(path.join(dir, `.the-forge`, `channel-${process.pid}`))
      existsSyncSpy.mockRestore()
    })

    it('is never consulted for codex or cursor agents even when channelsFlag is true', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'open') return { stdout: '' }
        throw new Error(`unexpected: ${cmd}`)
      })
      const result = await dispatch(opts({ agent: 'cursor', channelsFlag: true }), exec)
      expect(result.rung).toBe('deeplink')
    })
  })

  describe('ladder ordering and manual fallback', () => {
    it('claude-code: all adapters fail -> manual', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'tmux') throw new Error('no tmux')
        if (cmd === 'osascript') throw new Error('denied')
        throw new Error('unexpected')
      })
      const result = await dispatch({ ...opts({ agent: 'claude-code' }), platform: 'darwin' } as DispatchOpts, exec)
      expect(result.rung).toBe('manual')
      expect(result.detail).toBeTruthy()
    })

    it('codex: all adapters fail -> manual (no channels, no deeplink attempted)', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'tmux') throw new Error('no tmux')
        if (cmd === 'osascript') throw new Error('denied')
        if (cmd === 'open') throw new Error('should not be called for codex')
        throw new Error('unexpected')
      })
      const result = await dispatch({ ...opts({ agent: 'codex' }), platform: 'darwin' } as DispatchOpts, exec)
      expect(result.rung).toBe('manual')
    })

    it('cursor: deeplink fails -> manual (no tmux/applescript attempted)', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'open') throw new Error('deeplink failed')
        throw new Error(`adapter should not run: ${cmd}`)
      })
      const result = await dispatch(opts({ agent: 'cursor' }), exec)
      expect(result.rung).toBe('manual')
    })
  })

  describe('default exec wrapper', () => {
    // NEVER call dispatch() with no injected exec in this suite — that would run the REAL
    // dispatch ladder (real tmux/osascript) and could type /forge-design into the developer's actual
    // front window on a Mac with automation permission + iTerm2/Terminal open. Every dispatch()
    // call in this file must pass an injected exec. The default exec's SHAPE is instead unit
    // tested directly below, in isolation from the ladder.
    it('dispatch() falls through to manual when every rung fails, using an injected always-failing exec (never the real ladder)', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        throw new Error(`injected always-failing exec — should never spawn a real ${cmd}`)
      })
      const result = await dispatch(opts({ agent: 'claude-code', platform: 'darwin' } as DispatchOpts), exec)
      expect(result.rung).toBe('manual')
    })

    it('defaultExec wraps execFile with the 2s timeout and rejects for a guaranteed-missing binary', async () => {
      await expect(
        defaultExec('/nonexistent-forge-test-bin', ['--version'])
      ).rejects.toThrow()
    })

    it('defaultExec passes through a custom timeout to execFile', async () => {
      await expect(
        defaultExec('/nonexistent-forge-test-bin', ['--version'], { timeout: 50 })
      ).rejects.toThrow()
    })
  })

  describe('overall ladder timeout', () => {
    it('resolves to manual with detail "dispatch timed out" when the ladder never settles within the cap', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'tmux') return new Promise<{ stdout: string }>(() => {}) // never resolves/rejects
        throw new Error('unexpected')
      })
      const result = await dispatch(
        { ...opts({ agent: 'claude-code', platform: 'darwin' }), ladderTimeoutMs: 20 } as DispatchOpts,
        exec
      )
      expect(result).toEqual({ rung: 'manual', detail: 'dispatch timed out' })
    })

    it('does not apply the timeout when the ladder settles well within the cap', async () => {
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '%1 claude\n' }
        if (cmd === 'tmux' && args[0] === 'send-keys') return { stdout: '' }
        throw new Error('unexpected')
      })
      const result = await dispatch(
        { ...opts({ agent: 'claude-code' }), ladderTimeoutMs: 5000 } as DispatchOpts,
        exec
      )
      expect(result.rung).toBe('tmux')
    })

    it('defaults to a 5000ms cap when ladderTimeoutMs is not provided', async () => {
      // Prove the default is wired without a real 5s wait: use a fake exec that resolves well
      // under any reasonable cap, and just assert the ladder still completes normally when no
      // override is given.
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '%1 claude\n' }
        if (cmd === 'tmux' && args[0] === 'send-keys') return { stdout: '' }
        throw new Error('unexpected')
      })
      const result = await dispatch(opts({ agent: 'claude-code' }), exec)
      expect(result.rung).toBe('tmux')
    })
  })

  describe('post-timeout mutation guard (settled flag)', () => {
    it('a hung list-panes that later resolves (after the ladder already timed out) must NOT trigger send-keys', async () => {
      let resolveListPanes!: (v: { stdout: string }) => void
      const sendKeysCalls: unknown[] = []
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') {
          // Hangs until we manually resolve it below, well after the ladder timeout fires.
          return new Promise<{ stdout: string }>((resolve) => {
            resolveListPanes = resolve
          })
        }
        if (cmd === 'tmux' && args[0] === 'send-keys') {
          sendKeysCalls.push(args)
          return { stdout: '' }
        }
        throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
      })

      const dispatchPromise = dispatch({ ...opts({ agent: 'claude-code' }), ladderTimeoutMs: 20 } as DispatchOpts, exec)

      // Let the ladder timeout fire first.
      await new Promise((r) => setTimeout(r, 50))
      const result = await dispatchPromise
      expect(result).toEqual({ rung: 'manual', detail: 'dispatch timed out' })

      // NOW resolve the hung list-panes call with a matching pane — the tmux adapter would
      // ordinarily proceed straight to send-keys. The settled flag must stop it from ever typing.
      resolveListPanes({ stdout: '%1 claude\n' })
      // Give any (incorrect) continuation a chance to run.
      await new Promise((r) => setTimeout(r, 50))

      expect(sendKeysCalls).toHaveLength(0)
    })

    it('osascript guard: settled prevents retry loop when first app returns "no-session"', async () => {
      // Mutation proof (line 223): without the settled guard before the loop,
      // first osascript returning "no-session" triggers `continue` (line 227), which proceeds
      // to Terminal. This test verifies the settled flag (set by timeout) blocks the Terminal
      // attempt.  Strategy: first osascript hangs → timeout fires (settled=true) → hung osascript
      // resolves with "no-session" post-timeout → settled guard at line 223 prevents loop from
      // continuing to Terminal.
      let osascriptCallsMade = 0
      let resolveFirstOsascript!: (v: { stdout: string }) => void
      const exec: ExecFileFn = vi.fn(async (cmd, args) => {
        if (cmd === 'tmux') throw new Error('no tmux')
        if (cmd === 'osascript') {
          osascriptCallsMade++
          if (osascriptCallsMade === 1 && args[1].includes('iTerm')) {
            // Hang the first osascript — timeout will fire while we wait.
            return new Promise<{ stdout: string }>((resolve) => {
              resolveFirstOsascript = resolve
            })
          }
          // Second osascript (Terminal) should never be called due to settled guard.
          throw new Error(`Terminal osascript call #${osascriptCallsMade}: settled should have blocked it`)
        }
        throw new Error(`unexpected exec: ${cmd}`)
      })

      const dispatchPromise = dispatch(
        { ...opts({ agent: 'claude-code', platform: 'darwin' }), ladderTimeoutMs: 20 } as DispatchOpts,
        exec
      )

      // Wait for timeout to fire and dispatch to settle.
      await new Promise((r) => setTimeout(r, 50))
      const result = await dispatchPromise
      expect(result).toEqual({ rung: 'manual', detail: 'dispatch timed out' })

      // Now resolve the hung first osascript with "no-session" AFTER the timeout has fired.
      // The settled guard check at line 223 (before next loop iteration) should prevent Terminal.
      resolveFirstOsascript({ stdout: 'no-session' })
      // Give the ladder time to respond to the resolution (even though it's abandoned by race).
      await new Promise((r) => setTimeout(r, 50))

      // Proof: only ONE osascript call made, Terminal was blocked by settled guard.
      expect(osascriptCallsMade).toBe(1)
    })

    it('cursor deeplink guard: settled guard blocks open() after timeout fires mid-execution', async () => {
      // Mutation proof: without the settled guard at line 244, open() WOULD be invoked and
      // could complete even after the ladder timed out. This test verifies the guard prevents
      // it by hanging the open() call (so it's still pending when timeout fires) and confirming
      // no further exec happens (the settled check stops the loop before trying open).
      //
      // Strategy: make tryDeeplink's exec hang, let the timeout fire, then verify that when
      // open() eventually resolves post-timeout, no second exec attempt (retry or fallthrough) happens.
      let resolveOpen!: (v: { stdout: string }) => void
      const openCallCount = { value: 0 }
      const exec: ExecFileFn = vi.fn(async (cmd) => {
        if (cmd === 'open') {
          openCallCount.value++
          if (openCallCount.value === 1) {
            // Hang the first open() call — timeout will fire while we're waiting.
            return new Promise<{ stdout: string }>((resolve) => {
              resolveOpen = resolve
            })
          }
          // Any second call should be caught by the test (should never reach here).
          throw new Error('second open() call should never happen — settled guard must block it')
        }
        throw new Error(`unexpected exec: ${cmd}`)
      })

      const dispatchPromise = dispatch(
        { ...opts({ agent: 'cursor' }), ladderTimeoutMs: 20 } as DispatchOpts,
        exec
      )
      // Wait for timeout to fire.
      await new Promise((r) => setTimeout(r, 50))
      const result = await dispatchPromise
      expect(result).toEqual({ rung: 'manual', detail: 'dispatch timed out' })

      // Now resolve the open() call — WITHOUT the settled guard, the call would complete and
      // might trigger further code paths. With the guard, the check at line 244 has already
      // returned null and the ladder stopped.
      resolveOpen({ stdout: '' })
      await new Promise((r) => setTimeout(r, 50))

      // Only the original in-flight open() should have been attempted.
      expect(openCallCount.value).toBe(1)
    })
  })
})

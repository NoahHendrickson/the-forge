import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setupProjectConfig } from '../../src/server/setup'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-'))
})

describe('setupProjectConfig', () => {
  it('creates .mcp.json and the /design command from scratch', () => {
    setupProjectConfig(root, '/abs/dist/mcp.js')
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers['the-forge']).toEqual({ command: 'node', args: ['/abs/dist/mcp.js'] })
    const cmd = fs.readFileSync(path.join(root, '.claude', 'commands', 'design.md'), 'utf8')
    expect(cmd).toContain('pull_design_edits')
    expect(cmd).toContain('mark_applied')
  })

  it('preserves existing .mcp.json entries and is idempotent', () => {
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } })
    )
    setupProjectConfig(root, '/abs/dist/mcp.js')
    setupProjectConfig(root, '/abs/dist/mcp.js') // second run: no-op
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.other).toEqual({ command: 'x' })
    expect(mcp.mcpServers['the-forge'].args).toEqual(['/abs/dist/mcp.js'])
  })

  it('does not rewrite an identical command file', () => {
    setupProjectConfig(root, '/abs/dist/mcp.js')
    const file = path.join(root, '.claude', 'commands', 'design.md')
    const before = fs.statSync(file).mtimeMs
    setupProjectConfig(root, '/abs/dist/mcp.js')
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  describe('malformed .mcp.json', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('leaves an existing malformed .mcp.json byte-identical and still creates design.md', () => {
      const mcpFile = path.join(root, '.mcp.json')
      const original = '{invalid'
      fs.writeFileSync(mcpFile, original)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      setupProjectConfig(root, '/abs/dist/mcp.js')

      expect(fs.readFileSync(mcpFile, 'utf8')).toBe(original)
      const cmd = fs.readFileSync(path.join(root, '.claude', 'commands', 'design.md'), 'utf8')
      expect(cmd).toContain('pull_design_edits')
      expect(warnSpy).toHaveBeenCalledWith(
        '[the-forge] .mcp.json exists but is not valid JSON — skipping MCP registration'
      )
    })
  })
})

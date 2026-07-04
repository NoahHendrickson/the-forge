import fs from 'node:fs'
import path from 'node:path'

const DESIGN_COMMAND = `Pull pending design edits from The Forge and apply them.

1. Call the \`pull_design_edits\` tool from the \`the-forge\` MCP server.
2. For each returned change request, apply the edits EXACTLY as its markdown specifies (file:line locations, before → after values, authored utility changes). Do not restyle anything else.
3. After applying all edits, call \`mark_applied\` with each request id and status "applied" (or "failed" with a one-line reason if a change could not be applied).
`

export function setupProjectConfig(root: string, mcpBinPath: string): void {
  // .mcp.json — additive merge. Distinguish "file doesn't exist" (proceed with {})
  // from "file exists but isn't valid JSON" (skip the write entirely — clobbering a
  // user's malformed-but-intentional file would destroy whatever they were mid-edit on).
  const mcpFile = path.join(root, '.mcp.json')
  let raw: string | null = null
  try {
    raw = fs.readFileSync(mcpFile, 'utf8')
  } catch {
    raw = null
  }

  let config: { mcpServers?: Record<string, unknown> } | null = null
  if (raw === null) {
    config = {}
  } else {
    try {
      config = JSON.parse(raw)
    } catch {
      console.warn('[the-forge] .mcp.json exists but is not valid JSON — skipping MCP registration')
      config = null
    }
  }

  if (config) {
    const servers = (config.mcpServers ??= {})
    const desired = { command: 'node', args: [mcpBinPath] }
    if (JSON.stringify(servers['the-forge']) !== JSON.stringify(desired)) {
      servers['the-forge'] = desired
      fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2) + '\n')
    }
  }

  // /design command — write only when missing or different
  const cmdFile = path.join(root, '.claude', 'commands', 'design.md')
  let current: string | null = null
  try {
    current = fs.readFileSync(cmdFile, 'utf8')
  } catch {
    current = null
  }
  if (current !== DESIGN_COMMAND) {
    fs.mkdirSync(path.dirname(cmdFile), { recursive: true })
    fs.writeFileSync(cmdFile, DESIGN_COMMAND)
  }
}

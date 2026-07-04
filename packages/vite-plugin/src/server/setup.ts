import fs from 'node:fs'
import path from 'node:path'

const DESIGN_COMMAND = `Pull pending design edits from The Forge and apply them.

1. Call the \`pull_design_edits\` tool from the \`the-forge\` MCP server.
2. For each returned change request, apply the edits EXACTLY as its markdown specifies (file:line locations, before → after values, authored utility changes). Do not restyle anything else.
3. After applying all edits, call \`mark_applied\` with each request id and status "applied" (or "failed" with a one-line reason if a change could not be applied).
`

export function setupProjectConfig(root: string, mcpBinPath: string): void {
  // .mcp.json — additive merge
  const mcpFile = path.join(root, '.mcp.json')
  let config: { mcpServers?: Record<string, unknown> } = {}
  try {
    config = JSON.parse(fs.readFileSync(mcpFile, 'utf8'))
  } catch {
    config = {}
  }
  const servers = (config.mcpServers ??= {})
  const desired = { command: 'node', args: [mcpBinPath] }
  if (JSON.stringify(servers['the-forge']) !== JSON.stringify(desired)) {
    servers['the-forge'] = desired
    fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2) + '\n')
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

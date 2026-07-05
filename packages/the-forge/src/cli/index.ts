// Stub for the `the-forge` bin (publish-readiness milestone, task A1). The real `init`
// command — AST-based config edits behind the conservative-fallback rule — lands in a
// later task. Until then this only prints help and never touches disk: bare `npx
// the-forge` prints help, never acts (global constraint), and `init` fails loudly rather
// than silently doing nothing useful.
//
// Dependency-free by design (zero new runtime dependencies is a headline package
// feature) — plain process.argv/console, no commander/prompts/chalk.

const HELP = `the-forge
usage: npx the-forge init

Figma-style design mode for your running Vite or Next.js app.
Docs: https://github.com/NoahHendrickson/the-forge#readme`

function main(argv: string[]): void {
  const command = argv[2]

  if (command === 'init') {
    console.error('init: not implemented yet')
    process.exit(1)
    return
  }

  console.log(HELP)
  process.exit(0)
}

main(process.argv)

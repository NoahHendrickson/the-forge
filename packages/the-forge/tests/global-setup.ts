import { execSync } from 'node:child_process'

// Build dist/ exactly once, before any vitest worker spawns. This is the ONLY place the
// test suite may build (or delete) dist/ — the build script starts with `rm -rf dist`
// (deliberate, see the dts-race why-comment in tsup.config.ts), so any test-file-level
// build races every parallel worker that reads dist/ artifacts. Two files used to build
// from beforeAll hooks (plugin-load unconditionally, design-mode if-missing), which made
// the root gate flake ~40% of runs: design-mode's check-then-read saw a stale dist, skipped
// its build, and read mid-`rm -rf` from plugin-load's worker (ERR_MODULE_NOT_FOUND).
// globalSetup runs to completion before workers exist, so the window is structurally gone —
// and every vitest invocation (single-file runs, fresh worktrees) now gets a fresh build
// instead of depending on scheduling luck to have plugin-load build first.
export default function buildOnce(): void {
  execSync('npm run build', { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' })
}

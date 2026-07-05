import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { 'import.meta.vitest': 'true' },
  test: {
    include: ['tests/**/*.test.ts'],
    // Fresh dist/ built exactly once before any worker spawns — see tests/global-setup.ts
    // for why no test file may run `npm run build` itself.
    globalSetup: ['tests/global-setup.ts'],
  },
})

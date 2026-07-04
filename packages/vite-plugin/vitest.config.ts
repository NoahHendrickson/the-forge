import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { 'import.meta.vitest': 'true' },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})

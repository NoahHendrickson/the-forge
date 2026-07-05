import type { Preview } from '@storybook/html-vite'

// Token/type stories render light-on-dark overlay colors; Storybook's default
// light canvas makes them unreadable. Default the canvas to dark.
export default {
  parameters: {
    backgrounds: {
      default: 'dark',
      options: { dark: { name: 'dark', value: '#1E1E1E' } },
    },
  },
  initialGlobals: {
    backgrounds: { value: 'dark' },
  },
} satisfies Preview

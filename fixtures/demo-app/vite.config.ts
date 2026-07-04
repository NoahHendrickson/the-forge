import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { designCompanion } from '@design-companion/vite'

export default defineConfig({
  plugins: [designCompanion(), react(), tailwindcss()],
})

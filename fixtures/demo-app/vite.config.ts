import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { theForge } from 'forge-mode/vite'

export default defineConfig({
  plugins: [theForge(), react(), tailwindcss()],
})

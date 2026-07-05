import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { theForge } from 'the-forge/vite'

export default defineConfig({
  plugins: [theForge(), react(), tailwindcss()],
})

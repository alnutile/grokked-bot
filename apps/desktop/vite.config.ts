import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1425, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: 'chrome110', sourcemap: false },
})

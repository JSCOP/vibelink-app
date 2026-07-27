import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Ignore every Cargo target variant, including agent/test-specific target-* dirs.
      ignored: ['**/src-tauri/target*/**'],
    },
  },
})

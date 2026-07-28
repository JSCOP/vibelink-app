import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const configuredDevPort = Number.parseInt(process.env.VIBELINK_DEV_VITE_PORT ?? '1420', 10)
const devPort = Number.isInteger(configuredDevPort) && configuredDevPort >= 1420 && configuredDevPort <= 1439
  ? configuredDevPort
  : 1420

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: devPort,
    strictPort: true,
    watch: {
      // Ignore every Cargo target variant, including agent/test-specific target-* dirs.
      ignored: ['**/src-tauri/target*/**'],
    },
  },
})

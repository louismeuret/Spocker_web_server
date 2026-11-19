import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Plotly is only imported from a lazy() chunk, so Vite discovers it late
  // and re-optimizes mid-session -> two React copies -> "Invalid hook call".
  // Pre-bundle it up front.
  optimizeDeps: {
    include: ['plotly.js-dist-min', 'react-plotly.js/factory'],
  },
  server: {
    allowedHosts: true,
    port: 5173,
    // Dev-only: forward API calls to the Flask backend so the frontend
    // can always just call same-origin `/api/...` paths, in dev and in
    // production (where Flask serves the built frontend itself) alike.
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Molstar is a big bundle but it's loaded via a plain <script> tag from
    // /public, not imported into the JS graph, so this doesn't affect it.
    chunkSizeWarningLimit: 1000,
  },
})

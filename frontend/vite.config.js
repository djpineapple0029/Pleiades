import { defineConfig } from 'vite'

// Build output lands in server/static/ so Flask can serve it directly.
export default defineConfig({
  base: '/pleiades/',
  build: {
    outDir: '../server/static',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5001',
      // Ctrl+E fetches the built viewer template. It is a build artefact in
      // server/static, not a source file Vite knows about, so dev has to reach
      // through to Flask for it the same way the API does.
      '/viewer-template.html': 'http://127.0.0.1:5001',
    },
  },
})

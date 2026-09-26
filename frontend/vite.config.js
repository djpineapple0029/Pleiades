import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Where /api goes in dev. The accounts e2e suite points it at a Flask of its
// own (playwright.accounts.config.js) so it never touches a dev backend.
const API = process.env.ATLASMAP_API || 'http://127.0.0.1:5001'
const page = (name) => fileURLToPath(new URL(name, import.meta.url))

// Build output lands in server/static/ so Flask can serve it directly.
export default defineConfig({
  // `/` for local runs (Flask serves the bundle at the root). The container
  // build sets ATLASMAP_BASE=/pleiades/ (see Dockerfile), since Caddy mounts
  // it under that prefix; baking the prefix in here broke every local build.
  base: process.env.ATLASMAP_BASE || '/',
  build: {
    outDir: '../server/static',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // The app, and the account shell (plain DOM, no WebGL) it hands over to.
      input: { index: page('index.html'), account: page('account.html') },
    },
  },
  server: {
    port: 5173,
    // keymap.js and settings.js import ../server/settings_schema.json, the
    // one list of settings the server validates against too.
    fs: { allow: ['.', '../server/settings_schema.json'] },
    proxy: {
      '/api': API,
      // Ctrl+E fetches the built viewer template. It is a build artefact in
      // server/static, not a source file Vite knows about, so dev has to reach
      // through to Flask for it the same way the API does.
      '/viewer-template.html': API,
      // The admin panel is Flask's own page, not part of this bundle.
      '/admin': API,
    },
  },
})

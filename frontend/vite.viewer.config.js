import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The second build: the read-only viewer that gets embedded in an exported
 * `.html` file. Output lands in `.viewer-build/`, which is scaffolding —
 * `scripts/build-viewer.mjs` then folds it into the single self-contained
 * `server/static/viewer-template.html` that `files.js` splices a map into.
 *
 * Everything here exists to make one file with nothing beside it: one chunk, no
 * code splitting, no preload tags, no sourcemap, and every asset inlined.
 */
export default defineConfig({
  // Nothing should be fetched by URL, but if anything slips through, a relative
  // reference at least fails visibly rather than reaching for a server's root.
  base: './',
  resolve: {
    alias: [
      {
        // `graph.js` imports `computeClusters` statically and hands it out as
        // `recluster()`, so it cannot be tree-shaken — and it drags graphology
        // and Louvain along, ~97 KB. The viewer's layout is frozen and never
        // re-partitions, so it gets the stub instead. Cluster *colours* are
        // unaffected: they come from `palette.js`, which has no dependencies.
        find: /^\.\/clustering\.js$/,
        replacement: resolve(here, 'src/clustering.stub.js'),
      },
    ],
  },
  build: {
    outDir: '.viewer-build',
    emptyOutDir: true,
    sourcemap: false,
    // One stylesheet, not one per chunk — there is only one chunk anyway.
    cssCodeSplit: false,
    // Nothing to preload in a file with no separate assets, and the tags would
    // point at paths that do not exist once everything is inlined.
    modulePreload: false,
    // Try to let Vite inline the fonts itself. It does not always oblige for
    // font files, so `build-viewer.mjs` inlines whatever is left over and fails
    // the build if any reference survives.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: resolve(here, 'viewer.html'),
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
})

/**
 * Stands in for `clustering.js` in the exported-viewer build only (see
 * `vite.viewer.config.js`).
 *
 * `graph.js` imports `computeClusters` statically and exposes it as
 * `recluster()`, so it cannot be tree-shaken — and it drags `graphology` plus
 * `graphology-communities-louvain` with it, about 97 KB of the bundle. The
 * viewer's layout is frozen: nothing in it ever calls Balance, so nothing ever
 * calls `recluster`. Aliasing the module away is what keeps that weight out of
 * every exported file.
 *
 * Cluster *colours* are unaffected — they are read from `palette.js`, which the
 * viewer imports for real, and their ids come from the payload.
 */

export function computeClusters() {
  // Unreachable by construction. If this ever throws, something in the viewer
  // has started trying to re-partition a map it is only supposed to display.
  throw new Error('clustering is not available in the viewer build')
}

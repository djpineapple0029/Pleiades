/**
 * WebGL context loss and restore (V2.md §2.5.2).
 *
 * Losing the context is routine: a driver reset, a MacBook switching GPUs,
 * sleep, the GPU process restarting. three handles both events itself: it
 * calls `preventDefault` so a restore can happen, skips every render while
 * the context is gone (the animation loop keeps running), and on restore
 * re-uploads everything that has a CPU-side source. What it can't bring
 * back is anything that only ever existed on the GPU (the baked nebula, the
 * label atlas); `onRestored` is where the caller rebuilds those.
 *
 * Register after the renderer exists, so three's own handlers run first.
 * Returns the remover. Never force a loss from an HMR dispose: the re-imported
 * module would get the same lost context back and never recover.
 */
export function watchContextLoss(canvas, { onLost, onRestored }) {
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  return () => {
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
  }
}

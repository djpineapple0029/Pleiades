/**
 * The one place that releases pointer lock on the app's own behalf and takes
 * it back afterwards (the start of V2.md §2.4.2's single lock service).
 *
 * Why it matters: after a script-initiated `exitPointerLock()`, the Pointer
 * Lock spec lets the page lock again with no fresh click, while a user's Esc
 * starts Chrome's re-lock cooldown and needs one. So a panel that released the
 * lock itself can hand it straight back when it closes, and the click-to-fly
 * overlay only needs to show for an unlock the user (or the browser) caused.
 *
 * Releases nest: a Save prompt inside an Open inside a dirty-map confirm each
 * call `release`/`resume` in pairs, and only the outermost `resume` re-locks —
 * otherwise the lock would flicker back on between two panels of one flow.
 * Must be created before anything else listens for `unlock`, so
 * `lastUnlockReason` is already set when those listeners run.
 */
export function createPointerLock(controls) {
  let depth = 0 // open release/resume pairs
  let resumable = false // the outermost release found the lock held
  let pendingReason = null
  let lastReason = 'manual'
  let disabled = false // rendering has stopped: never lock onto a dead scene

  function onUnlock() {
    lastReason = pendingReason ?? 'manual'
    pendingReason = null
  }
  controls.addEventListener('unlock', onUnlock)

  /**
   * `reason` is `'panel'` (a surface of ours takes over the screen, so nothing
   * else should show) or `'file'` (a native dialog; a small resume hint is
   * enough). Resolves once the `unlock` event has actually fired, so every
   * other unlock listener has run before the caller opens anything.
   */
  function release(reason) {
    depth++
    if (depth === 1) resumable = controls.isLocked
    if (!controls.isLocked) return Promise.resolve()
    return new Promise((resolve) => {
      pendingReason = reason
      controls.addEventListener('unlock', resolve, { once: true })
      controls.unlock()
    })
  }

  /** Pairs with `release`. Re-locks only if the outermost release unlocked. */
  function resume() {
    if (depth === 0) return
    if (disabled) {
      depth--
      return
    }
    depth--
    if (depth > 0 || !resumable) return
    resumable = false
    if (controls.isLocked) return
    const element = controls.domElement
    if (!element) return controls.lock()
    // Called directly, not via `controls.lock()`, to keep hold of the promise:
    // Chrome still refuses if something else (a download bubble, a lost
    // window focus) dropped the lock in between, and the rejection would
    // otherwise surface as an unhandled error. `pointerlockerror` fires as
    // well, and `main.js` shows its notice for that.
    element.requestPointerLock()?.catch?.(() => {})
  }

  /** For good: releases still pair up, but nothing re-locks afterwards. */
  function disable() {
    disabled = true
    resumable = false
  }

  function dispose() {
    controls.removeEventListener('unlock', onUnlock)
  }

  return {
    release,
    resume,
    disable,
    dispose,
    /** Why the last unlock happened: `'panel'`, `'file'`, or `'manual'` for
     *  Esc, a lost window focus, or anything else the app didn't ask for. */
    get lastUnlockReason() {
      return lastReason
    },
  }
}

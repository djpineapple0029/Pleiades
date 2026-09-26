/**
 * What the page shows when rendering can't go on (V2.md §2.4.3, §2.5.1, §2.5.2).
 *
 * Every failure here looked the same before: a frozen or inviting screen that
 * did nothing, so the user reloaded and lost a map that was still in memory.
 * Now each one says what happened on the click-to-fly overlay, with its prompt
 * and key list taken down so nothing invites a click into a dead scene.
 *
 * Shared by `main.js` and `viewer.js`, so it imports nothing: the viewer must
 * never pull in anything that edits or saves a map. The elements are passed in
 * rather than looked up, which also keeps this testable without a DOM.
 */

export const NO_WEBGL =
  'This map needs WebGL 2, which this browser has turned off or does not support. ' +
  'Enable hardware acceleration or try another browser.'

export const CONTEXT_LOST = 'Graphics were reset by the browser; restoring…'

const MAX_ERROR_TEXT = 160

/** An error's message, short enough for one notice line. Never a payload. */
export function errorText(error) {
  const text = (error?.message || String(error ?? 'unknown error')).trim()
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text
}

/**
 * `overlay` is `#overlay`; `prompt`, `keys` and `notice` are its three
 * children. `exitPointerLock` lets go of the mouse so the notice can be read
 * and a save panel used.
 */
export function createCrashGuard({ overlay, prompt, keys, notice, exitPointerLock = () => {} }) {
  let fatal = false
  // What a context-loss notice covered, to put back once it's over.
  let covered = null

  function showMessage(message) {
    prompt.hidden = true
    keys.hidden = true
    notice.textContent = message
    notice.hidden = false
    overlay.hidden = false
  }

  /** For good: the first message stays, whatever fails after it. */
  function showFatal(message) {
    if (fatal) return
    fatal = true
    covered = null
    showMessage(message)
    exitPointerLock()
  }

  /**
   * Wraps a `setAnimationLoop` callback. three schedules the next frame only
   * after the callback returns, so an uncaught throw used to end rendering
   * silently. This stops the loop on the first one instead of carrying on:
   * physics, view and interaction may each be half-way through a frame, and
   * what matters is getting the user to save, not drawing on regardless.
   */
  function guardFrame(renderer, frame, onFatal) {
    let stopped = false
    return (...args) => {
      if (stopped || fatal) return
      try {
        frame(...args)
      } catch (error) {
        stopped = true
        renderer.setAnimationLoop(null)
        console.error(error)
        onFatal(error)
      }
    }
  }

  /**
   * Reports errors thrown outside the frame loop (a file flow started from a
   * key and never awaited, a listener) to `report`, instead of only the
   * console. Once rendering has stopped the notice says enough, so they go to
   * the console alone. Returns the remover.
   */
  function installGlobalHandlers(report, target = window) {
    const onError = (event) => {
      if (!fatal) report(errorText(event.error ?? event.message))
    }
    const onRejection = (event) => {
      if (!fatal) report(errorText(event.reason))
    }
    target.addEventListener('error', onError)
    target.addEventListener('unhandledrejection', onRejection)
    return () => {
      target.removeEventListener('error', onError)
      target.removeEventListener('unhandledrejection', onRejection)
    }
  }

  /** Context lost: say so over whatever was showing, until `uncover`. */
  function cover(message) {
    if (fatal || covered) return
    covered = {
      overlay: overlay.hidden,
      prompt: prompt.hidden,
      keys: keys.hidden,
      notice: notice.hidden,
      text: notice.textContent,
    }
    showMessage(message)
  }

  function uncover() {
    if (fatal || !covered) return
    overlay.hidden = covered.overlay
    prompt.hidden = covered.prompt
    keys.hidden = covered.keys
    notice.hidden = covered.notice
    notice.textContent = covered.text
    covered = null
  }

  return {
    showFatal,
    guardFrame,
    installGlobalHandlers,
    cover,
    uncover,
    /** True once rendering has stopped for good. */
    get isFatal() {
      return fatal
    },
    /** A notice owns the overlay: nothing should take the lock or toggle it. */
    get isBlocking() {
      return fatal || covered !== null
    },
  }
}

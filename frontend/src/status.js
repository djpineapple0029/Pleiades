/**
 * The HUD's message channel, layered over a caller-supplied persistent state
 * line (mode/hover/counts/balance progress) rather than replacing it. Shared
 * verbatim between `interaction.js` and `viewerInteraction.js`, so the two
 * HUDs can never drift apart — the viewer simply never calls anything but
 * `setState`/`tick`, since it has no file flows to report on.
 */

const INFO_MS = 2500
const SUCCESS_MS = 4000

export function createStatus(el) {
  let stateText = ''
  let message = null // { text, kind: 'info' | 'success' | 'error' | 'busy', until: number | null }
  let renderedText = null
  let renderedError = false

  function setState(text) {
    stateText = text
  }

  function info(text) {
    // Info is the polite channel: it never interrupts an error the user
    // hasn't seen resolved, or an operation that's still actually running.
    if (message && (message.kind === 'error' || message.kind === 'busy')) return
    message = { text, kind: 'info', until: performance.now() + INFO_MS }
  }

  function success(text) {
    message = { text, kind: 'success', until: performance.now() + SUCCESS_MS }
  }

  /** Sticky until dismissed or superseded by the next success/error. */
  function error(text) {
    message = { text, kind: 'error', until: null }
  }

  /** No timer — pairs with `done()`, so a caller can show "still saving…"
   *  for as long as the operation actually takes. */
  function busy(text) {
    message = { text, kind: 'busy', until: null }
  }

  function done() {
    if (message?.kind === 'busy') message = null
  }

  function dismiss() {
    message = null
  }

  /** Call once per frame, after `setState()`. Expires the message, then
   *  writes the DOM only if the combined text or error styling changed. */
  function tick() {
    if (message && message.until !== null && performance.now() >= message.until) message = null

    const text = message ? `${stateText} · ${message.text}` : stateText
    if (text !== renderedText) {
      el.textContent = text
      renderedText = text
    }

    const isError = message?.kind === 'error'
    if (isError !== renderedError) {
      el.classList.toggle('hud--error', isError)
      el.classList.toggle('hud--wrap', isError)
      renderedError = isError
    }
  }

  return { setState, info, success, error, busy, done, dismiss, tick }
}

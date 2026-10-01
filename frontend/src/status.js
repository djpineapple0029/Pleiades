/**
 * The HUD's message channel, layered over a caller-supplied persistent state
 * line (mode/focus/balance progress) rather than replacing it. Shared
 * verbatim between `interaction.js` and `viewerInteraction.js`, so the two
 * HUDs can never drift apart — the viewer calls nothing but `setState`/`tick`
 * and, for an error thrown outside the frame loop, `error`: it has no file
 * flows to report on.
 *
 * The HUD stays quiet unless something needs doing or went wrong: only
 * `error` and `notice` are shown. `info`, `success` and `busy` still order
 * the channel (a success clears a stale error; busy holds off info) but are
 * written only to the element's `data-trace`, alongside the fuller state
 * line the caller passes — the readout the e2e suites and anyone debugging
 * read, never seen on screen.
 */

const INFO_MS = 2500
const SUCCESS_MS = 4000

const join = (...parts) => parts.filter(Boolean).join(' · ')

export function createStatus(el) {
  let stateText = ''
  let traceText = ''
  let message = null // { text, kind: 'info' | 'notice' | 'success' | 'error' | 'busy', until: number | null }
  let renderedText = null
  let renderedTrace = null
  let renderedError = false

  /** `text` is what the HUD shows; `trace` the fuller readout, if different. */
  function setState(text, trace = text) {
    stateText = text
    traceText = trace
  }

  function polite(text, kind) {
    // The polite channel never interrupts an error the user hasn't seen
    // resolved, or an operation that's still actually running.
    if (message && (message.kind === 'error' || message.kind === 'busy')) return
    message = { text, kind, until: performance.now() + INFO_MS }
  }

  /** Trace only: a result or toggle the screen already shows. */
  function info(text) {
    polite(text, 'info')
  }

  /** Shown: why a key did nothing, or what it's waiting for next. */
  function notice(text) {
    polite(text, 'notice')
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

    const shown = message?.kind === 'error' || message?.kind === 'notice'
    const text = join(stateText, shown && message.text)
    if (text !== renderedText) {
      el.textContent = text
      renderedText = text
    }
    const trace = join(traceText, message?.text)
    if (trace !== renderedTrace) {
      el.dataset.trace = trace
      renderedTrace = trace
    }

    const isError = message?.kind === 'error'
    if (isError !== renderedError) {
      el.classList.toggle('hud--error', isError)
      el.classList.toggle('hud--wrap', isError)
      renderedError = isError
    }
  }

  return { setState, info, notice, success, error, busy, done, dismiss, tick }
}

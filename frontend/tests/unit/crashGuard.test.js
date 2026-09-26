// crashGuard.js: the frame-loop boundary, the fatal and context-loss notices,
// and the global error handlers. Plain objects stand in for the DOM.
import { describe, it, expect, vi } from 'vitest'
import { CONTEXT_LOST, createCrashGuard, errorText } from '../../src/crashGuard.js'

function fakeOverlay() {
  return {
    overlay: { hidden: true },
    prompt: { hidden: false },
    keys: { hidden: false },
    notice: { hidden: true, textContent: '' },
    exitPointerLock: vi.fn(),
  }
}

function fakeRenderer() {
  return { setAnimationLoop: vi.fn() }
}

describe('crashGuard.js', () => {
  it('stops the loop on the first throw and reports it once', () => {
    const els = fakeOverlay()
    const guard = createCrashGuard(els)
    const renderer = fakeRenderer()
    const onFatal = vi.fn()
    let calls = 0
    const loop = guard.guardFrame(
      renderer,
      () => {
        calls++
        if (calls === 2) throw new Error('boom')
      },
      onFatal,
    )
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    loop()
    loop()
    loop()
    quiet.mockRestore()
    expect(calls).toBe(2) // the frame after the throw never runs
    expect(renderer.setAnimationLoop).toHaveBeenCalledWith(null)
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal.mock.calls[0][0].message).toBe('boom')
  })

  it('shows a fatal notice with the prompt and keys taken down, first message wins', () => {
    const els = fakeOverlay()
    const guard = createCrashGuard(els)
    guard.showFatal('first')
    guard.showFatal('second')
    expect(els.overlay.hidden).toBe(false)
    expect(els.prompt.hidden).toBe(true)
    expect(els.keys.hidden).toBe(true)
    expect(els.notice.hidden).toBe(false)
    expect(els.notice.textContent).toBe('first')
    expect(els.exitPointerLock).toHaveBeenCalledTimes(1)
    expect(guard.isFatal).toBe(true)
    expect(guard.isBlocking).toBe(true)
  })

  it('a context-loss cover puts back exactly what it covered', () => {
    const els = fakeOverlay()
    els.notice.textContent = 'earlier'
    const guard = createCrashGuard(els)
    guard.cover(CONTEXT_LOST)
    expect(els.notice.textContent).toBe(CONTEXT_LOST)
    expect(els.overlay.hidden).toBe(false)
    expect(guard.isBlocking).toBe(true)
    expect(guard.isFatal).toBe(false)
    guard.uncover()
    expect(els).toMatchObject({
      overlay: { hidden: true },
      prompt: { hidden: false },
      keys: { hidden: false },
      notice: { hidden: true, textContent: 'earlier' },
    })
    expect(guard.isBlocking).toBe(false)
  })

  it('a fatal during a cover stays up when the restore comes', () => {
    const els = fakeOverlay()
    const guard = createCrashGuard(els)
    guard.cover(CONTEXT_LOST)
    guard.showFatal('dead')
    guard.uncover()
    expect(els.notice.textContent).toBe('dead')
    expect(els.overlay.hidden).toBe(false)
  })

  it('routes errors and rejections to the report until rendering stops', () => {
    const guard = createCrashGuard(fakeOverlay())
    const target = new EventTarget()
    const report = vi.fn()
    const remove = guard.installGlobalHandlers(report, target)
    const error = new Event('error')
    error.error = new Error('listener broke')
    target.dispatchEvent(error)
    const rejection = new Event('unhandledrejection')
    rejection.reason = new Error('save flow broke')
    target.dispatchEvent(rejection)
    expect(report.mock.calls).toEqual([['listener broke'], ['save flow broke']])

    guard.showFatal('dead')
    target.dispatchEvent(error)
    expect(report).toHaveBeenCalledTimes(2)

    remove()
  })

  it("ignores a cross-origin 'Script error.' that carries nothing", () => {
    const guard = createCrashGuard(fakeOverlay())
    const report = vi.fn()
    const target = new EventTarget()
    const remove = guard.installGlobalHandlers(report, target)
    const opaque = new Event('error')
    opaque.message = 'Script error.'
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
    target.dispatchEvent(opaque)
    quiet.mockRestore()
    expect(report).not.toHaveBeenCalled()
    // A message-only error of our own still gets through.
    const own = new Event('error')
    own.message = 'Uncaught TypeError: x is undefined'
    target.dispatchEvent(own)
    expect(report).toHaveBeenCalledWith('Uncaught TypeError: x is undefined')
    remove()
  })

  it('errorText caps long messages and survives non-errors', () => {
    expect(errorText(new Error('x'.repeat(500))).length).toBe(160)
    expect(errorText('plain string')).toBe('plain string')
    expect(errorText(undefined)).toBe('unknown error')
  })
})

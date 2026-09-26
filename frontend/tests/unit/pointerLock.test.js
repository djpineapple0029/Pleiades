// pointerLock.js: app-initiated releases, nesting, and unlock reasons.
import { describe, it, expect } from 'vitest'
import { createPointerLock } from '../../src/pointerLock.js'

/** Stands in for PointerLockControls: lock/unlock fire synchronously. */
function fakeControls(locked = true) {
  const target = new EventTarget()
  const controls = {
    isLocked: locked,
    locks: 0,
    addEventListener: (...args) => target.addEventListener(...args),
    removeEventListener: (...args) => target.removeEventListener(...args),
    lock() {
      controls.locks++
      controls.isLocked = true
      target.dispatchEvent(new Event('lock'))
    },
    unlock() {
      controls.isLocked = false
      target.dispatchEvent(new Event('unlock'))
    },
  }
  return controls
}

describe('pointerLock.js', () => {
  it('records the reason for its own release and re-locks on resume', async () => {
    const controls = fakeControls()
    const lock = createPointerLock(controls)
    await lock.release('panel')
    expect(controls.isLocked).toBe(false)
    expect(lock.lastUnlockReason).toBe('panel')
    lock.resume()
    expect(controls.isLocked).toBe(true)
    expect(controls.locks).toBe(1)
  })

  it('calls any unlock it did not ask for manual', async () => {
    const controls = fakeControls()
    const lock = createPointerLock(controls)
    await lock.release('file')
    expect(lock.lastUnlockReason).toBe('file')
    lock.resume()
    controls.unlock() // Esc
    expect(lock.lastUnlockReason).toBe('manual')
  })

  it('never takes a lock that was not held when released', async () => {
    const controls = fakeControls(false)
    const lock = createPointerLock(controls)
    await lock.release('panel')
    lock.resume()
    expect(controls.isLocked).toBe(false)
    expect(controls.locks).toBe(0)
  })

  it('re-locks only when the outermost release resumes', async () => {
    const controls = fakeControls()
    const lock = createPointerLock(controls)
    await lock.release('file')
    await lock.release('panel')
    lock.resume()
    expect(controls.isLocked).toBe(false)
    lock.resume()
    expect(controls.isLocked).toBe(true)
    lock.resume() // unpaired: ignored
    expect(controls.locks).toBe(1)
  })

  it('never re-locks once disabled, and still pairs its releases', async () => {
    const controls = fakeControls()
    const lock = createPointerLock(controls)
    await lock.release('panel')
    lock.disable()
    lock.resume()
    expect(controls.isLocked).toBe(false)
    await lock.release('panel')
    lock.resume()
    expect(controls.locks).toBe(0)
  })
})

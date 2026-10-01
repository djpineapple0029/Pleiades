// The HUD channel (src/status.js): only errors and notices reach the screen;
// everything else, and the fuller state line, lands in data-trace.
import { describe, it, expect } from 'vitest'
import { createStatus } from '../../src/status.js'

function fakeEl() {
  const classes = new Set()
  return {
    textContent: '',
    dataset: {},
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      has: (n) => classes.has(n),
    },
  }
}

describe('status', () => {
  it('shows the short line and traces the full one', () => {
    const el = fakeEl()
    const status = createStatus(el)
    status.setState('', 'map.plm · 1 nodes · 0 edges')
    status.tick()
    expect(el.textContent).toBe('')
    expect(el.dataset.trace).toBe('map.plm · 1 nodes · 0 edges')
  })

  it('keeps info, success and busy off the screen', () => {
    const el = fakeEl()
    const status = createStatus(el)
    status.setState('', 'map.plm')
    for (const say of [
      () => status.info('look: Deep Sea'),
      () => status.busy('saving'),
      () => status.success('saved'),
    ]) {
      say()
      status.tick()
      expect(el.textContent).toBe('')
    }
    expect(el.dataset.trace).toBe('map.plm · saved')
  })

  it('shows notices and errors after the state line', () => {
    const el = fakeEl()
    const status = createStatus(el)
    status.setState('focused · click empty space to clear', 'focus n1')
    status.notice('nothing to undo')
    status.tick()
    expect(el.textContent).toBe('focused · click empty space to clear · nothing to undo')
    expect(el.dataset.trace).toBe('focus n1 · nothing to undo')

    status.setState('', 'map.plm')
    status.error('save failed: disk full')
    status.tick()
    expect(el.textContent).toBe('save failed: disk full')
    expect(el.classList.has('hud--error')).toBe(true)
  })

  it('lets a quiet success clear a shown error', () => {
    const el = fakeEl()
    const status = createStatus(el)
    status.error('save failed: disk full')
    status.tick()
    status.success('saved')
    status.tick()
    expect(el.textContent).toBe('')
    expect(el.classList.has('hud--error')).toBe(false)
  })

  it('holds a notice back while an error or busy message stands', () => {
    const el = fakeEl()
    const status = createStatus(el)
    status.error('open failed: wrong password')
    status.notice('no stars yet')
    status.tick()
    expect(el.textContent).toBe('open failed: wrong password')
  })
})

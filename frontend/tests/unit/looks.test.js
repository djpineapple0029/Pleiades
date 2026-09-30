import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLooks } from '../../src/looks.js'

// Just enough of each scene part for a look to land on.
function parts() {
  return {
    renderer: { setClearColor: vi.fn() },
    skybox: { setVariant: vi.fn() },
    dust: { setStyle: vi.fn() },
    bloom: { setEnabled: vi.fn(), setStrength: vi.fn() },
    view: { setStyle: vi.fn() },
    rivers: { setColors: vi.fn(), hide: vi.fn() },
  }
}

describe('createLooks', () => {
  beforeEach(() => {
    globalThis.document = { documentElement: { dataset: {} } }
  })
  afterEach(() => {
    delete globalThis.document
  })

  it('hands a pick to `store`, the account for a signed-in user', async () => {
    const store = vi.fn()
    const looks = createLooks({ ...parts(), store })
    await looks.set('deep-sea', { instant: true })
    expect(store).toHaveBeenCalledWith('deep-sea')
    expect(looks.current.id).toBe('deep-sea')
  })

  it('keeps nothing for a start that only applies a look', async () => {
    const store = vi.fn()
    const looks = createLooks({ ...parts(), store })
    await looks.set('minimal', { instant: true, remember: false })
    expect(store).not.toHaveBeenCalled()
    expect(globalThis.document.documentElement.dataset.look).toBe('minimal')
  })
})

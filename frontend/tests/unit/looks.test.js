import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOOKS, createLooks } from '../../src/looks.js'

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

describe('avatars per look (MOONSHOT decision 14)', () => {
  it('every look says how it draws other people', () => {
    for (const look of LOOKS) expect(['ship', 'sub', 'cursor', 'marker'], look.id).toContain(look.avatar)
  })

  it('space flies ships, the sea a submarine, the terminal a cursor, minimal a marker', () => {
    const avatarOf = Object.fromEntries(LOOKS.map((look) => [look.id, look.avatar]))
    expect(avatarOf).toEqual({
      'deep-space': 'ship',
      'shallow-space': 'ship',
      'deep-sea': 'sub',
      terminal: 'cursor',
      minimal: 'marker',
    })
  })
})

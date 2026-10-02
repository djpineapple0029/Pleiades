import { describe, it, expect } from 'vitest'
import { AVATAR_STYLES, avatarGeometry, avatarTint, blinkOn } from '../../src/room/avatarStyles.js'

describe('avatar styles', () => {
  it('four of them, each a real shape', () => {
    expect(AVATAR_STYLES).toEqual(['ship', 'sub', 'cursor', 'marker'])
    for (const style of AVATAR_STYLES) {
      const geometry = avatarGeometry(style)
      expect(geometry.getAttribute('position').count, style).toBeGreaterThan(8)
      geometry.dispose()
    }
  })

  it('a ship and a submarine point where the camera looks (-Z)', () => {
    for (const style of ['ship', 'sub', 'marker']) {
      const geometry = avatarGeometry(style)
      geometry.computeBoundingBox()
      const { min, max } = geometry.boundingBox
      // Longer than wide, centred on the pose, the nose ahead.
      expect(max.z - min.z, style).toBeGreaterThan(max.x - min.x)
      expect(Math.abs(min.z + max.z), style).toBeLessThan(max.z - min.z)
      geometry.dispose()
    }
  })

  it('a ship has wings: wider than its body is tall', () => {
    const geometry = avatarGeometry('ship')
    geometry.computeBoundingBox()
    const { min, max } = geometry.boundingBox
    expect(max.x - min.x).toBeGreaterThan(1.5 * (max.y - min.y))
    geometry.dispose()
  })

  it('an unknown style draws the marker', () => {
    const a = avatarGeometry('nonsense')
    const b = avatarGeometry('marker')
    expect(a.getAttribute('position').count).toBe(b.getAttribute('position').count)
  })

  it("the cursor is the terminal's text colour tinted by the person's", () => {
    expect(avatarTint('cursor', '#ff0000', '#00ff00')).toBe('#808000')
    expect(avatarTint('ship', '#ff0000', '#00ff00')).toBe('#ff0000')
  })

  it('the cursor blinks once a second: on, then off', () => {
    expect(blinkOn(0)).toBe(true)
    expect(blinkOn(499)).toBe(true)
    expect(blinkOn(500)).toBe(false)
    expect(blinkOn(999)).toBe(false)
    expect(blinkOn(1000)).toBe(true)
  })
})

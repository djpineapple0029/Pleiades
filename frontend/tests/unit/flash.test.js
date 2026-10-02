import { describe, it, expect } from 'vitest'
import { createFlashes } from '../../src/room/flash.js'

describe('author flashes', () => {
  it('a flashed star leans toward the colour, then lets go over the duration', () => {
    const flashes = createFlashes()
    flashes.add(['a'], [1, 0, 0], 10, 1.5)
    const tint = [0, 0, 1]
    expect(flashes.mix('a', tint, 10)).toBe(true)
    expect(tint[0]).toBeCloseTo(0.8, 5) // starts strongest: 80 % of the author's colour
    const later = [0, 0, 1]
    flashes.mix('a', later, 10.75)
    expect(later[0]).toBeCloseTo(0.4, 5)
    const done = [0, 0, 1]
    expect(flashes.mix('a', done, 11.6)).toBe(false)
    expect(done).toEqual([0, 0, 1])
  })

  it('stars not flashed are untouched, and it says when nothing is left', () => {
    const flashes = createFlashes()
    const tint = [0.2, 0.3, 0.4]
    expect(flashes.mix('b', tint, 0)).toBe(false)
    expect(tint).toEqual([0.2, 0.3, 0.4])
    flashes.add(['a'], [1, 1, 1], 0, 1)
    expect(flashes.active).toBe(true)
    flashes.prune(2)
    expect(flashes.active).toBe(false)
  })
})

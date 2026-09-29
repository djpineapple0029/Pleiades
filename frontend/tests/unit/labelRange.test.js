// labels.js adaptiveRange: the reveal range stretches to reach about the
// target number of names on screen, between the old floor and a cap.
import { describe, it, expect, afterEach } from 'vitest'
import { adaptiveRange, revealRange, setRevealScale } from '../../src/labels.js'

const distances = (list) => Float64Array.from(list)

describe('adaptiveRange', () => {
  afterEach(() => setRevealScale(1))
  const floor = revealRange(1)

  it('the floor is still the old 200-unit rule', () => expect(floor).toBe(200))

  it('fewer names than the target: every one of them is reached', () => {
    const far = distances([900, 3000, 150])
    expect(adaptiveRange(far, 3, 35)).toBeGreaterThan(3000)
  })

  it('reaches the target-th nearest, fully inside the fade', () => {
    const list = distances(Array.from({ length: 100 }, (_, i) => 100 + 20 * i))
    // The 10th nearest is 280; the range puts it at the fade's inner edge.
    expect(adaptiveRange(list, 100, 10)).toBeCloseTo(280 / 0.75, 6)
  })

  it('never below the floor, however crowded', () => {
    const crowd = distances(Array.from({ length: 100 }, () => 20))
    expect(adaptiveRange(crowd, 100, 10)).toBe(floor)
  })

  it('never beyond the cap', () => {
    const remote = distances(Array.from({ length: 50 }, () => 1e6))
    expect(adaptiveRange(remote, 50, 10)).toBe(floor * 30)
  })

  it('the label-distance setting scales floor and cap', () => {
    setRevealScale(2)
    const crowd = distances(Array.from({ length: 100 }, () => 20))
    expect(adaptiveRange(crowd, 100, 10)).toBe(400)
  })

  it('a target of 0 turns the stretch off', () => {
    expect(adaptiveRange(distances([900, 3000]), 2, 0)).toBe(floor)
  })

  it('only the first `count` distances are read', () => {
    const list = distances([600, 600, 600, 1, 1, 1])
    expect(adaptiveRange(list, 3, 3)).toBeCloseTo(600 / 0.75, 6)
  })
})

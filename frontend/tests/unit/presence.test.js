import { describe, it, expect } from 'vitest'
import { createPoseBuffer, createPosePublisher } from '../../src/room/presence.js'

const pose = (x) => ({ p: [x, 0, 0], q: [0, 0, 0, 1] })

describe('pose buffer', () => {
  it('renders 150 ms in the past, between the samples that bracket it', () => {
    const buffer = createPoseBuffer({ delay: 150 })
    buffer.push(pose(0), 1000)
    buffer.push(pose(10), 1100)
    const s = buffer.sample(1200) // render time 1050 → halfway
    expect(s.p[0]).toBeCloseTo(5, 5)
  })

  it('extrapolates a little, then holds', () => {
    const buffer = createPoseBuffer({ delay: 0, maxExtrapolate: 250 })
    buffer.push(pose(0), 1000)
    buffer.push(pose(10), 1100)
    expect(buffer.sample(1200).p[0]).toBeCloseTo(20, 5)
    expect(buffer.sample(5000).p[0]).toBeCloseTo(35, 5) // 250 ms of 100 u/s, then held
  })

  it('a teleport snaps instead of gliding across the map', () => {
    const buffer = createPoseBuffer({ delay: 150 })
    buffer.push(pose(0), 1000)
    buffer.push(pose(5000), 1100)
    expect(buffer.sample(1200).p[0]).toBe(5000)
  })

  it('rotation is slerped and stays a unit quaternion', () => {
    const buffer = createPoseBuffer({ delay: 0 })
    const half = Math.SQRT1_2
    buffer.push({ p: [0, 0, 0], q: [0, 0, 0, 1] }, 1000)
    buffer.push({ p: [0, 0, 0], q: [0, half, 0, half] }, 1100) // 90° about y
    buffer.push({ p: [0, 0, 0], q: [0, half, 0, half] }, 1200)
    const { q } = buffer.sample(1050)
    expect(Math.hypot(...q)).toBeCloseTo(1, 6)
    expect(q[1]).toBeCloseTo(Math.sin(Math.PI / 8), 3) // 45°
  })

  it('nothing to show before the first sample', () => {
    expect(createPoseBuffer().sample(0)).toBeNull()
  })
})

describe('pose publisher', () => {
  function fakeAwareness() {
    const writes = []
    return { writes, setLocalStateField: (key, value) => writes.push([key, value]) }
  }

  it('sends at most 10 Hz while moving and 1 Hz while still', () => {
    let t = 0
    const awareness = fakeAwareness()
    const publish = createPosePublisher({ awareness, now: () => t }).publish
    for (let i = 0; i < 60; i++) {
      t = i * 16
      publish({ ...pose(i), mode: 'fly', editing: null })
    }
    expect(awareness.writes.length).toBeLessThanOrEqual(11)
    const moving = awareness.writes.length
    for (let i = 0; i < 120; i++) {
      t = 1000 + i * 16
      publish({ ...pose(59), mode: 'fly', editing: null })
    }
    expect(awareness.writes.length - moving).toBeLessThanOrEqual(3)
  })

  it('what it sends is the pose, mode and what they are editing', () => {
    const awareness = fakeAwareness()
    createPosePublisher({ awareness, now: () => 0 }).publish({ ...pose(1), mode: 'editing', editing: 'n1' })
    expect(awareness.writes[0]).toEqual([
      'pose',
      { p: [1, 0, 0], q: [0, 0, 0, 1], mode: 'editing', editing: 'n1' },
    ])
  })
})

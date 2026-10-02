import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createFollow, followPose, pickTarget, yieldsInCircle } from '../../src/room/follow.js'

// Looking down -Z from the origin, as a fresh camera does.
const camera = { p: [0, 0, 0], forward: [0, 0, -1] }
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6)

describe('pickTarget', () => {
  it('the person on the crosshair wins over one nearer but off it', () => {
    const people = [
      { clientId: 1, p: [20, 0, -100] }, // ~11° off, nearer
      { clientId: 2, p: [1, 0, -400] }, // ~0.14° off, far
    ]
    expect(pickTarget(camera, people)).toBe(2)
  })

  it('of two on the crosshair, the one nearest the ray', () => {
    const people = [
      { clientId: 1, p: [3, 0, -100] },
      { clientId: 2, p: [0.5, 0, -100] },
    ]
    expect(pickTarget(camera, people)).toBe(2)
  })

  it('nobody on the crosshair: the nearest in front within 30°', () => {
    const people = [
      { clientId: 1, p: [40, 0, -100] }, // ~22°, 108 away
      { clientId: 2, p: [30, 0, -300] }, // ~5.7°: off the crosshair, 301 away
      { clientId: 3, p: [100, 0, -50] }, // ~63°: out
    ]
    expect(pickTarget(camera, people)).toBe(1)
  })

  it('never someone behind the camera', () => {
    expect(pickTarget(camera, [{ clientId: 1, p: [0, 0, 100] }])).toBeNull()
  })

  it('nobody → null', () => {
    expect(pickTarget(camera, [])).toBeNull()
  })

  it('someone sitting on the camera itself is not a target', () => {
    expect(pickTarget(camera, [{ clientId: 1, p: [0, 0, 0] }])).toBeNull()
  })
})

describe('followPose', () => {
  it('30 back along their forward and 6 up, looking the same way', () => {
    const pose = followPose({ p: [10, 20, 30], q: [0, 0, 0, 1] })
    expect(close(pose.p, [10, 26, 60])).toBe(true)
    expect(pose.q).toEqual([0, 0, 0, 1])
  })

  it('turned round, "back" turns with them', () => {
    // Half a turn about Y: they look down +Z, so behind is -Z.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).toArray()
    const pose = followPose({ p: [0, 0, 0], q }, { back: 10, up: 2 })
    expect(close(pose.p, [0, 2, -10])).toBe(true)
  })
})

describe('createFollow', () => {
  const presenceWith = (poses) => ({ sampleOf: (id) => poses.get(id) ?? null })

  it('eases the camera toward the follow pose each update', () => {
    const cam = new THREE.PerspectiveCamera()
    const poses = new Map([[7, { p: [0, 0, -100], q: [0, 0, 0, 1] }]])
    const follow = createFollow({ camera: cam, presence: presenceWith(poses), ease: 0.5 })
    follow.start(7)
    expect(follow.active).toBe(true)
    expect(follow.target).toBe(7)
    follow.update()
    // Goal is (0, 6, -70): half way there from the origin.
    expect(close(cam.position.toArray(), [0, 3, -35])).toBe(true)
    for (let i = 0; i < 40; i++) follow.update()
    expect(close(cam.position.toArray(), [0, 6, -70])).toBe(true)
  })

  it('stop() ends it and says why', () => {
    const stops = []
    const follow = createFollow({
      camera: new THREE.PerspectiveCamera(),
      presence: presenceWith(new Map([[7, { p: [0, 0, 0], q: [0, 0, 0, 1] }]])),
      onStop: (reason, id) => stops.push([reason, id]),
    })
    follow.start(7)
    follow.stop('moved')
    expect(follow.active).toBe(false)
    expect(stops).toEqual([['moved', 7]])
    follow.stop('again') // already stopped: nothing
    expect(stops).toHaveLength(1)
  })

  it('stops by itself when the person is gone', () => {
    const stops = []
    const poses = new Map([[7, { p: [0, 0, 0], q: [0, 0, 0, 1] }]])
    const follow = createFollow({
      camera: new THREE.PerspectiveCamera(),
      presence: presenceWith(poses),
      onStop: (reason) => stops.push(reason),
    })
    follow.start(7)
    poses.delete(7)
    follow.update()
    expect(follow.active).toBe(false)
    expect(stops).toEqual(['left'])
  })
})

describe('yieldsInCircle', () => {
  it('two following each other: exactly one of them gives way', () => {
    expect(yieldsInCircle({ me: 9, target: 4, theirTarget: 9 })).toBe(true)
    expect(yieldsInCircle({ me: 4, target: 9, theirTarget: 4 })).toBe(false)
  })

  it('no circle, nobody gives way', () => {
    expect(yieldsInCircle({ me: 9, target: 4, theirTarget: null })).toBe(false)
    expect(yieldsInCircle({ me: 9, target: 4, theirTarget: 7 })).toBe(false)
  })
})

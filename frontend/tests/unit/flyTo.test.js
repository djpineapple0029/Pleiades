// flyTo.js: eased camera flights to a star and back to a saved pose.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createFlyTo, standOff, FLY_DURATION } from '../../src/flyTo.js'

function camera() {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000)
  cam.position.set(0, 0, 500)
  return cam
}

/** How well the star sits under the crosshair: 1 is dead centre. */
function aimOf(cam, point) {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion)
  const toPoint = point.clone().sub(cam.position).normalize()
  return forward.dot(toPoint)
}

function run(fly, seconds, step = 1 / 60) {
  for (let t = 0; t < seconds; t += step) fly.update(step)
}

describe('standOff', () => {
  it('keeps well clear of the star, with a floor for small ones', () => {
    expect(standOff(5)).toBe(60)
    expect(standOff(20)).toBeGreaterThan(20 * 2.5)
  })
})

describe('createFlyTo', () => {
  it('lands a stand-off away from the star, looking straight at it', () => {
    const cam = camera()
    const fly = createFlyTo(cam)
    const star = new THREE.Vector3(200, 80, -300)
    let arrived = false
    fly.toStar(
      () => ({ position: star, radius: 5 }),
      FLY_DURATION,
      () => (arrived = true),
    )
    expect(fly.isActive).toBe(true)
    run(fly, FLY_DURATION + 0.1)
    expect(arrived).toBe(true)
    expect(fly.isActive).toBe(false)
    expect(cam.position.distanceTo(star)).toBeCloseTo(standOff(5), 3)
    expect(aimOf(cam, star)).toBeGreaterThan(0.9999)
  })

  it('has no roll on arrival', () => {
    const cam = camera()
    const fly = createFlyTo(cam)
    fly.toStar(() => ({ position: new THREE.Vector3(-400, 300, 100), radius: 5 }), 0.2)
    run(fly, 0.3)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
    expect(Math.abs(right.y)).toBeLessThan(1e-6)
  })

  it('follows a star that moves mid-flight', () => {
    const cam = camera()
    const fly = createFlyTo(cam)
    const star = new THREE.Vector3(0, 0, 0)
    fly.toStar(() => ({ position: star, radius: 5 }), FLY_DURATION)
    run(fly, FLY_DURATION / 2)
    star.set(50, -40, 20)
    run(fly, FLY_DURATION)
    expect(aimOf(cam, star)).toBeGreaterThan(0.9999)
    expect(cam.position.distanceTo(star)).toBeCloseTo(standOff(5), 3)
  })

  it('stops where it is if the star disappears', () => {
    const cam = camera()
    const fly = createFlyTo(cam)
    let alive = true
    let arrived = false
    fly.toStar(
      () => (alive ? { position: new THREE.Vector3(), radius: 5 } : null),
      FLY_DURATION,
      () => (arrived = true),
    )
    run(fly, FLY_DURATION / 2)
    const midway = cam.position.clone()
    alive = false
    run(fly, FLY_DURATION)
    expect(fly.isActive).toBe(false)
    expect(arrived).toBe(true)
    expect(cam.position.equals(midway)).toBe(true)
  })

  it('cuts straight there with a zero duration', () => {
    const cam = camera()
    const fly = createFlyTo(cam)
    const star = new THREE.Vector3(10, 10, 10)
    fly.toStar(() => ({ position: star, radius: 5 }), 0)
    fly.update(1 / 60)
    expect(fly.isActive).toBe(false)
    expect(cam.position.distanceTo(star)).toBeCloseTo(standOff(5), 3)
  })

  it('flies back to a saved pose exactly', () => {
    const cam = camera()
    const fly = createFlyTo(cam)
    const savedPosition = cam.position.clone()
    const savedQuaternion = cam.quaternion.clone()
    fly.toStar(() => ({ position: new THREE.Vector3(300, 0, 0), radius: 5 }), 0.2)
    run(fly, 0.3)
    fly.toPose(savedPosition, savedQuaternion, 0.2)
    run(fly, 0.3)
    expect(cam.position.distanceTo(savedPosition)).toBeLessThan(1e-9)
    expect(cam.quaternion.angleTo(savedQuaternion)).toBeLessThan(1e-6)
  })

  it('refuses a star that is already gone, and cancel drops the callback', () => {
    const cam = camera()
    const fly = createFlyTo(cam)
    expect(fly.toStar(() => null, FLY_DURATION)).toBe(false)
    expect(fly.isActive).toBe(false)
    let arrived = false
    fly.toStar(
      () => ({ position: new THREE.Vector3(), radius: 5 }),
      FLY_DURATION,
      () => (arrived = true),
    )
    fly.cancel()
    run(fly, FLY_DURATION)
    expect(arrived).toBe(false)
  })

  it('looks straight down at a star directly below without a NaN pose', () => {
    const cam = camera()
    cam.position.set(0, 500, 0)
    const fly = createFlyTo(cam)
    const star = new THREE.Vector3(0, 0, 0)
    fly.toStar(() => ({ position: star, radius: 5 }), 0.2)
    run(fly, 0.3)
    expect(Number.isFinite(cam.quaternion.x + cam.quaternion.y + cam.quaternion.z + cam.quaternion.w)).toBe(
      true,
    )
    expect(aimOf(cam, star)).toBeGreaterThan(0.9999)
  })
})

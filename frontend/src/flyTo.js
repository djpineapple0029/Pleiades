import * as THREE from 'three'

// Seconds for a jump, there or back: quick enough to hop between results,
// long enough to read as travel rather than a cut.
export const FLY_DURATION = 0.6
// Where a jump stops, in radii of the star it lands on. Stars fade out within
// 2.5 of their own radii (graphView's `vFade`), so it has to be well past that.
const STAND_OFF_RADII = 7
// Floor on the stand-off, so a small star is framed with room around it and
// its label (always shown for the hovered star) has somewhere to sit.
const MIN_STAND_OFF = 60
// Past the poles `lookAt` with a world up of +Y has no defined yaw.
const POLE_GUARD = 0.999

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const lookMatrix = new THREE.Matrix4()
const scratch = new THREE.Vector3()

export function standOff(radius) {
  return Math.max(radius * STAND_OFF_RADII, MIN_STAND_OFF)
}

/**
 * A camera pose `distance` back from `target` along `direction` (a unit
 * vector, camera → target), looking straight at it with no roll: the target
 * lands under the crosshair. Writes into `outPosition` and `outQuaternion`.
 */
export function poseFacing(target, direction, distance, outPosition, outQuaternion) {
  outPosition.copy(target).addScaledVector(direction, -distance)
  // Nudged off the pole: straight up or down, lookAt would pick an arbitrary
  // yaw, and PointerLockControls would inherit it.
  scratch.copy(direction)
  if (Math.abs(scratch.y) > POLE_GUARD) {
    scratch.x += 1e-3
    scratch.normalize()
    outPosition.copy(target).addScaledVector(scratch, -distance)
  }
  lookMatrix.lookAt(outPosition, target, WORLD_UP)
  return outQuaternion.setFromRotationMatrix(lookMatrix)
}

/**
 * Eased camera flights: to a star (search) and back to a saved pose (jump
 * back). Drives the camera directly, so the caller suspends flight and
 * mouse-look for the duration and calls `update(dt)` every frame, after
 * physics and before anything raycasts or draws.
 *
 * A flight to a star re-aims every frame at wherever the star is now, so a
 * Balance run moving it doesn't leave the camera staring at empty space.
 */
export function createFlyTo(camera) {
  const fromPosition = new THREE.Vector3()
  const fromQuaternion = new THREE.Quaternion()
  const toPosition = new THREE.Vector3()
  const toQuaternion = new THREE.Quaternion()
  const direction = new THREE.Vector3()
  const target = new THREE.Vector3()

  let active = false
  let elapsed = 0
  let duration = FLY_DURATION
  let aim = null // () => { position, radius } of the star, or null once it's gone
  let onDone = null

  function begin(seconds, done) {
    fromPosition.copy(camera.position)
    fromQuaternion.copy(camera.quaternion)
    elapsed = 0
    duration = seconds
    onDone = done ?? null
    active = true
  }

  /**
   * Flies to a star. `aim()` is read every frame and returns the star's
   * current `{ position, radius }`, or null if it no longer exists (the flight
   * then stops where it is). The approach direction is fixed at the start:
   * straight along the line from the camera, so the star keeps its place in
   * the view as it grows.
   */
  function toStar(aimFn, seconds, done) {
    const first = aimFn()
    if (!first) return false
    aim = aimFn
    direction.subVectors(first.position, camera.position)
    // Already sitting on it: come at it along the current view direction.
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, -1).applyQuaternion(camera.quaternion)
    direction.normalize()
    begin(seconds, done)
    return true
  }

  /** Flies to a fixed pose, e.g. one saved before a jump. */
  function toPose(position, quaternion, seconds, done) {
    aim = null
    toPosition.copy(position)
    toQuaternion.copy(quaternion)
    begin(seconds, done)
  }

  function finish() {
    active = false
    aim = null
    const done = onDone
    onDone = null
    done?.()
  }

  /** Stops wherever the camera has got to, without calling `done`. */
  function cancel() {
    active = false
    aim = null
    onDone = null
  }

  function update(dt) {
    if (!active) return
    if (aim) {
      const star = aim()
      if (!star) {
        finish()
        return
      }
      target.copy(star.position)
      poseFacing(target, direction, standOff(star.radius), toPosition, toQuaternion)
    }
    elapsed += dt
    const t = duration > 0 ? Math.min(1, elapsed / duration) : 1
    const eased = t * t * (3 - 2 * t)
    camera.position.lerpVectors(fromPosition, toPosition, eased)
    camera.quaternion.slerpQuaternions(fromQuaternion, toQuaternion, eased)
    if (t === 1) finish()
  }

  return {
    toStar,
    toPose,
    update,
    cancel,
    get isActive() {
      return active
    },
  }
}

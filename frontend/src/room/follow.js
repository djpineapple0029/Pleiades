/**
 * Follow someone (context/MOONSHOT.md decision 15): F on a person's ship
 * (or, with nobody on the crosshair, the nearest one ahead) and the camera
 * trails theirs — behind and a little above, looking where they look,
 * eased so it glides rather than snaps. Any movement key, Tab, Backspace
 * or / stops it (interaction.js), and so does them leaving.
 *
 * `pickTarget` and `followPose` are pure; `createFollow` drives a three.js
 * camera from `presence.sampleOf` (avatars.js: their smoothed pose).
 */
import * as THREE from 'three'

const AHEAD_CONE = Math.PI / 6 // 30°: "in view", when nobody is on the crosshair

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const length = (a) => Math.hypot(a[0], a[1], a[2])

/**
 * The person nearest the crosshair ray within `maxAngle` radians; else the
 * nearest one in front within 30°; else null. Never anyone behind.
 */
export function pickTarget(camera, people, { maxAngle = 0.07 } = {}) {
  const forward = camera.forward
  const scale = length(forward) || 1
  let onRay = null
  let ahead = null
  for (const person of people) {
    const to = sub(person.p, camera.p)
    const distance = length(to)
    if (distance < 1e-6) continue
    const cos = dot(to, forward) / (distance * scale)
    if (cos <= 0) continue
    const angle = Math.acos(Math.min(1, cos))
    if (angle <= maxAngle && (!onRay || angle < onRay.angle)) onRay = { id: person.clientId, angle }
    if (angle <= AHEAD_CONE && (!ahead || distance < ahead.distance))
      ahead = { id: person.clientId, distance }
  }
  return onRay?.id ?? ahead?.id ?? null
}

/**
 * Two people following each other would chase round for ever. Whoever
 * finds themselves in that circle gives way if their id is the higher, so
 * when both press F at once exactly one keeps following. Pure.
 */
export function yieldsInCircle({ me, target, theirTarget }) {
  return theirTarget === me && me > target
}

/** Behind them along their forward and up along their up; their rotation. */
export function followPose(target, { back = 30, up = 6 } = {}) {
  const q = new THREE.Quaternion().fromArray(target.q)
  const offset = new THREE.Vector3(0, up, back).applyQuaternion(q)
  return { p: new THREE.Vector3().fromArray(target.p).add(offset).toArray(), q: [...target.q] }
}

export function createFollow({
  camera,
  presence,
  ease = 0.12,
  now = () => performance.now(),
  onStop = () => {},
}) {
  let target = null
  const goal = new THREE.Vector3()
  const turn = new THREE.Quaternion()

  function start(clientId) {
    target = clientId
  }

  /** Ends it, if on, and tells `onStop(reason, clientId)`. */
  function stop(reason = 'stopped') {
    if (target === null) return
    const was = target
    target = null
    onStop(reason, was)
  }

  /** Each frame while following: a step toward where they'd be seen from. */
  function update() {
    if (target === null) return
    const sample = presence.sampleOf(target, now())
    if (!sample) {
      stop('left')
      return
    }
    const pose = followPose(sample)
    camera.position.lerp(goal.fromArray(pose.p), ease)
    camera.quaternion.slerp(turn.fromArray(pose.q), ease)
  }

  return {
    start,
    stop,
    update,
    get active() {
      return target !== null
    },
    get target() {
      return target
    },
  }
}

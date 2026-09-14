import * as THREE from 'three'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'

const MOVE_SPEED = 90 // world units per second at full throttle, before the scroll multiplier
const DAMPING = 12 // velocity smoothing rate, 1/s — higher is snappier

// Spectator-mode-style scroll-to-adjust speed. Scaled by actual scroll
// distance rather than a fixed step per event: a mouse reports one event per
// notch (deltaY ~100), but a trackpad — the default on every Mac — reports
// dozens of small events per swipe, so a fixed per-event step would rocket
// straight to the clamp on the first flick. 0.00095 makes one mouse notch
// come out to roughly the same ~1.1x as a trackpad swipe of similar feel.
const SPEED_SENSITIVITY = 0.00095
const MIN_SPEED_MULT = 0.05
const MAX_SPEED_MULT = 10

// code -> [axis, sign]. Forward/right are camera-relative, up is world-relative
// so there is always a stable vertical reference to climb and drop against.
const KEY_AXES = {
  KeyW: ['forward', 1],
  KeyS: ['forward', -1],
  KeyD: ['right', 1],
  KeyA: ['right', -1],
  Space: ['up', 1],
  ShiftLeft: ['up', -1],
  ShiftRight: ['up', -1],
}

const WORLD_UP = new THREE.Vector3(0, 1, 0)

/**
 * Pointer-locked 6-degree-of-freedom flight. Call `update(dt)` once per frame.
 */
export function createFlight(camera, domElement) {
  const controls = new PointerLockControls(camera, domElement)

  // Suspended while the radial menu or editor owns the keyboard and mouse.
  let enabled = true

  const held = new Set()
  let speedMultiplier = 1
  const velocity = new THREE.Vector3()
  const targetVelocity = new THREE.Vector3()
  const forward = new THREE.Vector3()
  const right = new THREE.Vector3()

  function onKeyDown(event) {
    if (!enabled || !controls.isLocked || event.repeat) return
    if (event.code in KEY_AXES) {
      held.add(event.code)
      event.preventDefault()
    }
  }

  function onKeyUp(event) {
    held.delete(event.code)
  }

  function onWheel(event) {
    if (!enabled || !controls.isLocked) return
    event.preventDefault()
    // A trackpad pinch-to-zoom gesture is delivered as a wheel event with
    // ctrlKey set — real speed-adjustment scrolls never carry it, so this
    // tells the two apart the same way interaction.js and editor.js already
    // use ctrlKey/metaKey to distinguish a shortcut from plain input.
    if (event.ctrlKey) return
    // Normalize to a roughly pixel-scale delta — deltaMode is 0 (pixels) in
    // virtually every case, but Firefox can report 1 (lines) for some devices.
    const delta = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaY
    const factor = Math.exp(-delta * SPEED_SENSITIVITY)
    speedMultiplier = THREE.MathUtils.clamp(speedMultiplier * factor, MIN_SPEED_MULT, MAX_SPEED_MULT)
  }

  // Keys held while focus or lock is lost never emit keyup — drop them all.
  function releaseAll() {
    held.clear()
    velocity.set(0, 0, 0)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  // On the canvas itself, not window: pointer lock still routes wheel events
  // by the cursor's last real position, and binding here doesn't depend on
  // the event bubbling all the way up unobstructed.
  domElement.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('blur', releaseAll)
  controls.addEventListener('unlock', releaseAll)

  function update(dt) {
    let f = 0
    let r = 0
    let u = 0
    for (const code of held) {
      const [axis, sign] = KEY_AXES[code]
      if (axis === 'forward') f += sign
      else if (axis === 'right') r += sign
      else u += sign
    }

    targetVelocity.set(0, 0, 0)
    if (f || r || u) {
      // Camera basis from the quaternion: stays well defined looking straight
      // up or down, where crossing the view direction with world up collapses.
      forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
      right.set(1, 0, 0).applyQuaternion(camera.quaternion)
      targetVelocity
        .addScaledVector(forward, f)
        .addScaledVector(right, r)
        .addScaledVector(WORLD_UP, u)
        .normalize()
        .multiplyScalar(MOVE_SPEED * speedMultiplier)
    }

    // Frame-rate independent exponential approach to the target velocity.
    velocity.lerp(targetVelocity, 1 - Math.exp(-DAMPING * dt))
    camera.position.addScaledVector(velocity, dt)
  }

  function setEnabled(value) {
    enabled = value
    if (!enabled) releaseAll()
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    domElement.removeEventListener('wheel', onWheel)
    window.removeEventListener('blur', releaseAll)
    controls.removeEventListener('unlock', releaseAll)
    controls.dispose()
  }

  return {
    controls,
    update,
    setEnabled,
    dispose,
    /** Current scroll-adjusted move-speed multiplier, 1 at the default speed. */
    getSpeed: () => speedMultiplier,
  }
}

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

/**
 * Overview mode: the escape hatch for getting lost in open space. Tab flies the
 * camera out until the whole map is in frame and hands it to `OrbitControls`;
 * Tab again takes pointer lock back and flight carries on from wherever the
 * orbit left off.
 *
 * It drives the **same** `PerspectiveCamera` as flight does, because the bloom
 * pipeline captured that camera when it was created and sets its layers every
 * frame. Everything else follows for free: the edge fog is recomputed each
 * frame from whichever camera renders, and labels are laid out for the camera
 * `view.update` is handed.
 *
 * This is the only mode switch that releases pointer lock — the overview needs
 * a real cursor to drag with — which is exactly the exception the plan's risk
 * table allows.
 */

// Seconds the camera takes to fly out to the fitted view. Long enough to read
// as travel rather than a cut, short enough to stay out of the way.
const TRANSITION = 0.45
// Slack around the fitted silhouette, so the stars at the edge of the map keep
// their glow, and their labels most of their room, inside the frame.
const FIT_MARGIN = 1.12
// How much of a node's drawn radius counts toward the fit: a star's glow and
// rays reach well past its body.
const STAR_REACH = 2
// Floors on the fitted distance. The star shader fades a star out within 2.5 of
// its own radii, so a tight fit on a small map would frame a node that is not
// being drawn at all.
const MIN_FIT = 60
const MIN_FIT_RADII = 6
// Where the orbit target goes when there is nothing to frame.
const EMPTY_TARGET = 260
// The orbit is kept this far off the poles. `OrbitControls` would clamp there
// anyway, but the real reason is the way back: `lookAt` with a world up of +Y
// is degenerate looking straight down, and it would hand the flight controls an
// arbitrary yaw to decompose.
const POLAR_MARGIN = 0.12
const DAMPING = 0.08
const MIN_DISTANCE = 20
const MAX_DISTANCE_FACTOR = 8
const MAX_DISTANCE_MIN = 2000

export function createOverview({ camera, canvas, graph, view, controls }) {
  const box = new THREE.Box3()
  const centre = new THREE.Vector3()
  const point = new THREE.Vector3()
  const offset = new THREE.Vector3()
  const forward = new THREE.Vector3()
  const viewForward = new THREE.Vector3()
  const viewRight = new THREE.Vector3()
  const viewUp = new THREE.Vector3()
  const spherical = new THREE.Spherical()
  const lookMatrix = new THREE.Matrix4()

  const target = new THREE.Vector3()
  const fromPosition = new THREE.Vector3()
  const fromQuaternion = new THREE.Quaternion()
  const toPosition = new THREE.Vector3()
  const toQuaternion = new THREE.Quaternion()

  let mode = 'off' // off | entering | on
  let elapsed = 0
  let fitDistance = EMPTY_TARGET
  let orbit = null

  /**
   * Frames everything drawn: fills `target` with the map's centre and
   * `toPosition`/`toQuaternion` with a camera pose that sees all of it.
   */
  function fit() {
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion)

    if (graph.nodes.size === 0) {
      // Nothing to frame, so don't move — just orbit a point ahead of where the
      // camera already is.
      target.copy(camera.position).addScaledVector(forward, EMPTY_TARGET)
      toPosition.copy(camera.position)
      toQuaternion.copy(camera.quaternion)
      fitDistance = EMPTY_TARGET
      return
    }

    box.makeEmpty()
    let maxReach = 0
    for (const node of graph.nodes.values()) {
      // The drawn radius, not the model's: a core that is still easing up
      // should be framed at the size it is on screen this frame.
      const reach = view.radiusOf(node.id) * STAR_REACH
      maxReach = Math.max(maxReach, reach)
      box.expandByPoint(point.set(node.x - reach, node.y - reach, node.z - reach))
      box.expandByPoint(point.set(node.x + reach, node.y + reach, node.z + reach))
    }
    box.getCenter(centre)
    target.copy(centre)

    // The direction has to be settled before the distance, because a fit this
    // tight depends on which way the map is being looked at.
    //
    // Straight back from where the camera already is, so the map stays on the
    // side of the user it was on. Pulling back along the view direction instead
    // would swing them round to the far side of it whenever they happened to be
    // looking away, which is disorienting in exactly the moment this mode
    // exists to rescue.
    offset.subVectors(camera.position, centre)
    if (offset.lengthSq() < 1e-6) offset.copy(forward).negate()
    spherical.setFromVector3(offset)
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, POLAR_MARGIN, Math.PI - POLAR_MARGIN)
    spherical.radius = 1
    offset.setFromSpherical(spherical)

    // A camera basis for that direction, to measure the map's silhouette in.
    viewForward.copy(offset).negate()
    viewRight.crossVectors(viewForward, camera.up).normalize()
    viewUp.crossVectors(viewRight, viewForward)

    // How far back each node — as a sphere of its own reach — needs the camera
    // to be to clear the frustum, in each of the two field angles separately.
    //
    // This fits the silhouette, not a bounding sphere. A sphere's radius is set
    // by the map's longest axis, and fitting that against the *narrower* of the
    // two angles is conservative twice over: a wide, flat map came out framed at
    // under half the screen, which is a poor escape hatch when the whole point
    // is to be able to read it. The cost is that a long map can leave the frame
    // once the orbit turns away from this direction; the scroll wheel is there.
    const halfV = THREE.MathUtils.degToRad(camera.fov) / 2
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect)
    const tanV = Math.tan(halfV)
    const tanH = Math.tan(halfH)
    const sinV = Math.sin(halfV)
    const sinH = Math.sin(halfH)
    let needed = 0
    for (const node of graph.nodes.values()) {
      const reach = view.radiusOf(node.id) * STAR_REACH
      point.set(node.x, node.y, node.z).sub(centre)
      const depth = point.dot(viewForward)
      const across = Math.abs(point.dot(viewRight))
      const above = Math.abs(point.dot(viewUp))
      needed = Math.max(needed, across / tanH + reach / sinH - depth, above / tanV + reach / sinV - depth)
    }
    fitDistance = Math.max(needed * FIT_MARGIN, maxReach * MIN_FIT_RADII, MIN_FIT)

    offset.multiplyScalar(fitDistance)
    toPosition.copy(centre).add(offset)
    lookMatrix.lookAt(toPosition, centre, camera.up)
    toQuaternion.setFromRotationMatrix(lookMatrix)
  }

  function detach() {
    if (!orbit) return
    orbit.dispose()
    orbit = null
  }

  function attach() {
    // A fresh instance every time, rather than one kept around disabled: Tab
    // pressed mid-drag would otherwise leave a captured pointer and a live
    // damping delta behind for the next activation to act on.
    orbit = new OrbitControls(camera, canvas)
    // Its constructor runs an `update()` of its own against a target of
    // (0,0,0), which turns the camera toward the origin. Setting the real
    // target and updating again puts it back, and both happen well before the
    // next frame is drawn.
    orbit.target.copy(target)
    orbit.enableDamping = true
    orbit.dampingFactor = DAMPING
    orbit.minDistance = MIN_DISTANCE
    orbit.maxDistance = Math.max(fitDistance * MAX_DISTANCE_FACTOR, MAX_DISTANCE_MIN)
    orbit.minPolarAngle = POLAR_MARGIN
    orbit.maxPolarAngle = Math.PI - POLAR_MARGIN
    orbit.update()
  }

  /** Starts the flight out to the fitted view. */
  function enter() {
    detach()
    fit()
    fromPosition.copy(camera.position)
    fromQuaternion.copy(camera.quaternion)
    elapsed = 0
    // Set before the unlock below: `pointerlockchange` is delivered as its own
    // task, so anything keyed on `isActive` — the click-to-fly overlay,
    // click-to-lock, the HUD — has to already see the new mode when it lands.
    mode = 'entering'
    if (controls.isLocked) controls.unlock()
  }

  function exit() {
    detach()
    mode = 'off'
    // A keypress is a user gesture, so this is allowed to ask for the lock
    // back. Chrome refuses for ~1.25s after a release, and `pointerlockerror`
    // in main.js is what says so — it brings the overlay back with it, so a
    // refusal lands on "click to fly" rather than on nothing.
    if (!controls.isLocked) controls.lock()
  }

  function toggle() {
    if (mode === 'off') enter()
    else exit()
  }

  /**
   * Per-frame. Call after `flight.update` and before anything reads the camera:
   * during the flight out, the lerp below deliberately overwrites whatever
   * flight or a stray mouse move did, since pointer lock takes a moment to
   * actually go.
   */
  function update(dt) {
    if (mode === 'entering') {
      elapsed += dt
      const t = Math.min(1, elapsed / TRANSITION)
      const eased = t * t * (3 - 2 * t)
      camera.position.lerpVectors(fromPosition, toPosition, eased)
      camera.quaternion.slerpQuaternions(fromQuaternion, toQuaternion, eased)
      if (t === 1) {
        mode = 'on'
        attach()
      }
      return
    }
    if (mode === 'on' && orbit) orbit.update()
  }

  /**
   * Re-frames the map, flying out again from wherever the camera is. A no-op
   * unless the overview is up. Opening a file calls this: the payload restores
   * a camera pose of its own, and an orbit whose target still belongs to the
   * previous map would drag it straight back off it.
   */
  function refit() {
    if (mode === 'off') return
    enter()
  }

  function dispose() {
    detach()
    mode = 'off'
  }

  return {
    toggle,
    update,
    refit,
    dispose,
    /** True from the moment Tab is pressed until Tab puts flight back. */
    get isActive() {
      return mode !== 'off'
    },
    /** True only once the camera has arrived and the orbit has the controls. */
    get isOrbiting() {
      return mode === 'on'
    },
    /** The point the overview orbits. */
    get target() {
      return target
    },
    /** How far the camera currently sits from that point. */
    get distance() {
      return camera.position.distanceTo(target)
    },
  }
}

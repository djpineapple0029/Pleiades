// Ported from tests/_rescued/unit/test_camera.mjs. `PointerLockControls`
// drives the camera through a YXZ euler and writes the quaternion; the
// payload stores camera.rotation, which is XYZ. The round trip has to
// survive that mismatch.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'

const YXZ = new THREE.Euler(0, 0, 0, 'YXZ')
const camera = new THREE.PerspectiveCamera(70, 1.5, 0.5, 20000)

const looks = [
  [0, 0, 'level, facing -Z'],
  [0.3, -2.1, 'yawed past a right angle'],
  [-Math.PI / 2 + 0.0001, 3.0, 'pitched to the clamp, looking down'],
  [Math.PI / 2 - 0.0001, -3.0, 'pitched to the clamp, looking up'],
  [1.2, 5.9, 'yaw wrapped past 2pi'],
]

describe('camera round trip through the saved payload', () => {
  for (const [pitch, yaw, name] of looks) {
    describe(name, () => {
      YXZ.set(pitch, yaw, 0, 'YXZ')
      camera.quaternion.setFromEuler(YXZ)
      const before = camera.quaternion.clone()
      const forwardBefore = new THREE.Vector3(0, 0, -1).applyQuaternion(before)

      // Exactly what files.js writes, and reads back.
      const saved = [camera.rotation.x, camera.rotation.y, camera.rotation.z]
      const payloadIsFinite = saved.every(Number.isFinite)

      camera.quaternion.identity()
      camera.rotation.set(...saved)

      const forwardAfter = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
      const viewDirectionPreserved = forwardBefore.distanceTo(forwardAfter) < 1e-9
      const fullOrientationPreserved = Math.abs(Math.abs(before.dot(camera.quaternion)) - 1) < 1e-9

      // And the controls have to be able to keep turning from the restored state.
      const resumed = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
      const controlsResume = Math.abs(resumed.x - pitch) < 1e-9 && Math.abs(Math.cos(resumed.y) - Math.cos(yaw)) < 1e-9

      it('payload is finite', () => expect(payloadIsFinite).toBe(true))
      it('view direction preserved', () => expect(viewDirectionPreserved).toBe(true))
      it('full orientation preserved', () => expect(fullOrientationPreserved).toBe(true))
      it('controls resume from it', () => expect(controlsResume).toBe(true))
    })
  }

  it('camera euler order is still the default', () => expect(camera.rotation.order).toBe('XYZ'))
})

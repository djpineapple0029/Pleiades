import * as THREE from '/Users/dempseypalmer/PycharmProjects/AtlasMap/frontend/node_modules/three/build/three.module.js'

let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))

// PointerLockControls drives the camera through a YXZ euler and writes the
// quaternion; the payload stores camera.rotation, which is XYZ. The round trip
// has to survive that mismatch.
const YXZ = new THREE.Euler(0, 0, 0, 'YXZ')
const camera = new THREE.PerspectiveCamera(70, 1.5, 0.5, 20000)

const looks = [
  [0, 0, 'level, facing -Z'],
  [0.3, -2.1, 'yawed past a right angle'],
  [-Math.PI / 2 + 0.0001, 3.0, 'pitched to the clamp, looking down'],
  [Math.PI / 2 - 0.0001, -3.0, 'pitched to the clamp, looking up'],
  [1.2, 5.9, 'yaw wrapped past 2pi'],
]

for (const [pitch, yaw, name] of looks) {
  YXZ.set(pitch, yaw, 0, 'YXZ')
  camera.quaternion.setFromEuler(YXZ)
  const before = camera.quaternion.clone()
  const forwardBefore = new THREE.Vector3(0, 0, -1).applyQuaternion(before)

  // Exactly what files.js writes, and reads back.
  const saved = [camera.rotation.x, camera.rotation.y, camera.rotation.z]
  check(`${name}: payload is finite`, saved.every(Number.isFinite), saved)

  camera.quaternion.identity()
  camera.rotation.set(...saved)

  const forwardAfter = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  check(`${name}: view direction preserved`, forwardBefore.distanceTo(forwardAfter) < 1e-9,
    `${forwardBefore.toArray()} vs ${forwardAfter.toArray()}`)
  check(`${name}: full orientation preserved`, Math.abs(Math.abs(before.dot(camera.quaternion)) - 1) < 1e-9)

  // And the controls have to be able to keep turning from the restored state.
  const resumed = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
  check(`${name}: controls resume from it`,
    Math.abs(resumed.x - pitch) < 1e-9 && Math.abs(Math.cos(resumed.y) - Math.cos(yaw)) < 1e-9,
    `${resumed.x} vs ${pitch}, ${resumed.y} vs ${yaw}`)
}

check('camera euler order is still the default', camera.rotation.order === 'XYZ', camera.rotation.order)
console.log(`\n${ok} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)

import * as THREE from 'three'
import { seededRandom } from './random.js'

// Faint motes at fixed world positions, so flying reads as motion even in a
// map with nothing in it yet; the sky is at infinity and only shows turning.
// The motes fill one cube CELL units across, and the shader repeats that cube
// around the camera, so there is dust wherever you fly.
const COUNT = 1400
const CELL = 1600
// Motes fade in from nothing at FADE_FAR, full by FADE_NEAR, so the repeat's
// seam (CELL / 2 away along an axis at the nearest) is never seen.
const FADE_FAR = 760
const FADE_NEAR = 180
// Motes closer than this fade out again, rather than swelling into blobs as
// they pass the camera.
const TOO_CLOSE = 12
const SEED = 0x64757374

const VERTEX = /* glsl */ `
attribute float shade; // 0..1, per mote
uniform float pixelRatio;
varying float vLight;
void main() {
  // The mote's copy nearest the camera: each axis wrapped into
  // [-CELL/2, CELL/2) around it.
  vec3 offset = mod(position - cameraPosition + 0.5 * CELL, CELL) - 0.5 * CELL;
  vec4 view = viewMatrix * vec4(cameraPosition + offset, 1.0);
  float dist = length(offset);
  vLight = shade * smoothstep(FADE_FAR, FADE_NEAR, dist) * smoothstep(0.0, TOO_CLOSE, dist);
  gl_PointSize = max(1.5 * pixelRatio, 2.0);
  gl_Position = projectionMatrix * view;
}
`

const FRAGMENT = /* glsl */ `
varying float vLight;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  gl_FragColor = vec4(vec3(0.55, 0.62, 0.75) * vLight * exp(-4.0 * dot(p, p)), 1.0);
  #include <colorspace_fragment>
}
`

export function createDust() {
  const rand = seededRandom(SEED)
  const positions = new Float32Array(COUNT * 3)
  const shades = new Float32Array(COUNT)
  for (let i = 0; i < COUNT; i++) {
    for (let a = 0; a < 3; a++) positions[i * 3 + a] = (rand() - 0.5) * CELL
    shades[i] = 0.05 + 0.1 * rand()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('shade', new THREE.BufferAttribute(shades, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 } },
    defines: {
      CELL: CELL.toFixed(1),
      FADE_FAR: FADE_FAR.toFixed(1),
      FADE_NEAR: FADE_NEAR.toFixed(1),
      TOO_CLOSE: TOO_CLOSE.toFixed(1),
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'dust'
  // Positions are wrapped in the shader, so the geometry's bounds mean nothing.
  points.frustumCulled = false
  points.renderOrder = -1
  points.onBeforeRender = (renderer) => {
    material.uniforms.pixelRatio.value = renderer.getPixelRatio()
  }
  return points
}

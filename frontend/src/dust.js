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

// The looks (`looks.js`) that draw dust. Space: fixed, faint, pinpoint motes.
// Sea: marine snow — bigger flakes, drawn to their size in the world, sinking
// slowly and wandering a little from side to side.
// Digital: square pixels rising slowly, like data drifting up out of the grid.
const STYLES = {
  space: { color: [0.55, 0.62, 0.75], gain: 1, worldSize: 0, softness: 4, fall: 0, sway: 0, square: 0 },
  sea: { color: [0.62, 0.86, 0.82], gain: 2.4, worldSize: 0.9, softness: 2.2, fall: 2.2, sway: 6, square: 0 },
  digital: { color: [0.35, 1.0, 0.85], gain: 1.5, worldSize: 0.8, softness: 0, fall: -3, sway: 0, square: 1 },
}
const MAX_PX = 7 // a flake right by the camera stops growing here, in CSS px

const VERTEX = /* glsl */ `
attribute float shade; // 0..1, per mote
uniform float pixelRatio;
uniform float pxPerUnit; // CSS px per world unit at distance 1
uniform float worldSize; // 0: always MIN px
uniform float sink; // world units fallen so far
uniform float sway; // world units of side-to-side wander
uniform float time;
varying float vLight;
void main() {
  vec3 p = position;
  p.y -= sink;
  float phase = shade * 211.0;
  p.xz += sway * vec2(sin(time * 0.31 + phase), cos(time * 0.23 + phase * 1.7));
  // The mote's copy nearest the camera: each axis wrapped into
  // [-CELL/2, CELL/2) around it.
  vec3 offset = mod(p - cameraPosition + 0.5 * CELL, CELL) - 0.5 * CELL;
  vec4 view = viewMatrix * vec4(cameraPosition + offset, 1.0);
  float dist = length(offset);
  vLight = shade * smoothstep(FADE_FAR, FADE_NEAR, dist) * smoothstep(0.0, TOO_CLOSE, dist);
  float px = clamp(worldSize * pxPerUnit / dist, 1.5, MAX_PX);
  gl_PointSize = max(px * pixelRatio, 2.0);
  gl_Position = projectionMatrix * view;
}
`

const FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float gain;
uniform float softness;
uniform float square; // 1: a hard square pixel instead of a soft dot
varying float vLight;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float shape = mix(exp(-softness * dot(p, p)), 1.0 - step(0.7, max(abs(p.x), abs(p.y))), square);
  gl_FragColor = vec4(color * gain * vLight * shape, 1.0);
  #include <colorspace_fragment>
}
`

/**
 * `object` goes in the scene. `setStyle('space' | 'sea' | 'digital' | null)`
 * picks the look's dust, null for none; `update(dt)` lets sea dust sink and
 * digital dust rise (pass 0 to hold it still).
 */
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
    uniforms: {
      pixelRatio: { value: 1 },
      pxPerUnit: { value: 1 },
      worldSize: { value: 0 },
      sink: { value: 0 },
      sway: { value: 0 },
      time: { value: 0 },
      color: { value: new THREE.Vector3() },
      gain: { value: 1 },
      softness: { value: 4 },
      square: { value: 0 },
    },
    defines: {
      MAX_PX: MAX_PX.toFixed(1),
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
  const bufferSize = new THREE.Vector2()
  points.onBeforeRender = (renderer, scene, camera) => {
    material.uniforms.pixelRatio.value = renderer.getPixelRatio()
    // CSS px per unit at distance 1: half the view's CSS height times the
    // projection's vertical scale.
    renderer.getSize(bufferSize)
    material.uniforms.pxPerUnit.value = 0.5 * bufferSize.y * camera.projectionMatrix.elements[5]
  }

  let style = STYLES.space
  function setStyle(name) {
    points.visible = name !== null
    if (name === null) return
    style = STYLES[name]
    const u = material.uniforms
    u.color.value.fromArray(style.color)
    u.gain.value = style.gain
    u.worldSize.value = style.worldSize
    u.softness.value = style.softness
    u.sway.value = style.sway
    u.square.value = style.square
  }
  setStyle('space')

  function update(dt) {
    if (!style.fall && !style.sway) return
    const u = material.uniforms
    // Wrapped at a whole cell, which the shader's repeat can't tell apart
    // from no fall at all, so the float never grows.
    u.sink.value = (u.sink.value + dt * style.fall) % CELL
    u.time.value = (u.time.value + dt) % 10000
  }

  function dispose() {
    geometry.dispose()
    material.dispose()
  }

  return { object: points, setStyle, update, dispose }
}

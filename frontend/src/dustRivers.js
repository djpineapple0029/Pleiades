import * as THREE from 'three'
import { createRiverFlow, TRAIL_POINTS } from './riverFlow.js'

// Grain diameter in world units, drawn between GRAIN_MIN_PX and GRAIN_MAX_PX
// (CSS px) and fainter by area below the minimum, as the edge motes are.
const GRAIN_SIZE = 0.9
const GRAIN_MIN_PX = 1.6
const GRAIN_MAX_PX = 4.5
// Rivers read from further off than the motes do, but still fog out: from
// across a big map they'd only be a haze over the stars.
const FOG_NEAR = 200
const FOG_FAR = 1100
// Overall strength: a grain is fainter than a mote, but there are far more.
const GAIN = 1.3

// Each grain draws a tail through the positions it remembers (`riverFlow.js`),
// fading out along it, so the dust reads as flowing strands and a still frame
// still shows which way it runs.
const STREAK_GAIN = 1.15
// How fast the tail fades toward its end: higher is a shorter-looking tail.
const TAIL_FALLOFF = 0.9

// Warm by a star, cool out in the river. Linear RGB.
const WARM = new THREE.Color().setRGB(1.0, 0.72, 0.45, THREE.SRGBColorSpace)
const COOL = new THREE.Color().setRGB(0.5, 0.6, 0.78, THREE.SRGBColorSpace)

const VERTEX = /* glsl */ `
uniform vec2 resolution; // CSS px
uniform float pixelRatio;
uniform vec3 warm;
uniform vec3 cool;
uniform float dim; // 1 normally; lower while a search dims the map
attribute float light;
attribute float heat;
varying vec3 vColor;
void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  float size = GRAIN_SIZE * 0.5 * resolution.y * projectionMatrix[1][1] / max(-view.z, 1e-3);
  float drawn = clamp(size, GRAIN_MIN_PX, GRAIN_MAX_PX);
  float coverage = min(1.0, size / GRAIN_MIN_PX);
  float fog = 1.0 - smoothstep(FOG_NEAR, FOG_FAR, length(view.xyz));
  // Brighter by a star, as if lit by it.
  float lit = light * GAIN * (0.55 + 0.45 * heat) * fog * coverage * coverage * dim;
  vColor = mix(cool, warm, heat) * lit;
  gl_PointSize = drawn * pixelRatio;
  gl_Position = projectionMatrix * view;
  // Outside the clip volume: no fragments for a grain that would add nothing.
  if (lit <= 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

const FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  gl_FragColor = vec4(vColor * exp(-3.0 * r2) * (1.0 - smoothstep(0.7, 1.0, r2)), 1.0);
  #include <colorspace_fragment>
}
`

// Streaks: a GL line per grain, head bright, tail at nothing.
const STREAK_VERTEX = /* glsl */ `
uniform vec3 warm;
uniform vec3 cool;
uniform float dim;
attribute float light;
attribute float heat;
varying vec3 vColor;
void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  float fog = 1.0 - smoothstep(FOG_NEAR, FOG_FAR, length(view.xyz));
  vColor = mix(cool, warm, heat) * light * STREAK_GAIN * (0.55 + 0.45 * heat) * fog * dim;
  gl_Position = projectionMatrix * view;
}
`

const STREAK_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
  #include <colorspace_fragment>
}
`

const glslFloat = (value) => value.toFixed(4)

/**
 * Dust that swirls around stars and flows along links (see `riverFlow.js`),
 * as one `Points` drawn with the edges on layer 0: it doesn't bloom, so it
 * stays a texture under the stars rather than competing with them.
 */
export function createDustRivers(graph, parent, { radiusOf }) {
  const flow = createRiverFlow(graph, { radiusOf })

  const geometry = new THREE.BufferGeometry()
  const position = new THREE.BufferAttribute(flow.positions, 3).setUsage(THREE.DynamicDrawUsage)
  const light = new THREE.BufferAttribute(flow.light, 1).setUsage(THREE.DynamicDrawUsage)
  const heat = new THREE.BufferAttribute(flow.heat, 1).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', position)
  geometry.setAttribute('light', light)
  geometry.setAttribute('heat', heat)
  geometry.setDrawRange(0, 0)

  const size = new THREE.Vector2()
  const material = new THREE.ShaderMaterial({
    uniforms: {
      resolution: { value: new THREE.Vector2(1, 1) },
      pixelRatio: { value: 1 },
      warm: { value: WARM },
      cool: { value: COOL },
      dim: { value: 1 },
    },
    defines: {
      GRAIN_SIZE: glslFloat(GRAIN_SIZE),
      GRAIN_MIN_PX: glslFloat(GRAIN_MIN_PX),
      GRAIN_MAX_PX: glslFloat(GRAIN_MAX_PX),
      FOG_NEAR: glslFloat(FOG_NEAR),
      FOG_FAR: glslFloat(FOG_FAR),
      GAIN: glslFloat(GAIN),
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'dust-rivers'
  // Grains go wherever the stars are; bounds would be stale every frame.
  points.frustumCulled = false
  // With the edge motes: after the lines, which would dim grains under them.
  points.renderOrder = 0.5
  points.onBeforeRender = (r) => {
    r.getSize(size)
    material.uniforms.resolution.value.copy(size)
    material.uniforms.pixelRatio.value = r.getPixelRatio()
  }
  parent.add(points)

  // TRAIL_POINTS segments per grain: head to newest sample, then sample to sample.
  const perGrain = TRAIL_POINTS * 2
  const streakPositions = new Float32Array(flow.light.length * perGrain * 3)
  const streakLight = new Float32Array(flow.light.length * perGrain)
  const streakHeat = new Float32Array(flow.light.length * perGrain)
  const tailLight = Float32Array.from(
    { length: TRAIL_POINTS + 1 },
    (_, i) => (1 - i / TRAIL_POINTS) ** TAIL_FALLOFF,
  )
  const streakGeometry = new THREE.BufferGeometry()
  const streakPosition = new THREE.BufferAttribute(streakPositions, 3).setUsage(THREE.DynamicDrawUsage)
  const streakLit = new THREE.BufferAttribute(streakLight, 1).setUsage(THREE.DynamicDrawUsage)
  const streakWarm = new THREE.BufferAttribute(streakHeat, 1).setUsage(THREE.DynamicDrawUsage)
  streakGeometry.setAttribute('position', streakPosition)
  streakGeometry.setAttribute('light', streakLit)
  streakGeometry.setAttribute('heat', streakWarm)
  streakGeometry.setDrawRange(0, 0)
  const streakMaterial = new THREE.ShaderMaterial({
    uniforms: { warm: material.uniforms.warm, cool: material.uniforms.cool, dim: material.uniforms.dim },
    defines: {
      FOG_NEAR: glslFloat(FOG_NEAR),
      FOG_FAR: glslFloat(FOG_FAR),
      STREAK_GAIN: glslFloat(STREAK_GAIN * GAIN),
    },
    vertexShader: STREAK_VERTEX,
    fragmentShader: STREAK_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const streaks = new THREE.LineSegments(streakGeometry, streakMaterial)
  streaks.name = 'dust-river-streaks'
  streaks.frustumCulled = false
  streaks.renderOrder = 0.5
  parent.add(streaks)

  /** Every grain's tail, as line segments through its remembered positions. */
  function writeStreaks(count) {
    const p = flow.positions
    const trail = flow.trail
    const valid = flow.trailValid
    const head = flow.trailHead
    for (let g = 0; g < count; g++) {
      const n = valid[g]
      const base = g * perGrain
      const lit = flow.light[g]
      const warmth = flow.heat[g]
      // Previous vertex: starts at the grain itself.
      let px = p[g * 3]
      let py = p[g * 3 + 1]
      let pz = p[g * 3 + 2]
      for (let i = 0; i < TRAIL_POINTS; i++) {
        const v = base + i * 2
        let qx = px
        let qy = py
        let qz = pz
        if (i < n) {
          const slot = (head - i + TRAIL_POINTS) % TRAIL_POINTS
          const o = (g * TRAIL_POINTS + slot) * 3
          qx = trail[o]
          qy = trail[o + 1]
          qz = trail[o + 2]
        }
        streakPositions[v * 3] = px
        streakPositions[v * 3 + 1] = py
        streakPositions[v * 3 + 2] = pz
        streakPositions[v * 3 + 3] = qx
        streakPositions[v * 3 + 4] = qy
        streakPositions[v * 3 + 5] = qz
        // Unsampled segments collapse to a point and carry no light.
        const on = i < n ? lit : 0
        streakLight[v] = on * tailLight[i]
        streakLight[v + 1] = on * tailLight[i + 1]
        streakHeat[v] = streakHeat[v + 1] = warmth
        px = qx
        py = qy
        pz = qz
      }
    }
  }

  /**
   * Hides the rivers without advancing them — for motion switched off. The
   * next `update` picks up where they left off, tails carried along with any
   * star that moved in between.
   */
  function hide() {
    points.visible = streaks.visible = false
  }

  /**
   * Advances the rivers by `dt` seconds and uploads them. `shocks` are shells
   * pushing grains outward.
   */
  function update(dt, shocks) {
    flow.step(dt, shocks)
    const count = flow.count
    geometry.setDrawRange(0, count)
    streakGeometry.setDrawRange(0, count * perGrain)
    points.visible = streaks.visible = count > 0
    if (count === 0) return
    writeStreaks(count)
    for (const [attribute, itemSize] of [
      [position, 3],
      [light, 1],
      [heat, 1],
      [streakPosition, perGrain * 3],
      [streakLit, perGrain],
      [streakWarm, perGrain],
    ]) {
      attribute.clearUpdateRanges()
      attribute.addUpdateRange(0, count * itemSize)
      attribute.needsUpdate = true
    }
  }

  function dispose() {
    parent.remove(points, streaks)
    geometry.dispose()
    material.dispose()
    streakGeometry.dispose()
    streakMaterial.dispose()
  }

  /** Scales every grain and tail's light: 1 is normal. Search dims the map. */
  function setDim(level) {
    material.uniforms.dim.value = level
  }

  return { update, hide, setDim, dispose, object: points }
}

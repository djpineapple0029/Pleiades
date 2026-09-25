import * as THREE from 'three'
import { STAR_LAYER } from './bloom.js'

/**
 * The supernova a star goes out with when it is deleted: a flash where it was,
 * a clumpy puff of its own gas thrown out and slowed by drag, a few fast
 * sparks, and a thin shockwave shell. Everything is on STAR_LAYER, so it
 * blooms exactly as the stars do, and everything is worked out in the shaders
 * from one `age` per burst — the CPU only counts time.
 *
 * All sizes are in radii of the star that went, so a core goes out bigger.
 * `shocks()` hands the live shells to the dust rivers, which get blown aside.
 */

// Bursts that can be alive at once; a fifth reuses the oldest slot.
const SLOTS = 4
const PUFF = 420
const SPARKS = 60
// Lobes the puff's directions cluster around, so it is irregular, not a ball.
const LOBES_MIN = 5
const LOBES_RANGE = 3
// Seconds.
const FLASH_LIFE = 0.45
const SHOCK_LIFE = 1.0
const BURST_LIFE = 1.9
// Shock radius it eases out to, in radii, and the time constant it eases with.
const SHOCK_REACH = 7
const SHOCK_EASE = 0.28
// Flash billboard half-size, in radii.
const FLASH_EXTENT = 6
// Push the shell gives the dust, world units per second at its crest.
const SHOCK_PUSH = 260

const BILLBOARD_VERTEX = /* glsl */ `
uniform vec3 center;
uniform float extent; // half-size, world units
varying vec2 vOffset; // -1..1 across the quad
void main() {
  vOffset = position.xy;
  vec4 view = modelViewMatrix * vec4(center, 1.0);
  view.xy += position.xy * extent;
  gl_Position = projectionMatrix * view;
}
`

// A white-hot blowout that tints to the star's colour as it goes.
const FLASH_FRAGMENT = /* glsl */ `
uniform float age;
uniform vec3 tint;
varying vec2 vOffset;
void main() {
  float r = length(vOffset) * FLASH_EXTENT; // in radii
  // Up in 40 ms, then away exponentially.
  float rise = smoothstep(0.0, 0.04, age);
  float fall = exp(-max(age - 0.04, 0.0) / 0.09);
  float spread = 1.0 + 2.2 * age / FLASH_LIFE;
  float rs = r / spread;
  // A sharp peak with a long soft skirt: a point blowing out, never a disc.
  float core = exp(-rs * rs * 5.0);
  float glow = exp(-rs * 1.8) * 0.4;
  vec3 hot = mix(vec3(1.0), tint, smoothstep(0.0, 0.25, age));
  vec3 colour = (hot * core * 1.6 + mix(hot, tint, 0.5) * glow) * rise * fall;
  colour *= 1.0 - smoothstep(0.85, 1.0, length(vOffset));
  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
}
`

// A thin shell seen through: light is the path length through it, so it is
// brightest at its rim and reads as a bubble, not a flat ring. Each channel
// sits at a slightly different radius, a faint colour split at the rim.
const SHOCK_FRAGMENT = /* glsl */ `
uniform float age;
uniform vec3 tint;
uniform float reach; // shell radius as a share of the billboard half-size
varying vec2 vOffset;

float shell(float q, float s) {
  const float thickness = 0.035;
  float outer = sqrt(max(s * s - q * q, 0.0));
  float inner = sqrt(max((s - thickness * s) * (s - thickness * s) - q * q, 0.0));
  // Path length through the shell, over its thickness: 2 face-on, climbing to
  // ~7 at the limb. Only the limb should read, so the face-on part is taken
  // out and what is left is kept faint.
  float path = (outer - inner) / (thickness * s);
  return max(path - 2.2, 0.0) * 0.09;
}

void main() {
  float q = length(vOffset);
  vec3 split = vec3(shell(q, reach * 1.012), shell(q, reach), shell(q, reach * 0.985));
  float life = age / SHOCK_LIFE;
  float fade = (1.0 - life) * (1.0 - life) * smoothstep(0.0, 0.03, age);
  vec3 colour = mix(vec3(0.75, 0.85, 1.0), tint, 0.35) * split * fade;
  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
}
`

const PARTICLE_VERTEX = /* glsl */ `
uniform vec3 center;
uniform float radius; // of the star that went, world units
uniform float age;
uniform vec2 resolution; // CSS px
uniform float pixelRatio;
uniform vec3 tint;
attribute vec3 direction;
attribute vec4 motion; // reach (radii), drag time constant (s), life (s), size (radii)
attribute float spark;
varying vec3 vColor;
void main() {
  float reach = motion.x;
  float tau = motion.y;
  float life = motion.z;
  // Thrown out fast and slowed by drag: it settles as a hanging cloud.
  float travel = reach * (1.0 - exp(-age / tau));
  vec3 world = center + direction * travel * radius;
  vec4 view = modelViewMatrix * vec4(world, 1.0);

  float t = clamp(age / life, 0.0, 1.0);
  float alive = smoothstep(0.0, 0.03, age) * pow(1.0 - t, 1.6) * step(age, life);
  float grow = mix(1.0, 1.35, t) * mix(1.0, 0.6, spark);
  float size = motion.w * grow * radius * 0.5 * resolution.y * projectionMatrix[1][1] / max(-view.z, 1e-3);
  float drawn = clamp(size, 1.5, 7.0);
  float coverage = min(1.0, size / 1.5);

  // White-hot, then the star's own colour, then cooling deeper and redder.
  vec3 deep = tint * vec3(1.0, 0.55, 0.4) * 0.7;
  vec3 gas = mix(mix(vec3(1.0), tint, smoothstep(0.0, 0.18, t)), deep, smoothstep(0.3, 1.0, t));
  vec3 ember = mix(vec3(1.0, 0.95, 0.85), vec3(1.0, 0.6, 0.3), t);
  // Big soft blobs overlap, so each is kept faint; sparks are small and bright.
  float gain = mix(0.55, 1.3, spark);
  vColor = mix(gas, ember, spark) * alive * gain * coverage * coverage;
  gl_PointSize = drawn * pixelRatio;
  gl_Position = projectionMatrix * view;
  if (alive <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

const PARTICLE_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  gl_FragColor = vec4(vColor * exp(-3.2 * r2) * (1.0 - smoothstep(0.7, 1.0, r2)), 1.0);
  #include <colorspace_fragment>
}
`

const glslFloat = (value) => value.toFixed(4)
const DEFINES = {
  FLASH_EXTENT: glslFloat(FLASH_EXTENT),
  FLASH_LIFE: glslFloat(FLASH_LIFE),
  SHOCK_LIFE: glslFloat(SHOCK_LIFE),
}

function additive(uniforms, vertexShader, fragmentShader) {
  return new THREE.ShaderMaterial({
    uniforms,
    defines: DEFINES,
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  })
}

/** A unit vector uniform on the sphere, from `rand`. */
function onSphere(rand, out) {
  const z = 2 * rand() - 1
  const a = Math.PI * 2 * rand()
  const s = Math.sqrt(1 - z * z)
  out[0] = s * Math.cos(a)
  out[1] = s * Math.sin(a)
  out[2] = z
  return out
}

export function createSupernova(scene, { rand = Math.random } = {}) {
  const root = new THREE.Group()
  root.name = 'supernova'
  scene.add(root)
  const quad = new THREE.PlaneGeometry(2, 2)
  const size = new THREE.Vector2()

  const slots = []
  for (let i = 0; i < SLOTS; i++) {
    const shared = {
      center: { value: new THREE.Vector3() },
      age: { value: 0 },
      tint: { value: new THREE.Color(1, 1, 1) },
    }
    const flashUniforms = { ...shared, extent: { value: 1 } }
    const shockUniforms = { ...shared, extent: { value: 1 }, reach: { value: 0 } }
    const particleUniforms = {
      ...shared,
      radius: { value: 1 },
      resolution: { value: new THREE.Vector2(1, 1) },
      pixelRatio: { value: 1 },
    }

    const flash = new THREE.Mesh(quad, additive(flashUniforms, BILLBOARD_VERTEX, FLASH_FRAGMENT))
    const shock = new THREE.Mesh(quad, additive(shockUniforms, BILLBOARD_VERTEX, SHOCK_FRAGMENT))

    const total = PUFF + SPARKS
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3))
    geometry.setAttribute('direction', new THREE.BufferAttribute(new Float32Array(total * 3), 3))
    geometry.setAttribute('motion', new THREE.BufferAttribute(new Float32Array(total * 4), 4))
    geometry.setAttribute('spark', new THREE.BufferAttribute(new Float32Array(total), 1))
    const particles = new THREE.Points(geometry, additive(particleUniforms, PARTICLE_VERTEX, PARTICLE_FRAGMENT))
    particles.onBeforeRender = (renderer) => {
      renderer.getSize(size)
      particleUniforms.resolution.value.copy(size)
      particleUniforms.pixelRatio.value = renderer.getPixelRatio()
    }

    for (const object of [shock, particles, flash]) {
      object.layers.set(STAR_LAYER)
      object.frustumCulled = false
      object.visible = false
      root.add(object)
    }
    // Over the stars around it, in the order the eye should read them.
    shock.renderOrder = 3
    particles.renderOrder = 4
    flash.renderOrder = 5

    slots.push({
      shared,
      flashUniforms,
      shockUniforms,
      particleUniforms,
      flash,
      shock,
      particles,
      geometry,
      age: Infinity,
      radius: 1,
      reduced: false,
    })
  }

  /** Fills a slot's particle buffers for a new burst: clumpy lobes plus sparks. */
  function seedParticles(slot) {
    const direction = slot.geometry.getAttribute('direction')
    const motion = slot.geometry.getAttribute('motion')
    const spark = slot.geometry.getAttribute('spark')
    const lobes = []
    const count = LOBES_MIN + Math.floor(rand() * LOBES_RANGE)
    for (let i = 0; i < count; i++) lobes.push({ dir: onSphere(rand, [0, 0, 0]), weight: 0.6 + rand() })
    const v = [0, 0, 0]
    for (let i = 0; i < PUFF + SPARKS; i++) {
      const isSpark = i >= PUFF
      onSphere(rand, v)
      if (!isSpark && rand() < 0.8) {
        // Pulled toward a lobe: most gas goes out in a handful of plumes.
        const lobe = lobes[Math.floor(rand() * lobes.length)]
        const pull = 0.45 + 0.4 * rand()
        for (let a = 0; a < 3; a++) v[a] = v[a] * (1 - pull) + lobe.dir[a] * pull
        const l = Math.hypot(v[0], v[1], v[2]) || 1
        for (let a = 0; a < 3; a++) v[a] /= l
      }
      direction.setXYZ(i, v[0], v[1], v[2])
      if (isSpark) {
        // reach, drag, life, size — sparks outrun the gas and die young.
        motion.setXYZW(i, 6 + 6 * rand(), 0.16 + 0.14 * rand(), 0.45 + 0.4 * rand(), 0.12 + 0.06 * rand())
      } else {
        // The gas: most near the middle, some thrown well out.
        const reach = 1.0 + 4.5 * rand() ** 1.4
        motion.setXYZW(i, reach, 0.22 + 0.4 * rand(), 0.9 + 0.8 * rand(), 0.2 + 0.35 * rand())
      }
      spark.setX(i, isSpark ? 1 : 0)
    }
    direction.needsUpdate = true
    motion.needsUpdate = true
    spark.needsUpdate = true
  }

  /**
   * Sets a star off where it was. `tint` is linear RGB (`view.tintOf`); null
   * falls back to white. `reduced`: the flash alone, short, nothing thrown.
   */
  function burst({ position, radius, tint, reduced = false }) {
    // The free slot, or the one that went off longest ago.
    let slot = slots[0]
    for (const s of slots) if (s.age > slot.age) slot = s
    slot.age = 0
    slot.radius = radius
    slot.reduced = reduced
    slot.shared.center.value.set(position.x, position.y, position.z)
    if (tint) slot.shared.tint.value.setRGB(tint[0], tint[1], tint[2])
    else slot.shared.tint.value.setRGB(1, 1, 1)
    slot.flashUniforms.extent.value = radius * FLASH_EXTENT
    slot.particleUniforms.radius.value = radius
    if (!reduced) seedParticles(slot)
    apply(slot)
  }

  function shockRadius(slot) {
    return slot.radius * SHOCK_REACH * (1 - Math.exp(-slot.age / SHOCK_EASE))
  }

  function apply(slot) {
    const age = slot.age
    slot.shared.age.value = slot.reduced ? age * 2 : age
    slot.flash.visible = age < (slot.reduced ? FLASH_LIFE / 2 : FLASH_LIFE)
    slot.particles.visible = !slot.reduced && age < BURST_LIFE
    slot.shock.visible = !slot.reduced && age < SHOCK_LIFE
    if (slot.shock.visible) {
      // Billboard a little bigger than the shell, so its rim never clips.
      const extent = slot.radius * SHOCK_REACH * 1.1
      slot.shockUniforms.extent.value = extent
      slot.shockUniforms.reach.value = shockRadius(slot) / extent
    }
  }

  /** Advances every burst by `dt` seconds. */
  function update(dt) {
    for (const slot of slots) {
      if (slot.age === Infinity) continue
      slot.age += dt
      if (slot.age > BURST_LIFE) {
        slot.age = Infinity
        slot.flash.visible = slot.particles.visible = slot.shock.visible = false
        continue
      }
      apply(slot)
    }
  }

  /** The live shells, as `riverFlow.step` takes them. */
  function shocks() {
    const out = []
    for (const slot of slots) {
      if (slot.reduced || !(slot.age < SHOCK_LIFE)) continue
      const radius = shockRadius(slot)
      const c = slot.shared.center.value
      const life = slot.age / SHOCK_LIFE
      out.push({
        x: c.x,
        y: c.y,
        z: c.z,
        radius,
        width: Math.max(0.35 * radius, 2),
        strength: SHOCK_PUSH * (slot.radius / 5) * (1 - life) * (1 - life),
      })
    }
    return out
  }

  function dispose() {
    scene.remove(root)
    quad.dispose()
    for (const slot of slots) {
      slot.flash.material.dispose()
      slot.shock.material.dispose()
      slot.particles.material.dispose()
      slot.geometry.dispose()
    }
  }

  return { burst, update, shocks, dispose }
}

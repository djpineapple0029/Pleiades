import * as THREE from 'three'

// Cyberspace's floor (`looks.js`): a neon grid on a plane under the map,
// stretching to the horizon. It is in the world, not the sky, so it slides
// by underneath as you fly; the quad follows the camera across and the lines
// are worked out from world position, so there is floor wherever you go.
const SIZE = 16000 // half-width of the quad round the camera, world units
const MINOR = 40 // world units between minor lines
const MAJOR = 200 // and between major ones
// Below the lowest star by this much, so the map floats over the floor.
const GAP = 260
// Where there's no map yet: this far below the camera.
const EMPTY_DROP = 300
// Seconds per scan pulse, and how far one travels.
const SCAN_PERIOD = 5
const SCAN_REACH = 3200
// Seconds for the floor to settle at a new height after the map moves.
const SETTLE = 0.6
// How often, in frames, the lowest star is looked for again. Physics moves
// stars without bumping the graph's revision.
const RESCAN_FRAMES = 20

const VERTEX = /* glsl */ `
uniform float floorY;
varying vec3 vWorld;
void main() {
  vWorld = vec3(cameraPosition.x + position.x * SIZE, floorY, cameraPosition.z + position.y * SIZE);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`

const FRAGMENT = /* glsl */ `
uniform vec3 minorColor;
uniform vec3 majorColor;
uniform float scan; // 0..1 through the current pulse
varying vec3 vWorld;

// 1 on a line, 0 a pixel and a bit away; also how blurred the lines are here.
float lines(vec2 p, float spacing, float width, out float blur) {
  vec2 c = p / spacing;
  vec2 w = fwidth(c);
  blur = max(w.x, w.y);
  vec2 f = abs(fract(c - 0.5) - 0.5) / max(w, 1e-5);
  return 1.0 - min(min(f.x, f.y) / width, 1.0);
}

void main() {
  float blurMinor, blurMajor;
  float minor = lines(vWorld.xz, MINOR, 1.0, blurMinor);
  float major = lines(vWorld.xz, MAJOR, 1.3, blurMajor);
  // Where the lines crowd closer than a few pixels they'd shimmer into a
  // moire: fade them out there, the minor ones first.
  minor *= 1.0 - smoothstep(0.15, 0.4, blurMinor);
  major *= 1.0 - smoothstep(0.2, 0.5, blurMajor);
  float dist = length(vWorld.xz - cameraPosition.xz);
  // The far floor fades out over the sky's own glow below the horizon
  // (skybox.js), so the two meet without a band.
  float fade = exp(-dist / 3000.0) * smoothstep(SIZE, SIZE * 0.5, dist);
  // A ring of light running out across the floor from under the camera.
  float ring = scan * SCAN_REACH;
  float pulse = exp(-abs(dist - ring) / 45.0) * (1.0 - scan);
  vec3 colour = minorColor * minor * 0.4 + majorColor * major
    + majorColor * pulse * (0.15 + 0.6 * major + 0.6 * minor);
  gl_FragColor = vec4(colour * fade, 1.0);
  #include <colorspace_fragment>
}
`

/**
 * `object` goes in the scene, hidden until `setOn(true)`. `update(dt, camera,
 * graph)` each frame keeps it under the map and runs the scan (dt 0 holds it).
 * `setColors(minor, major)` takes hex numbers.
 */
export function createGrid() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      floorY: { value: 0 },
      scan: { value: 0 },
      minorColor: { value: new THREE.Color(0x0a5c78) },
      majorColor: { value: new THREE.Color(0xe0308f) },
    },
    defines: {
      SIZE: SIZE.toFixed(1),
      MINOR: MINOR.toFixed(1),
      MAJOR: MAJOR.toFixed(1),
      SCAN_REACH: SCAN_REACH.toFixed(1),
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  mesh.name = 'grid'
  // Positioned in the shader, so the geometry's own bounds mean nothing.
  mesh.frustumCulled = false
  // After the sky, before the map.
  mesh.renderOrder = -1
  mesh.visible = false

  let target = null
  let frames = 0
  let time = 0

  function lowest(graph, camera) {
    let min = Infinity
    for (const node of graph.nodes.values()) if (node.y < min) min = node.y
    return Number.isFinite(min) ? min - GAP : camera.position.y - EMPTY_DROP
  }

  function update(dt, camera, graph) {
    if (!mesh.visible) return
    if (target === null || frames++ % RESCAN_FRAMES === 0) {
      const first = target === null
      target = lowest(graph, camera)
      if (first) material.uniforms.floorY.value = target
    }
    const y = material.uniforms.floorY
    y.value += (target - y.value) * Math.min(1, dt / SETTLE)
    time = (time + dt) % SCAN_PERIOD
    material.uniforms.scan.value = time / SCAN_PERIOD
  }

  return {
    object: mesh,
    update,
    setOn(on) {
      mesh.visible = Boolean(on)
      target = null // settle straight onto the map when it comes back
    },
    setColors(minor, major) {
      material.uniforms.minorColor.value.set(minor)
      material.uniforms.majorColor.value.set(major)
    },
    dispose() {
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}

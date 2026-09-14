import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { STAR_LAYER } from './bloom.js'
import { createEdges, EDGE_WIDTH } from './edges.js'
import { createLabels } from './labels.js'
import { clusterInk } from './palette.js'
import { hash32 } from './random.js'

export const NODE_RADIUS = 5

// Half-width of a star's billboard, in node radii. The glow and rays have to
// fade out inside it; anything reaching the edge gets clipped into a square.
const STAR_EXTENT = 4
// Star tints, sampled along blue -> white -> warm by a hash of the node id.
const TINT_BLUE = new THREE.Color().setRGB(0.5, 0.68, 1.0, THREE.SRGBColorSpace)
const TINT_WHITE = new THREE.Color().setRGB(0.92, 0.94, 1.0, THREE.SRGBColorSpace)
const TINT_WARM = new THREE.Color().setRGB(1.0, 0.7, 0.42, THREE.SRGBColorSpace)
// Seconds per pulse at rate 1. Each node runs at k / PULSE_RATE_STEPS of that,
// k drawn from PULSE_RATE_MIN..PULSE_RATE_MAX. Rates are quantised on purpose:
// over PULSE_PERIOD * PULSE_RATE_STEPS seconds every node completes a whole
// number of cycles, so the shader clock can wrap there without a visible jump,
// and a float32 time uniform never grows large enough to lose precision.
const PULSE_PERIOD = 3.6
const PULSE_RATE_STEPS = 8
const PULSE_RATE_MIN = 6 // 0.75x
const PULSE_RATE_MAX = 10 // 1.25x
const PULSE_WRAP = PULSE_PERIOD * PULSE_RATE_STEPS
// Instance slots are allocated in powers of two from here; a map that outgrows
// them gets a new InstancedMesh twice the size.
const INITIAL_CAPACITY = 256
// Time constant, in seconds, of a node easing to a new size after an edit —
// most of the way there in a quarter second, settled in about half of one.
const SIZE_EASE = 0.12
// Longest step one frame of easing may take, so a backgrounded tab or a
// stalled frame lands without skipping the whole transition.
const SIZE_EASE_MAX_STEP = 0.1
// Time constant, in seconds, of a star easing to a new tint after a
// re-partition. Slower than the size ease on purpose: a recolour is a bigger
// change than a resize, and drifting over a third of a second reads as the map
// settling rather than as a flicker.
const TINT_EASE = 0.3
// How far a clustered star is lifted toward white, by a hash of its id. Stars
// within one cluster have to differ from each other or the cluster reads as N
// copies of a single dot; the range is narrow enough that the hue still says
// which cluster the star belongs to.
const TINT_VARY_MIN = 0.05
const TINT_VARY_RANGE = 0.3

const HOVER_COLOR = 0xffbe6b
const SOURCE_COLOR = 0x6bffa8
const PENDING_COLOR = 0x6bffa8

// Extra pick width in CSS pixels on top of EDGE_WIDTH — a 2.5px line is
// otherwise almost impossible to put a crosshair on. `LineSegments2.raycast`
// picks at `material.linewidth + threshold`, so the hitbox is EDGE_WIDTH plus
// this: 23 px across, twice the 11.5 it was.
const EDGE_PICK_PADDING = 20.5
// Edges run centre-to-centre, so near an endpoint the edge is inside the node.
// Prefer the node unless the edge is clearly nearer than this many of the
// node's own radii — a core node hides a longer stretch of its edges.
const NODE_PICK_BIAS = 2
const PICK_RANGE = 2500
// Hover/source ring radius, in radii of the node it marks.
const HALO_AT = 1.35

const tint = new THREE.Color()
const clusterColor = new THREE.Color()

/**
 * A node's star, `[phase, rate, seed]`, derived from its id rather than its
 * instance slot: slots are reshuffled whenever a node is deleted, and the same
 * node should keep the same rhythm and ray pattern through that and across a
 * save and reopen.
 */
function writeStar(id, star, slot) {
  const h = hash32(id)
  star[slot * 3] = (h & 0xffff) / 0x10000
  const k = PULSE_RATE_MIN + ((h >>> 16) % (PULSE_RATE_MAX - PULSE_RATE_MIN + 1))
  star[slot * 3 + 1] = k / PULSE_RATE_STEPS
  // A second, independent hash for everything the pulse doesn't use.
  star[slot * 3 + 2] = (hash32(id, 0x9e3779b9) & 0xffff) / 0x10000
}

/**
 * A node's tint into `out`, as linear RGB.
 *
 * With no cluster (colour id 0) this is the plain star ramp — blue -> white ->
 * warm by a hash of the id — so a map that has never been balanced looks
 * exactly as it did before clustering existed. A clustered node takes its
 * cluster's hue instead, lifted toward white by that same hash so the stars
 * inside one cluster still vary.
 */
function targetTint(id, colorId, out) {
  const g = hash32(id, 0x9e3779b9)
  // Skewed toward the blue end, where most of an unclustered map sits.
  const t = ((g >>> 16) / 0x10000) ** 1.4
  const ink = clusterInk(colorId)
  if (ink) {
    clusterColor.setRGB(ink[0], ink[1], ink[2], THREE.SRGBColorSpace)
    return out.lerpColors(clusterColor, TINT_WHITE, TINT_VARY_MIN + TINT_VARY_RANGE * t)
  }
  if (t < 0.55) return out.lerpColors(TINT_BLUE, TINT_WHITE, t / 0.55)
  return out.lerpColors(TINT_WHITE, TINT_WARM, (t - 0.55) / 0.45)
}

const STAR_VERTEX = /* glsl */ `
attribute vec3 instanceStar; // phase, rate, seed
attribute vec3 instanceTint;
uniform float pulseBeat;
varying vec2 vOffset; // from the star's centre, in node radii
varying vec3 vTint;
varying float vSeed;
varying float vPulse;
varying float vFade;
// The billboard's axes and the direction to the camera, in world space.
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vToCamera;

void main() {
  // Squared so a star spends most of its cycle near the trough and swells
  // briefly, rather than sitting half-lit.
  float cycle = fract(pulseBeat * instanceStar.y + instanceStar.x);
  vPulse = 0.5 - 0.5 * cos(6.283185307 * cycle);
  vPulse *= vPulse;
  vTint = instanceTint;
  vSeed = instanceStar.z;

  // Billboard: expand the quad in view space around the instance's centre.
  // The instance scale is the node's radius.
  float radius = length(instanceMatrix[0].xyz);
  vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float dist = length(centre.xyz);
  // Flying through a star would otherwise fill the screen with white.
  vFade = smoothstep(0.8, 2.5, dist / radius);
  // The screen axes and the line of sight in world space, where the rays are
  // fixed. The quad stays square to the view plane, so a star near the edge of
  // the screen stays round; only the rays are projected along the real line of
  // sight. The view rotation is orthonormal, so its transpose is its inverse.
  mat3 viewToWorld = transpose(mat3(viewMatrix));
  vRight = viewToWorld[0];
  vUp = viewToWorld[1];
  vToCamera = viewToWorld * (-centre.xyz / dist);

  vOffset = position.xy * STAR_EXTENT;
  centre.xy += vOffset * radius;
  gl_Position = projectionMatrix * centre;
}
`

const STAR_FRAGMENT = /* glsl */ `
uniform float pulseBeat;
varying vec2 vOffset;
varying vec3 vTint;
varying float vSeed;
varying float vPulse;
varying float vFade;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vToCamera;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Which cube face the direction d falls in (0..5), and u, w, n rewritten in
// that face's frame: x along its outward axis, y and z along its two face
// coordinates. A direction (1, s1, s2) in that frame is face point (s1, s2).
float toFace(vec3 d, vec3 u, vec3 w, vec3 n, out vec3 uf, out vec3 wf, out vec3 nf) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    float g = sign(d.x);
    uf = vec3(g * u.x, u.yz); wf = vec3(g * w.x, w.yz); nf = vec3(g * n.x, n.yz);
    return g > 0.0 ? 0.0 : 1.0;
  }
  if (a.y >= a.z) {
    float g = sign(d.y);
    uf = vec3(g * u.y, u.zx); wf = vec3(g * w.y, w.zx); nf = vec3(g * n.y, n.zx);
    return g > 0.0 ? 2.0 : 3.0;
  }
  float g = sign(d.z);
  uf = vec3(g * u.z, u.xy); wf = vec3(g * w.z, w.xy); nf = vec3(g * n.z, n.xy);
  return g > 0.0 ? 4.0 : 5.0;
}

// Where face coordinate (a + t*b) / (c + t*e) of the line u + t*w reaches
// edge. Along the line it only ever moves one way within a face — the sign of
// b*c - a*e — so of a cell's two edges on that axis only one can be next.
float edgeCrossing(float a, float b, float c, float e, float lo, float hi) {
  float edge = b * c - a * e > 0.0 ? hi : lo;
  return (edge * c - a) / (b - edge * e);
}

// One family of rays, fixed in world space so that flying around a star shows
// it from a different side. The sphere of directions is cut into cube-map
// cells, G per face edge; each cell may throw one ray, with odds scaled by the
// cell's solid angle so the rays are spread evenly. Every ray has its own
// direction, brightness, length and flicker.
//
// The fragment sits at radius r along the world direction u; w points at the
// camera and n is square to both. Only rays whose direction lies on the half
// great circle through u and w project onto this fragment's screen angle.
// Written as u + t*w that arc is a straight line, so its crossings with the
// cells' boundary planes are exact and trig-free, and the loop visits exactly
// the cells the arc passes through, each once.
//
// width is the ray's half-width in node radii. shimmer is the flicker rate in
// steps per beat; 8 * shimmer must be whole, because pulseBeat wraps at 8.
float rayFamily(float r, vec3 u, vec3 w, vec3 n, float pxPerRadius, float G, float reach, float width, float shimmer, float seed) {
  float rho = r / reach;
  if (rho >= 1.0) return 0.0;

  // Rays sit in the middle half of their cell, so a ray in a cell the arc
  // misses is at least ~0.2/G radians off it, which is at least r*0.2/G on
  // screen. A cross-section kept inside 1/2.5 of that is never visibly cut off
  // by not being looked for. Below ~0.7px a ray is drawn wider and dimmer
  // instead, or it breaks up into dashes; the cut that costs is invisible at
  // that size.
  float sigma = min(width, r / (12.5 * G));
  float drawn = max(sigma, 0.7 / pxPerRadius);
  // Once neighbouring rays are only a few pixels apart they can't be told
  // apart and would just sparkle: use the family's average light at this
  // radius instead. The polynomial is fitted offline to the brightness, length
  // and foreshortening distributions below; pi*G*G is the expected number of rays.
  float average = 3.14159 * G * G * sigma / (2.5066 * r)
    * 0.1686 * pow(1.0 - rho, 3.25) * (1.0 + 0.4 * rho);
  float detail = smoothstep(2.0, 5.0, r * 1.1 / G * pxPerRadius);
  if (detail <= 0.0) return average;

  // A ray at u + t*w is foreshortened by 1/sqrt(1 + t*t); past T none is long
  // enough to reach r.
  float T = min(sqrt(1.0 / (rho * rho) - 1.0), 12.0);
  float period = 8.0 * shimmer;
  float t = -T;
  float lastId = -1.0;
  float sum = 0.0;
  for (int k = 0; k < 96; k++) {
    vec3 uf, wf, nf;
    float face = toFace(u + t * w, u, w, n, uf, wf, nf);
    vec3 df = uf + t * wf;
    vec2 s = df.yz / df.x;
    vec2 cell = clamp(floor((s * 0.5 + 0.5) * G), 0.0, G - 1.0);
    vec2 lo = cell * (2.0 / G) - 1.0;
    vec2 hi = lo + 2.0 / G;
    float id = (face * G + cell.y) * G + cell.x;
    // Solid angle of the cell relative to one at the middle of a face.
    vec2 mid = lo + 1.0 / G;
    float cellSize = inversesqrt(1.0 + dot(mid, mid));

    vec2 q = vec2(0.0);
    float x = 1e9;
    if (id != lastId && hash12(vec2(id, seed)) < cellSize * cellSize * cellSize) {
      vec2 jitter = vec2(hash12(vec2(id, seed + 3.0)), hash12(vec2(id, seed + 5.0)));
      vec3 ray = vec3(1.0, lo + (0.5 + jitter) / G);
      ray *= inversesqrt(dot(ray, ray));
      // The ray's projection, in the fragment's own screen frame.
      q = vec2(dot(ray, uf), dot(ray, nf));
      x = r * abs(q.y) / length(q) / drawn;
    }
    // Most rays in a cell the arc crosses still pass well clear of this
    // fragment; only the ones that don't are worth the rest of their hashes.
    if (x < 4.0 && q.x > 0.0) {
      float qLen = length(q);
      float along = r * q.x / qLen;
      float ft = pulseBeat * shimmer + hash12(vec2(id, seed + 13.0)) * period;
      float step0 = floor(ft);
      float flicker = mix(
        hash12(vec2(id + seed, mod(step0, period))),
        hash12(vec2(id + seed, mod(step0 + 1.0, period))),
        smoothstep(0.0, 1.0, ft - step0)
      );
      // Mostly faint rays with a few bright ones; the bright ones reach furthest.
      float strength = hash12(vec2(id, seed + 7.0));
      float len = reach * (0.3 + 0.7 * strength) * (0.85 + 0.15 * flicker) * qLen;
      float tip = max(0.0, 1.0 - along / len);
      sum += exp(-0.5 * x * x) * strength * strength * strength * (0.35 + 0.65 * flicker) * tip * sqrt(tip);
    }
    lastId = id;

    // Leave the cell by whichever face coordinate reaches its edge first. A
    // crossing that isn't ahead (or a 0/0) can't be next.
    float t1 = edgeCrossing(uf.y, wf.y, uf.x, wf.x, lo.x, hi.x);
    float t2 = edgeCrossing(uf.z, wf.z, uf.x, wf.x, lo.y, hi.y);
    float next = min(t1 > t ? t1 : T, t2 > t ? t2 : T);
    if (next >= T) break;
    t = next + 1e-4 * (1.0 + abs(next));
  }
  return mix(average, sum * sigma / drawn, detail);
}

void main() {
  float r = max(length(vOffset), 1e-3);
  float pxPerRadius = 1.0 / max(length(fwidth(vOffset)), 1e-4);
  // The fragment's screen direction, carried onto the plane square to the line
  // of sight (they differ for a star off the middle of the screen).
  vec3 w = normalize(vToCamera);
  vec3 v = vOffset.x * vRight + vOffset.y * vUp;
  vec3 u = normalize(v - dot(v, w) * w);
  vec3 n = cross(w, u);
  float seed = vSeed * 97.0;
  float swell = vPulse;

  // Few long, bright rays that stay resolvable from far off, then denser and
  // finer ones that fill in as you get closer. A family's total light grows
  // with G (more rays, each capped thinner by the cell size), so the dense
  // ones are weighted down or they add up to a grey haze around the core.
  float reach = STAR_EXTENT * (0.8 + 0.15 * swell);
  float light =
      2.4 * rayFamily(r, u, w, n, pxPerRadius, 4.0, reach, 0.045, 0.5, seed)
    + 1.3 * rayFamily(r, u, w, n, pxPerRadius, 7.0, reach * 0.85, 0.03, 1.0, seed + 31.0)
    + 0.5 * rayFamily(r, u, w, n, pxPerRadius, 11.0, reach * 0.65, 0.02, 1.5, seed + 59.0);

  // Saturated ball of light, a bright Gaussian skirt that carries it into the
  // rays, then a faint wider glow forced to zero well inside the billboard.
  // Anything broad and bright reads as a hazy disc — the sRGB encode lifts
  // even a 1% tail visibly off the void — so the skirt is steep past ~1.3
  // radii and the rays do the reaching.
  // On the pulse the glow brightens and spreads, so the star visibly breathes;
  // the sRGB encode flattens a brightness-only swing into near nothing.
  float core = 1.0 - smoothstep(0.2, 0.8, r);
  float tail = max(0.0, 1.0 - r / (STAR_EXTENT * 0.7));
  float spread = 1.0 + 0.35 * swell;
  float rs = r / spread;
  float glow = 1.3 * exp(-rs * rs / 0.5) + 0.2 * exp(-2.0 * rs) * tail * tail;

  vec3 hot = mix(vec3(1.0), vTint, 0.2);
  vec3 colour = hot * core * (1.4 + 0.5 * swell)
    + vTint * (glow * (0.7 + 1.1 * swell) + light * (0.85 + 0.6 * swell));
  colour *= vFade * (1.0 - smoothstep(STAR_EXTENT * 0.9, STAR_EXTENT, r));

  gl_FragColor = vec4(colour, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * Self-lit stars: a camera-facing quad per instance, drawn additively with a
 * hot core, a tinted glow and a few hundred fine, shimmering rays. Each
 * instance carries `instanceStar` = `[phase, rate, seed]` and `instanceTint`;
 * the shared `pulseBeat` uniform is the clock in units of PULSE_PERIOD.
 * No lights are involved.
 */
function createStarMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    defines: { STAR_EXTENT: STAR_EXTENT.toFixed(1) },
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
}

/** A soft ring, white so a sprite's colour tints it. `RING_AT` is its radius as a fraction of the half-width. */
const RING_AT = 0.72
function ringTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.strokeStyle = 'rgba(255,255,255,1)'
  ctx.shadowColor = 'rgba(255,255,255,1)'
  ctx.shadowBlur = 14
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, (size / 2) * RING_AT, 0, Math.PI * 2)
  ctx.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * Three.js presentation of a graph model: every node in one `InstancedMesh`,
 * every edge in one `LineSegments2` plus one `Points` of drift motes (see
 * `edges.js`), every node label in one instanced mesh (see `labels.js`), and
 * the halos and the pending-connection line the interaction layer drives. Four
 * draw calls for the graph, whatever its size.
 *
 * Node size comes from `graph.sizeOf(id)` (a multiple of NODE_RADIUS). The view
 * draws its own `shown` size per node and eases it toward that target whenever
 * `graph.revision` moves, so an edit anywhere — a new link, a core flag, a
 * delete — resizes the affected nodes without any caller telling the view.
 */
export function createGraphView(graph, scene, renderer) {
  const root = new THREE.Group()
  root.name = 'graph'
  scene.add(root)

  const starUniforms = { pulseBeat: { value: 0 } }
  const nodeMaterial = createStarMaterial(starUniforms)
  const matrix = new THREE.Matrix4()

  // Instances occupy slots 0..count-1 with no gaps; a delete moves the last
  // instance into the hole. Nothing outside this module sees slot numbers.
  const slotIds = [] // instance slot -> node id
  const slotOf = new Map() // node id -> instance slot
  // Drawn size per node id, which trails graph.sizeOf while easing. The
  // instance matrix scale, the pick sphere and the halos all read this one.
  const shown = new Map()
  // Drawn tint per node id, linear RGB, easing toward `targetTints` — which is
  // the node's cluster colour. Both are keyed by id, never by slot, so a
  // swap-remove can't hand a node another node's colour.
  const shownTint = new Map()
  const targetTints = new Map()
  let sizedRevision = -1 // graph.revision the easing last aimed at
  let easing = false
  let lastSeconds = null
  let capacity = 0
  let nodeMesh = null
  let starAttribute = null
  let tintAttribute = null
  allocate(0)

  const edges = createEdges(graph, root, renderer, radiusOf)
  const labels = createLabels(graph, root, renderer, { radiusOf, baseRadius: NODE_RADIUS })

  const ringMap = ringTexture()

  function makeHalo(color) {
    // A ring just outside the core: marks the node without covering the star.
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ringMap,
        color,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    halo.renderOrder = 2
    halo.visible = false
    root.add(halo)
    return halo
  }

  const hoverHalo = makeHalo(HOVER_COLOR)
  const sourceHalo = makeHalo(SOURCE_COLOR)
  let hoverNodeId = null
  let sourceNodeId = null

  /**
   * Parks and sizes each halo on its node. Called on every matrix write as well
   * as on the setters, because the physics layout moves nodes, and easing
   * resizes them, under a halo that was placed frames ago.
   */
  function placeHalos() {
    for (const [halo, id] of [
      [hoverHalo, hoverNodeId],
      [sourceHalo, sourceNodeId],
    ]) {
      // Only nodes that have an instance: a halo on something not drawn yet,
      // or already deleted, would be a shell around empty space.
      const node = id && slotOf.has(id) ? graph.getNode(id) : null
      halo.visible = Boolean(node)
      if (!node) continue
      halo.position.set(node.x, node.y, node.z)
      halo.scale.setScalar((2 * radiusOf(id) * HALO_AT) / RING_AT)
    }
  }

  /** Drawn radius of a node, in world units. NODE_RADIUS for one with no instance. */
  function radiusOf(id) {
    return NODE_RADIUS * (shown.get(id) ?? 1)
  }

  /**
   * Rebuilds every node's target tint from its cluster. Cheap enough to redo
   * wholesale on any revision change — a hash and a lerp per node — which saves
   * having to work out which nodes a re-partition actually moved.
   */
  function refreshTints() {
    for (const id of slotIds) {
      const node = graph.nodes.get(id)
      if (!node) continue // deleted, not yet synced
      targetTint(id, node.cluster_color_id, tint)
      let wanted = targetTints.get(id)
      if (!wanted) targetTints.set(id, (wanted = [0, 0, 0]))
      tint.toArray(wanted)
      // A node seen for the first time starts at its colour rather than easing
      // up from black.
      if (!shownTint.has(id)) shownTint.set(id, [wanted[0], wanted[1], wanted[2]])
    }
  }

  /** The drawn tints into the instance attribute. */
  function writeTints() {
    const array = tintAttribute.array
    for (let slot = 0; slot < slotIds.length; slot++) {
      const drawn = shownTint.get(slotIds[slot])
      if (!drawn) continue
      array[slot * 3] = drawn[0]
      array[slot * 3 + 1] = drawn[1]
      array[slot * 3 + 2] = drawn[2]
    }
    tintAttribute.needsUpdate = true
  }

  const pendingPositions = new Float32Array(6)
  const pendingGeometry = new LineSegmentsGeometry()
  pendingGeometry.setPositions(pendingPositions)
  const pendingLine = new LineSegments2(
    pendingGeometry,
    new LineMaterial({
      color: PENDING_COLOR,
      linewidth: EDGE_WIDTH,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
  )
  // CSS px, as LineSegments2.onBeforeRender will keep it.
  const viewport = renderer.getViewport(new THREE.Vector4())
  pendingLine.material.resolution.set(viewport.z, viewport.w)
  pendingLine.frustumCulled = false
  pendingLine.visible = false
  root.add(pendingLine)

  /**
   * Replaces the node mesh with one of at least `needed` slots. An
   * `InstancedMesh` cannot be resized, and its star attributes have to live on
   * a geometry of matching length, so both are built fresh and the old pair is
   * disposed. The caller rewrites every slot afterwards.
   */
  function allocate(needed) {
    let next = Math.max(capacity, INITIAL_CAPACITY)
    while (next < needed) next *= 2

    // A flat quad the vertex shader turns to face the camera. Its bounds are
    // set by hand to cover any orientation of the full billboard: computed,
    // they would describe the flat 2x2 plane and cull stars still on screen.
    const geometry = new THREE.PlaneGeometry(2, 2)
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_EXTENT * Math.SQRT2)
    geometry.boundingBox = new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(),
      new THREE.Vector3().setScalar(STAR_EXTENT * 2 * Math.SQRT2)
    )
    starAttribute = new THREE.InstancedBufferAttribute(new Float32Array(next * 3), 3)
    tintAttribute = new THREE.InstancedBufferAttribute(new Float32Array(next * 3), 3)
    geometry.setAttribute('instanceStar', starAttribute)
    geometry.setAttribute('instanceTint', tintAttribute)

    const mesh = new THREE.InstancedMesh(geometry, nodeMaterial, next)
    mesh.name = 'nodes'
    // Physics rewrites every matrix on every frame of a balance run.
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // After the edges: they are normally blended, and one drawn over a star
    // would lay a dark line across its core. Additive stars on top just add light.
    mesh.renderOrder = 1
    // Only here: the stars are drawn in their own pass and are the only thing
    // that blooms (bloom.js). A mesh built without it would vanish from both.
    mesh.layers.set(STAR_LAYER)
    mesh.count = 0
    mesh.visible = false

    if (nodeMesh) {
      root.remove(nodeMesh)
      nodeMesh.dispose() // frees instanceMatrix on the GPU
      nodeMesh.geometry.dispose() // and the old star buffers with it
    }
    root.add(mesh)
    nodeMesh = mesh
    capacity = next
  }

  /** Adds/removes instances to match the model and copies node positions across. */
  function syncNodes() {
    let changed = false

    // Backwards, so the instance swapped into a hole has already been checked.
    for (let slot = slotIds.length - 1; slot >= 0; slot--) {
      const id = slotIds[slot]
      if (graph.nodes.has(id)) continue
      slotOf.delete(id)
      shown.delete(id)
      shownTint.delete(id)
      targetTints.delete(id)
      const last = slotIds.pop()
      if (slot < slotIds.length) {
        slotIds[slot] = last
        slotOf.set(last, slot)
      }
      changed = true
    }

    for (const id of graph.nodes.keys()) {
      if (slotOf.has(id)) continue
      slotOf.set(id, slotIds.length)
      slotIds.push(id)
      // A new node appears at its size rather than growing into it.
      shown.set(id, graph.sizeOf(id))
      changed = true
    }

    if (slotIds.length > capacity) allocate(slotIds.length)

    const count = slotIds.length
    if (changed) {
      // Rewritten wholesale rather than patched per move: it only happens on an
      // edit, and a fresh allocation needs every slot written anyway.
      for (let slot = 0; slot < count; slot++) writeStar(slotIds[slot], starAttribute.array, slot)
      starAttribute.needsUpdate = true
      // New nodes need a tint, and `allocate` may just have handed us a fresh,
      // empty tint buffer to fill.
      refreshTints()
      writeTints()
    }

    nodeMesh.count = count
    nodeMesh.visible = count > 0
    writeMatrices()
  }

  /**
   * Position and drawn size into every instance matrix. The star shader reads
   * its radius back out of the matrix scale, so this is the only size input
   * the GPU sees.
   */
  function writeMatrices() {
    for (let slot = 0; slot < slotIds.length; slot++) {
      const id = slotIds[slot]
      const node = graph.nodes.get(id)
      // Deleted, not yet synced. Easing runs this from the render loop, which
      // can land between a model edit and the caller's sync.
      if (!node) continue
      const radius = radiusOf(id)
      matrix.makeScale(radius, radius, radius).setPosition(node.x, node.y, node.z)
      nodeMesh.setMatrixAt(slot, matrix)
    }
    nodeMesh.instanceMatrix.needsUpdate = true
    // Frustum culling gates on this and only recomputes it when it is null —
    // the same trap as the edge geometry's bounds. Left stale, a star physics
    // has moved, or one that has grown, gets culled while still on screen.
    nodeMesh.boundingSphere = null
    nodeMesh.boundingBox = null

    placeHalos()
  }

  /**
   * One frame of every drawn size and tint closing on its target,
   * exponentially, so an edit reads as growth and a re-partition as a settle
   * rather than a pop. Returns whether anything is still short of its target.
   */
  function easeAppearance(dt) {
    const keepSize = Math.exp(-dt / SIZE_EASE)
    const keepTint = Math.exp(-dt / TINT_EASE)
    let sizeMoved = false
    let tintMoved = false
    let moving = false
    for (const id of slotIds) {
      const target = graph.sizeOf(id)
      const current = shown.get(id)
      if (current !== target) {
        let next = target + (current - target) * keepSize
        if (Math.abs(next - target) < 1e-3) next = target
        else moving = true
        shown.set(id, next)
        sizeMoved = true
      }

      const wanted = targetTints.get(id)
      const drawn = shownTint.get(id)
      if (!wanted || !drawn) continue
      for (let i = 0; i < 3; i++) {
        if (drawn[i] === wanted[i]) continue
        let next = wanted[i] + (drawn[i] - wanted[i]) * keepTint
        // Half a step of an 8-bit channel — closer than the screen can show.
        if (Math.abs(next - wanted[i]) < 1 / 512) next = wanted[i]
        else moving = true
        drawn[i] = next
        tintMoved = true
      }
    }
    if (sizeMoved) {
      writeMatrices()
      edges.writeRadii() // each edge fades out inside its ends' drawn radii
    }
    if (tintMoved) writeTints()
    return moving
  }

  /** Every drawn size and tint straight to its target, with no easing. */
  function snapAppearance() {
    for (const id of slotIds) shown.set(id, graph.sizeOf(id))
    refreshTints()
    for (const id of slotIds) {
      const wanted = targetTints.get(id)
      if (wanted) shownTint.set(id, [wanted[0], wanted[1], wanted[2]])
    }
    sizedRevision = graph.revision
    easing = false
    writeMatrices()
    writeTints()
    edges.writeRadii()
  }

  /** Rebuilds the edge geometry. Call when edges are added or removed. */
  function syncEdges() {
    edges.sync()
  }

  /** Rewrites edge endpoints from current node positions, in place. */
  function updateEdgePositions() {
    edges.updatePositions()
  }

  /**
   * Rebuilds everything from the model, sizes included, with no easing. For a
   * graph replaced wholesale: a file reuses ids like `n1`, and a node that only
   * shares an id with one in the previous map should not grow out of its size.
   * Edits should call `syncNodes`/`syncEdges` and let `update` ease them.
   */
  function sync() {
    syncNodes()
    snapAppearance()
    syncEdges()
    labels.reset()
  }

  /** `target` is `{ kind: 'node' | 'edge', id }` or null. */
  function setHover(target) {
    hoverNodeId = target?.kind === 'node' ? target.id : null
    placeHalos()
    // The whole target: labels name connections as well as stars, and either
    // kind under the crosshair is shown whatever its range.
    labels.setHovered(target)
    // Held by id, so it survives an edge sync that renumbers the edges.
    edges.setHovered(target?.kind === 'edge' ? target.id : null)
  }

  function setSource(nodeId) {
    sourceNodeId = nodeId ?? null
    placeHalos()
  }

  /** Draws the in-progress connection from a node to an arbitrary world point. */
  function setPending(nodeId, endPoint) {
    const node = nodeId ? graph.getNode(nodeId) : null
    if (!node) {
      pendingLine.visible = false
      return
    }
    pendingPositions.set([node.x, node.y, node.z, endPoint.x, endPoint.y, endPoint.z])
    pendingGeometry.attributes.instanceStart.data.needsUpdate = true
    pendingLine.visible = true
  }

  const pickSphere = new THREE.Sphere()
  const pickPoint = new THREE.Vector3()

  /**
   * Nearest drawn node whose sphere the ray enters, as `{ id, distance, radius }`.
   * Tested analytically rather than against the mesh: the mesh is billboards
   * several radii wide, and the pickable body is only the node's drawn radius.
   */
  function pickNode(raycaster) {
    const { ray, near, far } = raycaster
    let hit = null
    for (const id of slotIds) {
      const node = graph.getNode(id)
      if (!node) continue // deleted, not yet synced
      pickSphere.center.set(node.x, node.y, node.z)
      pickSphere.radius = radiusOf(id)
      if (!ray.intersectSphere(pickSphere, pickPoint)) continue
      const distance = ray.origin.distanceTo(pickPoint)
      if (distance < near || distance > far || (hit && distance >= hit.distance)) continue
      hit = { id, distance, radius: pickSphere.radius }
    }
    return hit
  }

  /**
   * Nearest node or edge under the ray, or null. Nodes win ties because every
   * edge passes through its endpoints.
   */
  function raycast(raycaster) {
    raycaster.far = PICK_RANGE
    raycaster.params.Line2 = { threshold: EDGE_PICK_PADDING }

    const nodeHit = pickNode(raycaster)
    const edgeHit = edges.raycast(raycaster)

    if (nodeHit && (!edgeHit || nodeHit.distance - edgeHit.distance < NODE_PICK_BIAS * nodeHit.radius)) {
      return { kind: 'node', id: nodeHit.id }
    }
    return edgeHit ? { kind: 'edge', id: edgeHit.id } : null
  }

  /**
   * Per-frame animation. `seconds` is any steadily increasing clock. Labels
   * are laid out for `camera`, the one about to draw the frame; without one
   * none are drawn.
   */
  function update(seconds, camera) {
    // Wrapped on the CPU in double precision; see PULSE_WRAP.
    starUniforms.pulseBeat.value = (seconds % PULSE_WRAP) / PULSE_PERIOD

    const dt = lastSeconds === null ? 0 : Math.min(Math.max(seconds - lastSeconds, 0), SIZE_EASE_MAX_STEP)
    lastSeconds = seconds
    // Any edit bumps the revision, whichever sync the caller did or didn't
    // make, so this is the one place sizes get retargeted.
    if (graph.revision !== sizedRevision) {
      sizedRevision = graph.revision
      // An edit moves sizes and a re-partition moves tints; both arrive as a
      // revision bump, so retarget both and let the ease work out what moved.
      refreshTints()
      easing = true
    }
    if (easing) easing = easeAppearance(dt)
    edges.update(dt)
    // After easing: a label sits below its star's drawn radius.
    if (camera) labels.update(camera, dt)
    else labels.hide()
  }

  function dispose() {
    scene.remove(root)
    nodeMesh.dispose()
    nodeMesh.geometry.dispose()
    nodeMaterial.dispose()
    ringMap.dispose()
    edges.dispose()
    labels.dispose()
    pendingGeometry.dispose()
    pendingLine.material.dispose()
    hoverHalo.material.dispose()
    sourceHalo.material.dispose()
  }

  return {
    sync,
    syncNodes,
    syncEdges,
    updateEdgePositions,
    setHover,
    setSource,
    setPending,
    raycast,
    radiusOf,
    update,
    /** A node's drawn tint, linear RGB, as the shader has it. Null if not drawn. */
    tintOf: (id) => shownTint.get(id)?.slice() ?? null,
    labelsShown: labels.shown,
    dispose,
  }
}

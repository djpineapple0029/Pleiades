import * as THREE from 'three'
import * as river from './riverFlow.js'
import { SHOCK_EASE, SHOCK_LIFE, SHOCK_PUSH, SHOCK_REACH } from './shockwave.js'

const { createRiverFlow, MAX_GRAINS, TRAIL_POINTS, TEX_WIDTH } = river

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

// Each grain draws a tail through where it was (`riverFlow.js`), fading out
// along it, so the dust reads as flowing strands and a still frame still
// shows which way it runs.
const STREAK_GAIN = 1.15
// How fast the tail fades toward its end: higher is a shorter-looking tail.
const TAIL_FALLOFF = 0.9

// Warm by a star, cool out in the river. Linear RGB.
const WARM = new THREE.Color().setRGB(1.0, 0.72, 0.45, THREE.SRGBColorSpace)
const COOL = new THREE.Color().setRGB(0.5, 0.6, 0.78, THREE.SRGBColorSpace)

const glslFloat = (value) => value.toFixed(6)

/** Every number the grain formula needs, as GLSL `defines`. */
export const FORMULA_DEFINES = {
  TEX_WIDTH: String(TEX_WIDTH),
  GRAIN_TEXELS: String(river.GRAIN_TEXELS),
  SEG_NOW: String(river.SEG_NOW),
  SEG_BEFORE: String(river.SEG_BEFORE),
  FRAME_TEXELS: String(river.FRAME_TEXELS),
  EDGE_TEXELS: String(river.EDGE_TEXELS),
  MAX_SHOCKS: String(river.MAX_SHOCKS),
  TANGENT_SCALE: glslFloat(river.TANGENT_SCALE),
  AIM: glslFloat(river.AIM),
  TRANSIT_EASE: glslFloat(river.TRANSIT_EASE),
  BEND_SHARE: glslFloat(river.BEND_SHARE),
  BEND_MAX: glslFloat(river.BEND_MAX),
  LANE_SHARE: glslFloat(river.LANE_SHARE),
  LANE_MAX: glslFloat(river.LANE_MAX),
  HEAT_FULL: glslFloat(river.HEAT_FULL),
  HEAT_NONE: glslFloat(river.HEAT_NONE),
  FADE_IN: glslFloat(river.FADE_IN),
  FADE_OUT: glslFloat(river.FADE_OUT),
  PUSH_DECAY: glslFloat(river.PUSH_DECAY),
  PUSH_MAX: glslFloat(river.PUSH_MAX),
  TRAIL_POINTS: glslFloat(TRAIL_POINTS),
  TRAIL_STEP: glslFloat(river.TRAIL_STEP),
  SHOCK_LIFE: glslFloat(SHOCK_LIFE),
  SHOCK_REACH: glslFloat(SHOCK_REACH),
  SHOCK_EASE: glslFloat(SHOCK_EASE),
  SHOCK_PUSH: glslFloat(SHOCK_PUSH),
}

/**
 * Where a grain is at a given time: the GLSL twin of `riverFlow.js`'s
 * `positionAt`, step for step, reading the same tables as textures. Change one,
 * change the other (`dustParity.spec.js` holds them together).
 */
export const GRAIN_GLSL = /* glsl */ `
uniform sampler2D grainTex;
uniform sampler2D starTex;
uniform sampler2D frameTex;
uniform sampler2D edgeTex;
uniform float time; // seconds since riverFlow's epoch
uniform vec4 shockAt[MAX_SHOCKS]; // x, y, z, star radius (0: none)
uniform float shockBirth[MAX_SHOCKS];

#define PI 3.141592653589793
#define TAU 6.283185307179586

vec4 texel(sampler2D t, int i) {
  return texelFetch(t, ivec2(i % TEX_WIDTH, i / TEX_WIDTH), 0);
}

float heatFrom(float d) {
  float x = clamp((HEAT_NONE - d) / (HEAT_NONE - HEAT_FULL), 0.0, 1.0);
  return x * x;
}

vec3 safeNormalize(vec3 v) {
  float l = length(v);
  return l > 0.0 ? v / l : v;
}

// Point on an orbit of star k at angle th; its unit tangent in 'tangent'.
vec3 orbitPoint(int k, float phi, float tilt, float r, float lift, float wob, float th, out vec3 tangent) {
  vec4 star = texel(starTex, k);
  vec4 f0 = texel(frameTex, k * FRAME_TEXELS);
  vec3 v0 = texel(frameTex, k * FRAME_TEXELS + 1).xyz;
  vec3 n = texel(frameTex, k * FRAME_TEXELS + 2).xyz;
  vec3 u0 = f0.xyz;
  float c = cos(phi);
  float s = sin(phi);
  vec3 bu = c * u0 + s * v0;
  vec3 bv = cos(tilt) * (-s * u0 + c * v0) + sin(tilt) * n;
  float radius = star.w;
  float rr = r * radius * (1.0 + 0.12 * sin(3.0 * th + wob));
  float ct = cos(th);
  float st = sin(th);
  tangent = f0.w * (-st * bu + ct * bv);
  return star.xyz + rr * (ct * bu + st * bv) + lift * radius * n;
}

vec3 segmentAt(int g, int seg, float t, out float heat) {
  vec4 s0 = texel(grainTex, seg); // kind, t0, t1, edge
  vec4 s1 = texel(grainTex, seg + 1);
  vec4 s2 = texel(grainTex, seg + 2);
  heat = 0.0;
  if (s0.x > 2.5) { // frozen
    heat = s1.w;
    return s1.xyz;
  }
  if (s0.x < 0.5) return vec3(0.0);
  int a = int(s1.x + 0.5);
  vec3 tanA;
  if (s0.x < 1.5) { // orbit
    heat = heatFrom(s1.w);
    return orbitPoint(a, s1.y, s1.z, s1.w, s2.x, s2.y, s2.z + s2.w * (t - s0.y), tanA);
  }
  vec4 s3 = texel(grainTex, seg + 3);
  vec4 s4 = texel(grainTex, seg + 4);
  vec4 s5 = texel(grainTex, seg + 5);
  int b = int(s3.x + 0.5);
  vec4 starA = texel(starTex, a);
  vec4 starB = texel(starTex, b);
  vec3 tanB;
  vec3 p0 = orbitPoint(a, s1.y, s1.z, s1.w, s2.x, s2.y, s2.z, tanA);
  vec3 p1 = orbitPoint(b, s3.y, s3.z, s3.w, s4.x, s4.y, s4.z, tanB);
  vec3 d = starB.xyz - starA.xyz;
  float dl = length(d);
  if (dl == 0.0) dl = 1.0;
  d /= dl;
  tanA = safeNormalize(tanA * (1.0 - AIM) + d * AIM);
  tanB = safeNormalize(tanB * (1.0 - AIM) + d * AIM);
  float chord = length(p1 - p0);
  if (chord == 0.0) chord = 1.0;
  float tau = clamp((t - s0.y) / max(s0.z - s0.y, 1e-4), 0.0, 1.0);
  float u = tau - TRANSIT_EASE * sin(TAU * tau) / TAU;
  float u2 = u * u;
  float u3 = u2 * u;
  float m = chord * TANGENT_SCALE;
  vec3 p = (2.0 * u3 - 3.0 * u2 + 1.0) * p0 + (u3 - 2.0 * u2 + u) * m * tanA
    + (-2.0 * u3 + 3.0 * u2) * p1 + (u3 - u2) * m * tanB;

  // The river's banks: a bend the whole link shares, and this grain's lane in
  // it, both zero at the ends. The link's own axes, from its own 'from'.
  int e = int(s0.w + 0.5) * EDGE_TEXELS;
  vec4 e0 = texel(edgeTex, e); // from, to, bend waves, bend phase
  vec4 e1 = texel(edgeTex, e + 1); // bend angle, drift
  bool forward = int(e0.x + 0.5) == a;
  vec3 ed = forward ? d : -d;
  vec3 f1 = abs(ed.z) > 0.9 ? vec3(0.0, ed.z, -ed.y) : vec3(ed.y, -ed.x, 0.0);
  float l1 = length(f1);
  if (l1 > 0.0) f1 /= l1;
  vec3 f2 = cross(ed, f1);
  float along = forward ? u : 1.0 - u;
  float envelope = sin(PI * u);
  float bend = min(BEND_SHARE * dl, BEND_MAX) * sin(PI * e0.z * along + e0.w + t * e1.y);
  float width = min(LANE_SHARE * dl, LANE_MAX) * (1.0 + 0.25 * sin(5.0 * along + float(g)));
  float la = bend * cos(e1.x) + width * s5.x;
  float lb = bend * sin(e1.x) + width * s5.y;
  p += envelope * (la * f1 + lb * f2);
  heat = heatFrom(min(length(p - starA.xyz) / starA.w, length(p - starB.xyz) / starB.w));
  return p;
}

vec3 shockPush(vec3 p, float t) {
  vec3 push = vec3(0.0);
  for (int i = 0; i < MAX_SHOCKS; i++) {
    vec4 shock = shockAt[i];
    float r0 = shock.w;
    if (r0 <= 0.0) continue;
    float age = t - shockBirth[i];
    if (age <= 0.0) continue;
    vec3 rel = p - shock.xyz;
    float d = length(rel);
    if (d < 1e-3) continue;
    float reach = r0 * SHOCK_REACH;
    if (d >= reach) continue;
    float reached = -SHOCK_EASE * log(1.0 - d / reach);
    if (reached >= SHOCK_LIFE) continue;
    float life = reached / SHOCK_LIFE;
    float strength = SHOCK_PUSH * (r0 / 5.0) * (1.0 - life) * (1.0 - life);
    float width = max(0.35 * d, 2.0);
    float rate = (reach - d) / SHOCK_EASE;
    float amount = min(PUSH_MAX, strength * width * 1.7724539 / max(rate, 1e-3));
    float radius = reach * (1.0 - exp(-age / SHOCK_EASE));
    float rise = 1.0 - smoothstep(-1.5, 1.5, (d - radius) / width);
    float decay = exp(-max(0.0, age - reached) / PUSH_DECAY);
    push += rel * (amount * rise * decay / d);
  }
  float l = length(push);
  return l > PUSH_MAX ? push * (PUSH_MAX / l) : push;
}

// Where grain g is at time t (x, y, z), and its heat.
vec3 grainAt(int g, float t, out float heat) {
  int h = g * GRAIN_TEXELS;
  vec4 head = texel(grainTex, h); // spawn, death, brightness
  vec4 now = texel(grainTex, h + SEG_NOW);
  vec4 before = texel(grainTex, h + SEG_BEFORE);
  bool hasBefore = before.x > 0.5;
  t = max(t, max(hasBefore ? before.y : now.y, head.x));
  int seg = t >= now.y || !hasBefore ? h + SEG_NOW : h + SEG_BEFORE;
  vec3 p = segmentAt(g, seg, t, heat);
  return p + shockPush(p, t);
}

// Grain g's brightness at time t: faded in after spawn, out after death.
float grainLight(int g, float t) {
  int h = g * GRAIN_TEXELS;
  if (texel(grainTex, h + SEG_NOW).x < 0.5) return 0.0;
  vec4 head = texel(grainTex, h);
  float f = clamp(min((t - head.x) / FADE_IN, 1.0 - (t - head.y) / FADE_OUT), 0.0, 1.0);
  return head.z * f * f * (3.0 - 2.0 * f);
}
`

// A grain never strays further than CULL_MARGIN from the star (or, in a
// river, the line between the stars) its segment is on — orbit, lane, bend,
// a shock's push and the tail back into its last segment included. So when
// that is past the fog or wholly behind the camera, the whole grain is out of
// sight, found with a texel or two instead of the formula.
const CULL_GLSL = /* glsl */ `
bool outOfSight(int g) {
  int h = g * GRAIN_TEXELS + SEG_NOW;
  vec4 s0 = texel(grainTex, h);
  if (s0.x < 0.5) return true;
  vec4 s1 = texel(grainTex, h + 1);
  vec3 a = s0.x > 2.5 ? s1.xyz : texel(starTex, int(s1.x + 0.5)).xyz;
  vec3 b = s0.x > 1.5 && s0.x < 2.5 ? texel(starTex, int(texel(grainTex, h + 3).x + 0.5)).xyz : a;
  vec3 ab = b - a;
  float l2 = dot(ab, ab);
  float k = l2 > 0.0 ? clamp(dot(cameraPosition - a, ab) / l2, 0.0, 1.0) : 0.0;
  if (distance(a + ab * k, cameraPosition) > FOG_FAR + CULL_MARGIN) return true;
  float za = (viewMatrix * vec4(a, 1.0)).z;
  float zb = (viewMatrix * vec4(b, 1.0)).z;
  return za > CULL_MARGIN && zb > CULL_MARGIN;
}
`
const CULL_MARGIN = 200

const VERTEX = /* glsl */ `
${GRAIN_GLSL}
${CULL_GLSL}
uniform vec2 resolution; // CSS px
uniform float pixelRatio;
uniform vec3 warm;
uniform vec3 cool;
uniform float dim; // 1 normally; lower while a search dims the map
attribute float grain;
varying vec3 vColor;
void main() {
  int g = int(grain + 0.5);
  if (outOfSight(g)) {
    vColor = vec3(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float heat;
  vec3 at = grainAt(g, time, heat);
  vec4 view = modelViewMatrix * vec4(at, 1.0);
  float size = GRAIN_SIZE * 0.5 * resolution.y * projectionMatrix[1][1] / max(-view.z, 1e-3);
  float drawn = clamp(size, GRAIN_MIN_PX, GRAIN_MAX_PX);
  float coverage = min(1.0, size / GRAIN_MIN_PX);
  float fog = 1.0 - smoothstep(FOG_NEAR, FOG_FAR, length(view.xyz));
  // Brighter by a star, as if lit by it.
  float lit = grainLight(g, time) * GAIN * (0.55 + 0.45 * heat) * fog * coverage * coverage * dim;
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

// Streaks: TRAIL_POINTS segments per grain, each vertex the grain as it was
// 'tail' TRAIL_STEPs ago; head bright, tail at nothing.
const STREAK_VERTEX = /* glsl */ `
${GRAIN_GLSL}
${CULL_GLSL}
uniform vec3 warm;
uniform vec3 cool;
uniform float dim;
attribute float tail; // 0 at the grain, TRAIL_POINTS at the tail's end
attribute float grain;
varying vec3 vColor;
void main() {
  int g = int(grain + 0.5);
  float light = grainLight(g, time);
  // An unlit or unseen grain sends its whole tail to one point outside the
  // clip volume: every segment goes, not a stray line to wherever one end was
  // sent.
  if (light <= 0.002 || outOfSight(g)) {
    vColor = vec3(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float heat;
  vec3 at = grainAt(g, time - tail * TRAIL_STEP, heat);
  vec4 view = modelViewMatrix * vec4(at, 1.0);
  float fog = 1.0 - smoothstep(FOG_NEAR, FOG_FAR, length(view.xyz));
  float fade = pow(1.0 - tail / TRAIL_POINTS, TAIL_FALLOFF);
  vColor = mix(cool, warm, heat) * light * fade * STREAK_GAIN * (0.55 + 0.45 * heat) * fog * dim;
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

/** A float RGBA texture over one of `riverFlow.js`'s tables, read texel by texel. */
function floatTexture(data) {
  const texture = new THREE.DataTexture(
    data,
    TEX_WIDTH,
    data.length / 4 / TEX_WIDTH,
    THREE.RGBAFormat,
    THREE.FloatType,
  )
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

// Grains waiting to go up past which the whole table goes instead.
const MAX_PENDING = 256

const TABLES = [
  ['starTex', 'stars'],
  ['frameTex', 'frames'],
  ['edgeTex', 'edges'],
]

/**
 * Dust that swirls around stars and flows along links (see `riverFlow.js`),
 * drawn with the edges on layer 0: it doesn't bloom, so it stays a texture
 * under the stars rather than competing with them.
 *
 * The GPU works out where every grain and every point of its tail is, each
 * frame, from `riverFlow.js`'s tables. What goes up per frame is the star
 * table and the few grains whose route moved on; the grain table goes up
 * whole only when the map's structure changes.
 */
export function createDustRivers(graph, parent, { radiusOf }) {
  const flow = createRiverFlow(graph, { radiusOf })

  const shared = {
    grainTex: { value: floatTexture(flow.records) },
    starTex: { value: floatTexture(flow.stars) },
    frameTex: { value: floatTexture(flow.frames) },
    edgeTex: { value: floatTexture(flow.edges) },
    time: { value: 0 },
    shockAt: { value: Array.from({ length: river.MAX_SHOCKS }, () => new THREE.Vector4()) },
    shockBirth: { value: new Array(river.MAX_SHOCKS).fill(0) },
    warm: { value: WARM },
    cool: { value: COOL },
    dim: { value: 1 },
  }
  let tablesVersion = flow.tablesVersion
  // The grain table goes up whole, through three, when the map changed and
  // until three has sent it since it was made or the context came back.
  // Otherwise only the grains whose route moved on go up, just before the
  // rivers draw (`sendPending`), piling up over frames that weren't drawn.
  let wholeGrains = true
  shared.grainTex.value.onUpdate = () => {
    wholeGrains = false
  }
  const pending = new Int32Array(MAX_PENDING)
  const isPending = new Uint8Array(MAX_GRAINS)
  let pendingCount = 0

  function clearPending() {
    for (let i = 0; i < pendingCount; i++) isPending[pending[i]] = 0
    pendingCount = 0
  }

  /**
   * Sends the pending grains straight to the grain texture, a texSubImage2D
   * each. Not through three's texture update ranges: three reads the unpack
   * state back with gl.getParameter around every ranged upload, and each of
   * those makes the page wait for the GPU to finish the frame before — a
   * stall, every frame, that cost more than the rivers themselves.
   */
  function sendPending(renderer) {
    if (wholeGrains || pendingCount === 0) return
    const grainTex = shared.grainTex.value
    const handle = renderer.properties.get(grainTex).__webglTexture
    if (!handle) {
      // Not on the GPU at all (yet, or any more): it goes up whole.
      wholeGrains = true
      grainTex.needsUpdate = true
      clearPending()
      return
    }
    const gl = renderer.getContext()
    renderer.state.bindTexture(gl.TEXTURE_2D, handle)
    // Whatever three's last upload left set; three sets its own before each.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    for (let i = 0; i < pendingCount; i++) {
      const texel = pending[i] * river.GRAIN_TEXELS
      const x = texel % TEX_WIDTH
      const y = (texel - x) / TEX_WIDTH
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x,
        y,
        river.GRAIN_TEXELS,
        1,
        gl.RGBA,
        gl.FLOAT,
        flow.records,
        texel * 4,
      )
    }
    clearPending()
  }

  // The grain index per point (and per tail instance); positions are unused.
  const grainIndex = Float32Array.from({ length: MAX_GRAINS }, (_, i) => i)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_GRAINS * 3), 3))
  geometry.setAttribute('grain', new THREE.BufferAttribute(grainIndex, 1))
  geometry.setDrawRange(0, 0)

  const size = new THREE.Vector2()
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      resolution: { value: new THREE.Vector2(1, 1) },
      pixelRatio: { value: 1 },
    },
    defines: {
      ...FORMULA_DEFINES,
      CULL_MARGIN: glslFloat(CULL_MARGIN),
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
    sendPending(r)
  }
  parent.add(points)

  // Every grain's tail, built once: TRAIL_POINTS + 1 points per grain, head to
  // tail, joined by TRAIL_POINTS segments through an index, so the vertex
  // cache works each point out once rather than once per segment it ends.
  // (One plain draw, not one instance per grain: software GL, the e2e
  // harness's SwiftShader among them, pays heavily per instance.)
  const perTail = TRAIL_POINTS + 1
  const tailGrain = new Float32Array(MAX_GRAINS * perTail)
  const tail = new Float32Array(MAX_GRAINS * perTail)
  const tailIndex = new Uint32Array(MAX_GRAINS * TRAIL_POINTS * 2)
  for (let g = 0; g < MAX_GRAINS; g++) {
    for (let i = 0; i < perTail; i++) {
      tailGrain[g * perTail + i] = g
      tail[g * perTail + i] = i
    }
    for (let i = 0; i < TRAIL_POINTS * 2; i++)
      tailIndex[g * TRAIL_POINTS * 2 + i] = g * perTail + ((i + 1) >> 1)
  }
  const streakGeometry = new THREE.BufferGeometry()
  streakGeometry.setIndex(new THREE.BufferAttribute(tailIndex, 1))
  streakGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(MAX_GRAINS * perTail * 3), 3),
  )
  streakGeometry.setAttribute('tail', new THREE.BufferAttribute(tail, 1))
  streakGeometry.setAttribute('grain', new THREE.BufferAttribute(tailGrain, 1))
  streakGeometry.setDrawRange(0, 0)
  const streakMaterial = new THREE.ShaderMaterial({
    uniforms: shared,
    defines: {
      ...FORMULA_DEFINES,
      CULL_MARGIN: glslFloat(CULL_MARGIN),
      FOG_NEAR: glslFloat(FOG_NEAR),
      FOG_FAR: glslFloat(FOG_FAR),
      STREAK_GAIN: glslFloat(STREAK_GAIN * GAIN),
      TAIL_FALLOFF: glslFloat(TAIL_FALLOFF),
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

  /** Puts the step's changes on the textures: the stars, and grains that moved on. */
  function upload() {
    if (flow.tablesVersion !== tablesVersion) {
      tablesVersion = flow.tablesVersion
      for (const [key, name] of TABLES) {
        const texture = shared[key].value
        if (texture.image.data === flow[name]) {
          texture.needsUpdate = true
        } else {
          // Outgrown: a bigger table, so a bigger texture.
          texture.dispose()
          shared[key].value = floatTexture(flow[name])
        }
      }
    } else {
      shared.starTex.value.needsUpdate = true
    }
    if (flow.allDirty || wholeGrains) {
      wholeGrains = true
      clearPending()
      shared.grainTex.value.needsUpdate = true
    } else {
      for (let i = 0; i < flow.dirtyCount; i++) {
        const g = flow.dirty[i]
        if (isPending[g]) continue
        if (pendingCount === MAX_PENDING) {
          // Piled up over frames nobody drew: one whole upload is cheaper.
          wholeGrains = true
          clearPending()
          shared.grainTex.value.needsUpdate = true
          break
        }
        isPending[g] = 1
        pending[pendingCount++] = g
      }
    }
    shared.time.value = flow.time
    const d = flow.shockData
    for (let i = 0; i < river.MAX_SHOCKS; i++) {
      const o = i * 8
      shared.shockAt.value[i].set(d[o], d[o + 1], d[o + 2], d[o + 3])
      shared.shockBirth.value[i] = d[o + 4]
    }
  }

  /**
   * Hides the rivers without advancing them — for motion switched off. The
   * next `update` picks up where they left off.
   */
  function hide() {
    points.visible = streaks.visible = false
  }

  /**
   * Advances the rivers by `dt` seconds and hands the GPU what changed.
   * `shocks` is `supernova.shocks()`.
   */
  function update(dt, shocks) {
    flow.step(dt, shocks)
    const count = flow.count
    geometry.setDrawRange(0, count)
    streakGeometry.setDrawRange(0, count * TRAIL_POINTS * 2)
    points.visible = streaks.visible = count > 0
    upload()
  }

  /** After a WebGL context restore: every table goes up whole on the next update. */
  function restore() {
    wholeGrains = true
    clearPending()
    shared.grainTex.value.needsUpdate = true
    for (const [key] of TABLES) shared[key].value.needsUpdate = true
  }

  function dispose() {
    parent.remove(points, streaks)
    geometry.dispose()
    material.dispose()
    streakGeometry.dispose()
    streakMaterial.dispose()
    for (const key of ['grainTex', ...TABLES.map(([k]) => k)]) shared[key].value.dispose()
  }

  /** Scales every grain and tail's light: 1 is normal. Search dims the map. */
  function setDim(level) {
    shared.dim.value = level
  }

  return {
    update,
    hide,
    restore,
    setDim,
    dispose,
    object: points,
    streaks,
    flow,
    uniforms: shared,
    /** Test seam: grains waiting to go up before the next draw. */
    get pendingGrains() {
      return [...pending.subarray(0, pendingCount)]
    },
    /** Test seam: whether the grain table goes up whole next. */
    get sendsWhole() {
      return wholeGrains
    },
  }
}

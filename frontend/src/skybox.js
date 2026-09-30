import * as THREE from 'three'
import { VOID_COLOR } from './scene.js'
import { seededRandom } from './random.js'

// Faces of the baked nebula cube map, in texels. The sky is magnified on
// screen (a Retina view needs ~1800 per face for 1:1), but the nebula is soft
// enough that 1024 reads as smooth; the crisp stars are points, not baked.
const BAKE_SIZE = 1024
// The galactic band: the great circle square to this direction. Tilted so it
// crosses the starting view on a diagonal, and it gives every direction a
// different look, so the sky doubles as a compass.
const BAND_NORMAL = new THREE.Vector3(0.35, 0.85, 0.4).normalize()
// Linear brightness of the nebula at full density. Its brightest clouds stay
// well under the edges' colour, so the map always reads over the sky.
const NEBULA_GAIN = 0.026
// Deep Sea's shafts and caustics, over its own water colour.
const SEA_GAIN = 0.35
// Shallow Space: a planet under the map, filling most of the lower sky. Its
// centre's direction, its angular radius (as a cosine, so a direction d is on
// the planet when dot(d, PLANET) > PLANET_COS) and the sun, off to one side
// above its rim, so a day/night line crosses it.
const PLANET = new THREE.Vector3(0.12, -1, 0.3).normalize()
const PLANET_COS = 0.4
const SUN = new THREE.Vector3(1, 0.12, 0.25).normalize()
const ORBIT_GAIN = 1.0
const DIGITAL_GAIN = 0.35
const STAR_COUNT = 6500
// Share of the sky stars that crowd toward the band, and how tightly (radians).
const BAND_SHARE = 0.45
const BAND_SPREAD = 0.2
// Fixed so the sky is the same every session: its landmarks stay where you
// left them.
const SEED = 0x61746c73

// 3D simplex noise: Ian McEwan and Stefan Gustavson, "webgl-noise"
// (https://github.com/ashima/webgl-noise), MIT licence.
const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec3 ns = 0.142857142857 * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

const BAKE_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// Everything here is a function of direction alone, evaluated once per texel
// at startup — far too much noise to run per pixel per frame.
const BAKE_FRAGMENT = /* glsl */ `
uniform vec3 bandNormal;
uniform vec3 ground;
varying vec3 vDirection;
${SIMPLEX}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * snoise(p);
    p = p * 2.03 + vec3(19.1, 7.3, 3.7);
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec3 d = normalize(vDirection);
  float lat = dot(d, bandNormal); // sine of the angle off the band
  // Warped once so the clouds come out as drifts and wisps rather than blobs.
  vec3 warp = vec3(fbm(d * 1.7 + 3.1), fbm(d * 1.7 + 11.7), fbm(d * 1.7 + 23.9));
  vec3 p = d * 2.4 + warp * 0.9;
  float cloud = clamp(fbm(p) * 0.65 + 0.5, 0.0, 1.0);
  float grain = fbm(p * 3.1 + 5.0) * 0.5 + 0.5;

  // Off the band the sky is mostly empty, with faint wisps; the clouds pile up
  // toward it, so the band reads as a band from anywhere.
  float band = exp(-lat * lat / 0.05);
  float spread = exp(-lat * lat / 0.3);
  float density = cloud * cloud * cloud * (0.05 + 0.6 * spread) * (0.4 + 0.6 * grain);
  density += band * smoothstep(0.25, 0.85, cloud) * (0.5 + 0.5 * grain) * 1.4;
  // Dark dust lanes down the middle of the band.
  float lane = smoothstep(0.5, 0.78, fbm(d * 4.2 + warp * 1.3) * 0.5 + 0.5);
  density *= 1.0 - 0.8 * lane * band;
  // Unresolved starlight: a faint, even glow along the band's spine.
  float haze = exp(-lat * lat / 0.02) * 0.22 * (1.0 - 0.6 * lane);

  // Blue, drifting to teal in places and to rose in a few.
  float hue = clamp(fbm(d * 1.1 + 40.0) + 0.5, 0.0, 1.0);
  vec3 tint = mix(vec3(0.18, 0.36, 0.80), vec3(0.12, 0.50, 0.62), smoothstep(0.55, 0.9, hue));
  tint = mix(tint, vec3(0.60, 0.22, 0.62), smoothstep(0.35, 0.08, hue) * 0.85);

  vec3 light = tint * density + vec3(0.42, 0.44, 0.52) * haze;
  gl_FragColor = vec4(ground + light * NEBULA_GAIN, 1.0);
}
`

// Deep Sea (`looks.js`): a water column instead of a sky. Lit from the surface
// straight up, dark toward the abyss below, with shafts of light slanting
// down from above and a caustic shimmer overhead. Like the nebula, it is a
// function of direction alone, baked once.
const SEA_FRAGMENT = /* glsl */ `
uniform vec3 ground;
varying vec3 vDirection;
${SIMPLEX}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * snoise(p);
    p = p * 2.03 + vec3(19.1, 7.3, 3.7);
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec3 d = normalize(vDirection);
  float up = d.y;
  // The column: abyss, open water at the horizon, lighter toward the surface.
  vec3 abyss = vec3(0.0004, 0.0016, 0.0035);
  vec3 open = vec3(0.0025, 0.022, 0.045);
  vec3 surface = vec3(0.02, 0.16, 0.2);
  vec3 water = mix(abyss, open, smoothstep(-0.75, 0.05, up));
  water = mix(water, surface, pow(smoothstep(0.0, 1.0, up), 1.6));

  // Murky clouds of silt so the water isn't a flat gradient: looking around
  // still shows which way you face.
  float silt = fbm(d * 2.2 + 7.0) * 0.5 + 0.5;
  water *= 0.75 + 0.5 * silt;

  // Light shafts: bright wedges by azimuth, converging on the zenith, fading
  // out as they go down into the dark.
  vec2 ring = normalize(d.xz + 1e-5);
  float shaft = snoise(vec3(ring * 5.0, 0.7)) * 0.5 + 0.5;
  shaft = pow(shaft, 4.0) + 0.5 * pow(snoise(vec3(ring * 11.0, 3.1)) * 0.5 + 0.5, 6.0);
  float reach = smoothstep(-0.15, 0.55, up) * (1.0 - smoothstep(0.85, 1.0, up));
  vec3 shafts = vec3(0.05, 0.22, 0.24) * shaft * reach * (0.6 + 0.4 * silt);

  // Caustics: the surface's ripples seen from below, a net of bright lines.
  vec2 plane = d.xz / max(up, 0.05);
  float n = 1.0 - abs(snoise(vec3(plane * 3.0, 1.7)));
  float n2 = 1.0 - abs(snoise(vec3(plane * 6.1, 9.2)));
  float caustic = pow(n, 8.0) + 0.6 * pow(n2, 10.0);
  vec3 caustics = vec3(0.12, 0.34, 0.33) * caustic * smoothstep(0.55, 0.95, up);

  gl_FragColor = vec4(ground + water + (shafts + caustics) * SEA_GAIN, 1.0);
}
`

// A unit box turned with the view but never moved by it, pinned to the far
// plane: the sky is at infinity, so flying never gets any closer to it.
const SKY_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = (projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0)).xyww;
}
`

const DITHER = /* glsl */ `
// The sky is dark gradients, which band in 8 bits: quantise with a per-pixel
// offset so the error averages out instead.
vec3 dither8(vec3 c) {
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  return floor(min(c, 1.0) * 255.0 + n) / 255.0;
}
`

const SKY_FRAGMENT = /* glsl */ `
uniform samplerCube map;
varying vec3 vDirection;
${DITHER}
void main() {
  // A render-target cube map is sampled with the plain world direction; only
  // image cube maps need three.js's x flip.
  gl_FragColor = vec4(textureCube(map, vDirection).rgb, 1.0);
  #include <colorspace_fragment>
  gl_FragColor.rgb = dither8(gl_FragColor.rgb);
}
`

const STARS_VERTEX = /* glsl */ `
attribute vec3 light; // linear RGB at the centre
attribute float size; // CSS pixels
uniform float pixelRatio;
uniform vec4 occluder; // a planet's direction and angular-radius cosine; w > 1 for none
uniform float faintCut; // stars dimmer than this are dropped
varying vec3 vLight;
void main() {
  float peak = max(light.r, max(light.g, light.b));
  vLight = dot(position, occluder.xyz) > occluder.w ? vec3(0.0) : light * smoothstep(faintCut, faintCut * 1.5, peak);
  // Under two device pixels a point lands on one pixel or smears over two as
  // the view turns, and visibly twinkles.
  gl_PointSize = max(size * pixelRatio, 2.0);
  gl_Position = (projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0)).xyww;
}
`

const STARS_FRAGMENT = /* glsl */ `
varying vec3 vLight;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  gl_FragColor = vec4(vLight * exp(-5.0 * dot(p, p)), 1.0);
  #include <colorspace_fragment>
}
`

// Shallow Space (`looks.js`): close to a planet instead of out in deep space.
// Sparse stars on black above, the planet below: cloud-streaked ocean on its
// day side, city lights on its night side, a thin blue atmosphere round its
// rim, brightest toward the sun. Baked once, like the others.
const ORBIT_FRAGMENT = /* glsl */ `
uniform vec3 ground;
uniform vec3 planet; // unit direction to its centre
uniform float planetCos; // cosine of its angular radius
uniform vec3 sun;
varying vec3 vDirection;
${SIMPLEX}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * snoise(p);
    p = p * 2.03 + vec3(19.1, 7.3, 3.7);
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec3 d = normalize(vDirection);
  float t = dot(d, planet);
  float sunward = max(dot(d, sun), 0.0);

  // Sky: black, with the atmosphere's glow a few degrees thick above the rim,
  // brighter toward the sun, and the sun's own glare.
  float above = max(planetCos - t, 0.0);
  vec3 sky = vec3(0.04, 0.13, 0.45) * exp(-above / 0.03) * (0.12 + 1.2 * pow(sunward, 4.0));
  sky += vec3(1.0, 0.92, 0.8) * (0.9 * pow(sunward, 900.0) + 0.05 * pow(sunward, 60.0));

  // The planet as a sphere of radius sqrt(1 - planetCos^2) one unit away.
  // Clamped at the rim so the blend below never reads past it.
  float r2 = 1.0 - planetCos * planetCos;
  float disc = max(t * t - (1.0 - r2), 0.0);
  vec3 hit = d * max(t - sqrt(disc), 0.0);
  vec3 n = normalize(hit - planet + 1e-6);
  float day = dot(n, sun);
  float lit = smoothstep(-0.05, 0.3, day);
  // Clouds in bands, as on a real world; ocean under them.
  vec3 q = n * 3.0;
  float cloud = smoothstep(0.1, 0.62, fbm(q + fbm(q * 0.7) * 0.8) * 0.5 + 0.5 + 0.12 * sin(n.y * 9.0));
  vec3 surface = mix(vec3(0.004, 0.02, 0.055), vec3(0.34, 0.36, 0.4), cloud) * (0.3 + 0.7 * max(day, 0.0));
  // City lights on the night side, where the clouds let them through.
  float city = smoothstep(0.7, 0.88, fbm(n * 24.0) * 0.5 + 0.5) * (1.0 - cloud);
  vec3 night = vec3(0.0006, 0.0008, 0.0016) + vec3(0.035, 0.018, 0.005) * city * (1.0 - lit);
  vec3 ground_ = mix(night, surface, lit);
  // The atmosphere seen edge-on at the rim: thin, blue, on the day side.
  float edge = pow(1.0 - max(dot(n, -d), 0.0), 6.0);
  ground_ += vec3(0.05, 0.16, 0.5) * edge * (0.08 + smoothstep(-0.2, 0.4, day));

  // Blended across about two texels of the bake, so the rim doesn't
  // stair-step when the sky is magnified on screen.
  float onPlanet = smoothstep(planetCos - 0.0015, planetCos + 0.0025, t);
  vec3 light = mix(sky, ground_, onPlanet);
  gl_FragColor = vec4(ground + light * ORBIT_GAIN, 1.0);
}
`

// Cyberspace (`looks.js`): a virtual world's sky. Near-black overhead,
// warming to violet and a hot magenta line at the horizon, where a skyline
// of dark data towers stands against the glow with a few windows lit and a
// cyan edge along each roof. The grid floor (`grid.js`) is drawn in the
// scene, not here, so it moves under you; below the horizon this is only dark.
const DIGITAL_FRAGMENT = /* glsl */ `
uniform vec3 ground;
varying vec3 vDirection;

float hash11(float x) {
  return fract(sin(x * 127.1) * 43758.5453);
}

void main() {
  vec3 d = normalize(vDirection);
  float y = d.y;
  float up = max(y, 0.0);
  vec3 light = vec3(0.0006, 0.0, 0.0022);
  light += vec3(0.09, 0.012, 0.16) * exp(-up / 0.2);
  light += vec3(0.5, 0.06, 0.38) * exp(-up / 0.012);
  // Below the horizon the glow carries on a few degrees down, fading to
  // black: that's where the far edge of the grid floor meets the sky, and the
  // floor adds its light over this, so there's no dark band between them.
  if (y < 0.0) light = (vec3(0.09, 0.012, 0.16) + vec3(0.5, 0.06, 0.38)) * exp(y / 0.03);

  // The skyline: one tower per sliver of azimuth, most low, a few tall.
  float az = atan(d.z, d.x) / 6.2831853 + 0.5;
  float cell = floor(az * 300.0);
  float across = fract(az * 300.0);
  float tall = 0.012 + 0.05 * pow(hash11(cell), 3.0);
  float gap = step(0.12, across) * step(across, 0.9); // a dark slit between towers
  if (y > 0.0 && y < tall && gap > 0.0) {
    vec3 tower = vec3(0.004, 0.001, 0.01);
    // Windows: a grid on the tower's face, a few of them lit.
    vec2 win = vec2(floor(across * 5.0), floor(y * 900.0));
    float lit = step(0.9, hash11(cell * 13.1 + win.x * 3.7 + win.y * 1.3))
      * step(0.35, fract(across * 5.0)) * step(0.4, fract(y * 900.0));
    tower += vec3(0.05, 0.5, 0.6) * lit * 0.35;
    // The roofline, lit cyan.
    tower += vec3(0.05, 0.6, 0.75) * exp(-(tall - y) / 0.0012) * 0.5;
    light = tower;
  }
  gl_FragColor = vec4(ground + light * DIGITAL_GAIN, 1.0);
}
`

/**
 * The backdrop for `variant` ('space': the nebula, 'sea': the water column,
 * 'orbit': the planet, 'digital': Cyberspace's horizon),
 * rendered once into a cube map by a camera at the centre of a box.
 */
function bakeNebula(renderer, variant = 'space') {
  const target = new THREE.WebGLCubeRenderTarget(BAKE_SIZE, {
    // Stored sRGB-encoded: in linear 8-bit the dark end, where all of the
    // nebula lives, would get only a handful of levels.
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  })
  const material = new THREE.ShaderMaterial({
    uniforms: {
      bandNormal: { value: BAND_NORMAL },
      ground: { value: new THREE.Color(variant === 'space' ? VOID_COLOR : 0x000000) },
      planet: { value: PLANET },
      planetCos: { value: PLANET_COS },
      sun: { value: SUN },
    },
    defines: {
      NEBULA_GAIN: NEBULA_GAIN.toFixed(3),
      SEA_GAIN: SEA_GAIN.toFixed(3),
      ORBIT_GAIN: ORBIT_GAIN.toFixed(3),
      DIGITAL_GAIN: DIGITAL_GAIN.toFixed(3),
    },
    vertexShader: BAKE_VERTEX,
    fragmentShader:
      { sea: SEA_FRAGMENT, orbit: ORBIT_FRAGMENT, digital: DIGITAL_FRAGMENT }[variant] ?? BAKE_FRAGMENT,
    side: THREE.BackSide,
  })
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material)
  const bakeScene = new THREE.Scene()
  bakeScene.add(box)
  new THREE.CubeCamera(0.1, 10, target).update(renderer, bakeScene)
  box.geometry.dispose()
  material.dispose()
  return target
}

/** Distant stars, denser toward the band, as unit directions with a colour and size each. */
function skyStars() {
  const rand = seededRandom(SEED)
  const positions = new Float32Array(STAR_COUNT * 3)
  const lights = new Float32Array(STAR_COUNT * 3)
  const sizes = new Float32Array(STAR_COUNT)
  // Two axes spanning the band's plane.
  const e1 = new THREE.Vector3(1, 0, 0).cross(BAND_NORMAL).normalize()
  const e2 = new THREE.Vector3().crossVectors(BAND_NORMAL, e1)
  const d = new THREE.Vector3()
  const light = new THREE.Color()
  const blue = new THREE.Color().setRGB(0.72, 0.82, 1.0, THREE.SRGBColorSpace)
  const warm = new THREE.Color().setRGB(1.0, 0.86, 0.7, THREE.SRGBColorSpace)

  for (let i = 0; i < STAR_COUNT; i++) {
    if (rand() < BAND_SHARE) {
      // Gaussian latitude by Box-Muller, uniform longitude along the band.
      const lat = BAND_SPREAD * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
      const lon = 2 * Math.PI * rand()
      d.copy(e1).multiplyScalar(Math.cos(lon)).addScaledVector(e2, Math.sin(lon))
      d.multiplyScalar(Math.cos(lat)).addScaledVector(BAND_NORMAL, Math.sin(lat))
    } else {
      // Uniform on the sphere.
      const z = 2 * rand() - 1
      const a = 2 * Math.PI * rand()
      const r = Math.sqrt(1 - z * z)
      d.set(r * Math.cos(a), r * Math.sin(a), z)
    }
    d.toArray(positions, i * 3)

    // Almost all faint, a handful bright; the bright ones a little bigger.
    const bright = rand() ** 7
    light.lerpColors(blue, warm, rand() ** 1.5).multiplyScalar(0.05 + 0.6 * bright)
    light.toArray(lights, i * 3)
    sizes[i] = 1.2 + 1.6 * bright
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('light', new THREE.BufferAttribute(lights, 3))
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
  return geometry
}

/**
 * The backdrop at infinity: a nebula baked once into a cube map, and a few
 * thousand crisp distant stars over it. Both follow the view's rotation only,
 * so they give a sense of direction but never of motion (dust.js does that).
 * Neither is on the star layer, so neither blooms.
 */
export function createSkybox(renderer) {
  const group = new THREE.Group()
  group.name = 'skybox'

  // Baked on first use and kept: switching looks back and forth bakes each
  // backdrop once. Deep Sea's is never baked for a session that stays in space.
  const cubes = new Map([['space', bakeNebula(renderer, 'space')]])
  let variant = 'space'
  let cube = cubes.get(variant)
  const nebulaMaterial = new THREE.ShaderMaterial({
    uniforms: { map: { value: cube.texture } },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  })
  const nebula = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), nebulaMaterial)
  nebula.name = 'nebula'
  // Opaque, so it lands in the render list ahead of everything transparent.
  nebula.renderOrder = -2
  nebula.frustumCulled = false
  group.add(nebula)

  const starMaterial = new THREE.ShaderMaterial({
    uniforms: {
      pixelRatio: { value: 1 },
      occluder: { value: new THREE.Vector4(0, 0, 0, 2) },
      faintCut: { value: 0 },
    },
    vertexShader: STARS_VERTEX,
    fragmentShader: STARS_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  })
  const stars = new THREE.Points(skyStars(), starMaterial)
  stars.name = 'sky-stars'
  stars.renderOrder = -1
  stars.frustumCulled = false
  stars.onBeforeRender = (renderer) => {
    starMaterial.uniforms.pixelRatio.value = renderer.getPixelRatio()
  }
  group.add(stars)

  /** After a context loss: the cube map lived only on the GPU, so it came
   *  back black. Bakes it again and points the sky at the new one. */
  function rebake() {
    for (const baked of cubes.values()) baked.dispose()
    cubes.clear()
    cube = bakeNebula(renderer, variant)
    cubes.set(variant, cube)
    nebulaMaterial.uniforms.map.value = cube.texture
  }

  /**
   * Which backdrop to show: 'space' (nebula and sky stars), 'sea' (the water
   * column, no stars), 'orbit' (the planet, sparse stars), 'digital'
   * (Cyberspace's horizon) or null for none (the clear colour shows).
   */
  function setVariant(next) {
    group.visible = next !== null
    if (next === null) return
    variant = next
    if (!cubes.has(variant)) cubes.set(variant, bakeNebula(renderer, variant))
    cube = cubes.get(variant)
    nebulaMaterial.uniforms.map.value = cube.texture
    // Sea and digital: none. Orbit: only the brighter third or so, and none
    // through the planet.
    stars.visible = variant === 'space' || variant === 'orbit'
    const orbit = variant === 'orbit'
    starMaterial.uniforms.occluder.value.set(PLANET.x, PLANET.y, PLANET.z, orbit ? PLANET_COS : 2)
    starMaterial.uniforms.faintCut.value = orbit ? 0.09 : 0
  }

  function dispose() {
    for (const baked of cubes.values()) baked.dispose()
    nebula.geometry.dispose()
    nebulaMaterial.dispose()
    stars.geometry.dispose()
    starMaterial.dispose()
  }

  return { object: group, rebake, setVariant, dispose }
}

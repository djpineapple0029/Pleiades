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
varying vec3 vLight;
void main() {
  vLight = light;
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

/** The nebula, rendered once into a cube map by a camera at the centre of a box. */
function bakeNebula(renderer) {
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
      ground: { value: new THREE.Color(VOID_COLOR) },
    },
    defines: { NEBULA_GAIN: NEBULA_GAIN.toFixed(3) },
    vertexShader: BAKE_VERTEX,
    fragmentShader: BAKE_FRAGMENT,
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

  let cube = bakeNebula(renderer)
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
    uniforms: { pixelRatio: { value: 1 } },
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
    cube.dispose()
    cube = bakeNebula(renderer)
    nebulaMaterial.uniforms.map.value = cube.texture
  }

  function dispose() {
    cube.dispose()
    nebula.geometry.dispose()
    nebulaMaterial.dispose()
    stars.geometry.dispose()
    starMaterial.dispose()
  }

  return { object: group, rebake, dispose }
}

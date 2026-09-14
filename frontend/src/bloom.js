import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

/**
 * The layer the star mesh lives on, and nothing else. The canvas pass renders
 * with the camera on layer 0, so it leaves the stars out; the star pass
 * switches the camera to this layer alone. A camera that should see stars
 * without this module has to enable it.
 */
export const STAR_LAYER = 1

/**
 * The layer the node labels live on. It is drawn last, onto the canvas over
 * the star light: stars are added after everything on layer 0, so a label
 * drawn with the rest would have every overlapping glow laid over it.
 */
export const LABEL_LAYER = 2

// Levels in the bloom chain, each half the size of the one before, starting at
// half the drawing buffer. A fixed count keeps the bloom the same fraction of
// the screen at any size or pixel ratio.
const LEVELS = 6
// How much of each wider level survives into the one above it on the way
// back up: higher is a wider, softer bloom for the same total light. Past
// ~0.6 a dense map fills in with a grey haze between its stars.
const SCATTER = 0.5
// Share of the star light that is spread out as bloom. All of it blooms —
// there is no brightness threshold. A threshold is non-linear, and a distant
// star's core is smaller than a pixel, so its sampled peak swings with every
// sub-pixel move; thresholded, its bloom flickered by 17-25% at 1 px radius
// and switched on and off below that. Here each star's bloom follows its
// light as displayed (the star target clips at white, as the screen does),
// which holds within ~1% at 1 px radius. Kept low, it leaves the rays crisp.
const STRENGTH = 0.3

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// 13 taps in five overlapping 2x2 boxes (Jimenez, "Next Generation Post
// Processing in Call of Duty", 2014). A plain one-tap halving aliases: a small
// star moving by less than a pixel would make its bloom flicker.
const DOWNSAMPLE = /* glsl */ `
uniform sampler2D source;
uniform vec2 texel; // of the source
varying vec2 vUv;

vec3 tap(vec2 offset) { return texture2D(source, vUv + offset * texel).rgb; }

void main() {
  vec3 outer = (tap(vec2(-2.0, 2.0)) + tap(vec2(2.0, 2.0)) + tap(vec2(-2.0, -2.0)) + tap(vec2(2.0, -2.0))) * 0.03125;
  vec3 cross = (tap(vec2(0.0, 2.0)) + tap(vec2(-2.0, 0.0)) + tap(vec2(2.0, 0.0)) + tap(vec2(0.0, -2.0))) * 0.0625;
  vec3 inner = (tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0)) + tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0))) * 0.125;
  gl_FragColor = vec4(outer + cross + inner + tap(vec2(0.0)) * 0.125, 1.0);
}
`

// 3x3 tent over the smaller level, blended into the larger one as
// mix(larger, tent, scatter) by the blend state below.
const UPSAMPLE = /* glsl */ `
uniform sampler2D source;
uniform vec2 texel; // of the source
uniform float scatter;
varying vec2 vUv;

vec3 tap(float x, float y) { return texture2D(source, vUv + vec2(x, y) * texel).rgb; }

void main() {
  vec3 tent = tap(0.0, 0.0) * 4.0
    + (tap(-1.0, 0.0) + tap(1.0, 0.0) + tap(0.0, -1.0) + tap(0.0, 1.0)) * 2.0
    + tap(-1.0, -1.0) + tap(1.0, -1.0) + tap(-1.0, 1.0) + tap(1.0, 1.0);
  gl_FragColor = vec4(tent * (scatter / 16.0), scatter);
}
`

const COMPOSITE = /* glsl */ `
uniform sampler2D stars;
uniform sampler2D bloom;
uniform float strength;
varying vec2 vUv;

void main() {
  // Same size as the canvas, so fetch the texel rather than filter it.
  vec3 light = texelFetch(stars, ivec2(gl_FragCoord.xy), 0).rgb + strength * texture2D(bloom, vUv).rgb;
  gl_FragColor = vec4(light, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Bloom fades over hundreds of pixels on a near-black ground, which bands
  // badly in 8 bits. Quantise here with a per-pixel offset instead: the
  // additive blend then adds exactly k/255, the error averages out, and where
  // there is no light at all nothing is added.
  float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  gl_FragColor.rgb = floor(min(gl_FragColor.rgb, 1.0) * 255.0 + dither) / 255.0;
}
`

const TARGET_OPTIONS = { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }

/**
 * Selective bloom for the star layer. Each frame the stars are drawn once,
 * alone, into their own target; that target is bloomed; everything else is
 * drawn onto the canvas; stars plus bloom are added on top of it in one
 * full-screen pass; and the labels go over the lot.
 *
 * The stars are never drawn twice — their shader is the dominant GPU cost. The
 * split is exact because nothing in the scene writes depth and the stars blend
 * additively, so adding them last gives the same frame as drawing them in
 * place. Only what is on STAR_LAYER blooms; edges, halos, labels, the sky and
 * the HTML UI never do.
 */
export function createBloom(renderer, scene, camera, options = {}) {
  const { strength = STRENGTH, scatter = SCATTER } = options
  const size = new THREE.Vector2()
  let width = 0
  let height = 0

  // 8-bit sRGB, like the canvas: star light past 1.0 is white on screen
  // whatever it is, and needs no more range here. The GPU blends in linear
  // and encodes on write. Half-float would double the bandwidth of the three
  // full-screen passes that touch it — measured at ~0.3 ms at 2560x1600.
  const starTarget = new THREE.WebGLRenderTarget(1, 1, { ...TARGET_OPTIONS, colorSpace: THREE.SRGBColorSpace })
  // The bloom levels are small, and blurred light sums past 1.0.
  const levels = Array.from({ length: LEVELS }, () => new THREE.WebGLRenderTarget(1, 1, { ...TARGET_OPTIONS, type: THREE.HalfFloatType }))

  const quad = new FullScreenQuad()
  const passDefaults = { vertexShader: VERTEX, depthTest: false, depthWrite: false }
  const downsample = new THREE.ShaderMaterial({
    ...passDefaults,
    uniforms: { source: { value: null }, texel: { value: new THREE.Vector2() } },
    fragmentShader: DOWNSAMPLE,
    blending: THREE.NoBlending,
  })
  const upsample = new THREE.ShaderMaterial({
    ...passDefaults,
    uniforms: { source: { value: null }, texel: { value: new THREE.Vector2() }, scatter: { value: scatter } },
    fragmentShader: UPSAMPLE,
    // dst = tent * scatter + dst * (1 - scatter): the shader writes scatter to alpha.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  })
  const composite = new THREE.ShaderMaterial({
    ...passDefaults,
    uniforms: {
      stars: { value: starTarget.texture },
      bloom: { value: levels[0].texture },
      strength: { value: strength },
    },
    fragmentShader: COMPOSITE,
    blending: THREE.AdditiveBlending,
  })

  function resize(w, h) {
    width = w
    height = h
    starTarget.setSize(w, h)
    for (let i = 0; i < LEVELS; i++) {
      levels[i].setSize(Math.max(1, Math.round(w / 2 ** (i + 1))), Math.max(1, Math.round(h / 2 ** (i + 1))))
    }
  }

  function pass(material, source, target) {
    material.uniforms.source.value = source.texture
    material.uniforms.texel.value.set(1 / source.width, 1 / source.height)
    quad.material = material
    renderer.setRenderTarget(target)
    quad.render(renderer)
  }

  const clearColor = new THREE.Color()

  function render() {
    // Following the drawing buffer here rather than a resize event also
    // catches a pixel-ratio change, and costs one vector read per frame.
    renderer.getDrawingBufferSize(size)
    if (size.x !== width || size.y !== height) resize(size.x, size.y)

    // The canvas is drawn last and in one go (steps 3 and 4). It is
    // multisampled, and leaving it for another target mid-frame makes the GPU
    // store every sample out and load it back again.

    // 1. The stars alone, onto transparent black. A scene background would be
    // drawn in this pass too, so it is lifted out for it.
    const layers = camera.layers.mask
    const background = scene.background
    const clearAlpha = renderer.getClearAlpha()
    renderer.getClearColor(clearColor)
    camera.layers.set(STAR_LAYER)
    scene.background = null
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(starTarget)
    renderer.render(scene, camera)
    camera.layers.mask = layers
    scene.background = background
    renderer.setClearColor(clearColor, clearAlpha)

    // 2. Bloom: down the chain from the star target, then back up it.
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    pass(downsample, starTarget, levels[0])
    for (let i = 1; i < LEVELS; i++) pass(downsample, levels[i - 1], levels[i])
    for (let i = LEVELS - 2; i >= 0; i--) pass(upsample, levels[i + 1], levels[i])
    renderer.autoClear = autoClear

    // 3. Everything but the stars.
    renderer.setRenderTarget(null)
    renderer.render(scene, camera)

    // 4. Stars plus bloom, added on top.
    renderer.autoClear = false
    quad.material = composite
    quad.render(renderer)

    // 5. Labels over all of it. Still the canvas, so still one pass over its
    // samples.
    camera.layers.set(LABEL_LAYER)
    scene.background = null
    renderer.render(scene, camera)
    camera.layers.mask = layers
    scene.background = background
    renderer.autoClear = autoClear
  }

  function dispose() {
    starTarget.dispose()
    for (const level of levels) level.dispose()
    for (const material of [downsample, upsample, composite]) material.dispose()
    quad.dispose()
  }

  return { render, dispose }
}

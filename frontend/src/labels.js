import * as THREE from 'three'
// Bundled with the app rather than fetched: the labels are rasterised on a
// canvas, which silently falls back to another face if the font is missing,
// and this map should read the same offline and on every platform.
import '@fontsource/jost/400.css'
import '@fontsource/jost/500.css'
import { LABEL_LAYER } from './bloom.js'
import { clusterInk } from './palette.js'

// --- Which labels show -------------------------------------------------------
// Sizes here are the node's drawn size as a multiple of the base radius, so
// the rule follows `graph.sizeOf` (degree and core influence) as it eases.
//
// A node at ALWAYS_ON_SIZE or above is labelled at any distance: every core
// node (3x), each core's direct neighbours (2.24x), and nodes at the degree
// cap. Below it a label is revealed within revealRange(size) of the camera,
// which grows with the cube of the size, so a bigger star's name carries
// further: 200 units for an unlinked node, 300 at one link, 440 at three,
// 820 at fifteen, 1100 two hops from a core.
export const ALWAYS_ON_SIZE = 2
const REVEAL_BASE = 200
const REVEAL_GROWTH = 3
// A revealed label fades in across the outer quarter of its range.
const REVEAL_FADE = 0.25
// Flying through a star: its label goes between these many drawn radii from
// the camera, before the label is pushed off the screen by the offset below.
const NEAR_CLEAR = 1.5
const NEAR_FULL = 3

export function revealRange(size) {
  return size >= ALWAYS_ON_SIZE ? Infinity : REVEAL_BASE * size ** REVEAL_GROWTH
}

// --- Which connection names show ---------------------------------------------
// A connection's name rides its own line, so the line is its leader and there
// is no callout. `size` here is the larger of the two stars it joins.
//
// Nothing is ever always-on, however big those stars are: an overview stays a
// map of stars rather than a page of prose. A plain pair name themselves within
// 140 units, a core's connections from 1260 — far enough to read a hub's
// spokes on the way in, short enough that the map empties again from outside.
const EDGE_REVEAL_BASE = 140
const EDGE_REVEAL_GROWTH = 2

export function edgeRevealRange(size) {
  return EDGE_REVEAL_BASE * size ** EDGE_REVEAL_GROWTH
}

// Room the name needs along the line. `edges.js` fades an edge out within
// END_FULL radii of each star, so the run between those two glows is what is
// left to write on; it has to hold the ink plus a little air at each end. This
// is also what keeps a name off a connection seen nearly end-on, which is a
// few pixels long however far apart its ends really are.
const EDGE_END_CLEAR = 2.4
const EDGE_AIR_PX = 6
// The ink sits this many CSS px clear of the line, on its upper side, so the
// line runs under the name rather than through the lettering.
const EDGE_OFFSET_PX = 7
// A connection's name never outranks a star's for a contested spot.
const EDGE_PRIORITY = 0.5
// As tall as this many base radii at the midpoint's distance — about half a
// plain star's name at the same range, so the stars still read first.
const EDGE_HEIGHT = 0.38

// --- Four tiers -----------------------------------------------------------------
// A core is the head of its neighbourhood, so its name is set the way a chart
// sets a constellation: capitals, widely tracked. Landmarks (a core's
// neighbours, and anything at the degree cap) are only brighter, and the rest
// dimmer still — the same words as typed, so a name stays searchable by eye.
// EDGE is not a rank among those three: it is what a connection's name is set
// in, quieter and smaller than any star's, because it labels the line between
// two things that are themselves already named.
const PLAIN = 0
const LANDMARK = 1
const CORE = 2
const EDGE = 3

// --- How they look -------------------------------------------------------------
// On-screen font size, CSS px: as tall as LABEL_HEIGHT drawn radii of the node
// would be at its distance, kept between a floor and a ceiling. The range is
// wide on purpose. It is what makes a label read as belonging to its own star
// in a crowd: a near star's name is several times the size of a far one's,
// exactly as the stars themselves differ, so size pairs name to star before
// the leader line is even followed.
const LABEL_HEIGHT = 0.7
const MIN_PX = [10, 11, 12, 9]
const MAX_PX = [26, 28, 30, 18]
// Distance also drains a label's strength, the way `edges.js` fogs a far edge.
// Full at DIM_FULL_PX and above, down to FAR_DIM at the floor, so a distant
// name sits behind a near one instead of competing with it. A core never goes
// below CORE_DIM: it is the landmark you navigate by.
const FAR_DIM = 0.58
const CORE_DIM = 0.75
const DIM_FULL_PX = 18

// A name is never laid across another star: in the glare it would read as
// that star's own. Discs under STAR_MIN_PX are specks, and keeping off them
// in a dense field would leave nowhere to put anything.
const STAR_MIN_PX = 3
const STAR_CLEAR_PX = 2

// A leader runs out of the star at 45 degrees, turns level, and the name sits
// at the end of it — a chart's callout. It starts clear of the core, the glow
// and the hover ring (at 1.35 radii), grows a little with the star, and the
// level shelf gives the eye the turn it needs to find the text.
const GAP_RADII = 1.5
const GAP_PX = 3
const LEADER_PX = 12
const LEADER_PER_RADIUS = 0.12
const SHELF_PX = 8
const TEXT_GAP_PX = 5
const LEADER_WIDTH = 1 // CSS px
const LEADER_ALPHA = 0.55
const HOVER_LEADER_ALPHA = 0.95
// Which way the callout goes, in preference order: down and to the right
// first, the reading direction, then up, then the same on the left.
const QUADS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]
// A connection's name is not a callout and has no quadrant to choose.
const NO_QUADS = []
// Labels closer than this on screen, CSS px, count as overlapping.
const CLEARANCE_PX = 4
// Time constant, in seconds, of a label fading in or out when it wins or loses
// its place on screen.
const FADE_EASE = 0.1
// Priority bonus for a label already on screen, so two labels jostling for
// the same spot don't swap every frame.
const HOLD_BONUS = 1.3

// Colours are sRGB, written straight to the canvas: the shader does no colour
// management, so its blending is the same gamma-space blend browser text gets.
const srgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]
const INK = [srgb(0xc2ccdb), srgb(0xdde5f2), srgb(0xeef2fa), srgb(0x9fb0c6)]
const HOVER_INK = srgb(0xffbe6b) // the hover ring's colour
// A label carries its cluster's hue mixed *into* the tier's ink rather than
// replacing it: the tiers stay apart by brightness, and the ink stays light
// enough to read over the soft dark halo. Hover keeps the amber, so the one
// label under the crosshair is never mistaken for a cluster colour.
const CLUSTER_INK_MIX = 0.45
const inkCache = new Map()
function inkFor(tier, colorId) {
  if (!colorId) return INK[tier]
  const key = tier * 1024 + colorId
  let ink = inkCache.get(key)
  if (ink) return ink
  const hue = clusterInk(colorId)
  ink = INK[tier].map((channel, i) => channel + (hue[i] - channel) * CLUSTER_INK_MIX)
  inkCache.set(key, ink)
  return ink
}
// Behind the glyphs, a dark halo keeps text readable over star light and the
// nebula. Not an outline: a wide, soft fall-off of the void's own colour, so
// the text sits in the dark between the stars rather than on a sticker.
const HALO_OPACITY = 0.62

// --- The atlas -------------------------------------------------------------------
// Every label is drawn once, with Canvas 2D, into a shared texture at FONT_PX
// and scaled on the GPU; mipmaps cover the way down to the floor on a 1x
// screen, and FONT_PX is above the ceiling so a near label is never magnified.
// The atlas is a grid of CELL_W x CELL_H cells, and a label takes 1..MAX_SPAN
// cells side by side in one row. Cell edges fall on multiples of 16 texels, so
// the first four mip levels never blend one cell into the next.
const FONT_PX = 40
const FAMILY = 'Jost, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
const WEIGHT = [400, 400, 500, 400]
// Tracking, in ems of the font size. Wide on the capitals, a little air on the
// rest; the hovered label opens up further still. A connection's name is
// tracked a shade wider than a star's, which is what a small, dim face needs to
// stay readable lying along a line.
const TRACKING = [0.09, 0.09, 0.26, 0.12]
const HOVER_TRACKING = 0.04
// The halo, drawn as two blurred passes: a tight one that carries most of the
// darkness and a wide one that fades it out into the scene.
const HALO_NEAR = 5
const HALO_FAR = 12
const PAD_X = 14 // clear texels either side of the text, for the halo and filtering
const CELL_W = 128
const CELL_H = 80
const MAX_SPAN = 6
const ATLAS_SIZE = 2048
const COLS = ATLAS_SIZE / CELL_W
const ROWS = Math.floor(ATLAS_SIZE / CELL_H)
const MAX_TEXT_PX = MAX_SPAN * CELL_W - 2 * PAD_X
// Most labels drawn in one frame; beyond it the lowest-priority ones wait.
// Far more than fit on a screen without overlapping at the floor size.
const MAX_LABELS = 512
// New labels rasterised per frame. Flying into a dense region spreads the
// work over a few frames rather than stalling one.
const MAX_RASTERS_PER_FRAME = 24
// Sharpens the mip choice a little: text reads better slightly crisp.
const LOD_BIAS = -0.5

const VERTEX = /* glsl */ `
attribute vec3 labelCentre; // the node, or an edge's midpoint, world space
attribute vec4 labelBox; // quad centre from the anchor's projected centre, and quad size; CSS px, y up
attribute vec4 labelRect; // the quad's texels in the atlas: u, v, width, height
attribute vec4 labelStyle; // sRGB colour, opacity
attribute vec2 labelTurn; // cos, sin of the quad's turn; (1, 0) for a star's name
uniform vec2 viewport; // device px
uniform float pixelRatio;
varying vec2 vUv;
varying vec4 vStyle;

void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(labelCentre, 1.0);
  vec2 centre = (clip.xy / clip.w * 0.5 + 0.5) * viewport;
  vec2 size = labelBox.zw * pixelRatio;
  vec2 anchor = centre + labelBox.xy * pixelRatio;
  vec2 px;
  if (labelTurn.x == 1.0 && labelTurn.y == 0.0) {
    // Upright: the corner on a whole device pixel, so that at its atlas scale
    // text lands texel-for-pixel instead of smeared across two.
    vec2 corner = floor(anchor - 0.5 * size + 0.5);
    px = corner + (position.xy + 0.5) * size;
  } else {
    // Turned to its line, where there is no pixel grid to land on anyway.
    vec2 local = position.xy * size;
    px = anchor + vec2(labelTurn.x * local.x - labelTurn.y * local.y, labelTurn.y * local.x + labelTurn.x * local.y);
  }
  gl_Position = vec4(px / viewport * 2.0 - 1.0, 0.0, 1.0);
  // Atlas rows run top-down, the quad bottom-up.
  vUv = labelRect.xy + vec2(position.x + 0.5, 0.5 - position.y) * labelRect.zw;
  vStyle = labelStyle;
}
`

const FRAGMENT = /* glsl */ `
uniform sampler2D atlas;
varying vec2 vUv;
varying vec4 vStyle;

void main() {
  // r: glyph coverage; g: the halo's.
  vec2 ink = texture2D(atlas, vUv, LOD_BIAS).rg;
  float halo = max(ink.g, ink.r) * HALO_OPACITY;
  // Text over its black halo, premultiplied.
  float alpha = ink.r + halo * (1.0 - ink.r);
  gl_FragColor = vec4(vStyle.rgb * ink.r, alpha) * vStyle.a;
}
`

// One instance per straight run of a leader: the diagonal out of the star and
// the level shelf under the name. Both ends are CSS px from the node's
// projected centre, so a leader keeps its shape at any distance, and the quad
// is built around them here rather than on the CPU.
const LEADER_VERTEX = /* glsl */ `
attribute vec3 leaderCentre; // the node, world space
attribute vec4 leaderEnds; // from, to; CSS px from the projected centre, y up
attribute vec4 leaderStyle; // sRGB colour, opacity
uniform vec2 viewport; // device px
uniform float pixelRatio;
varying float vAcross; // -1 at one edge of the line, 1 at the other
varying float vFeather;
varying vec4 vStyle;

void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(leaderCentre, 1.0);
  vec2 centre = (clip.xy / clip.w * 0.5 + 0.5) * viewport;
  vec2 from = centre + leaderEnds.xy * pixelRatio;
  vec2 to = centre + leaderEnds.zw * pixelRatio;
  vec2 along = to - from;
  float len = length(along);
  along = len > 0.0 ? along / len : vec2(1.0, 0.0);
  vec2 across = vec2(-along.y, along.x);
  // Half a width of overhang at each end fills the elbow where the two runs
  // meet, and the feather is the pixel the edge fades out across.
  float halfWidth = 0.5 * (WIDTH * pixelRatio + FEATHER);
  vec2 px = mix(from - along * halfWidth, to + along * halfWidth, position.x + 0.5) + across * position.y * 2.0 * halfWidth;
  gl_Position = vec4(px / viewport * 2.0 - 1.0, 0.0, 1.0);
  vAcross = position.y * 2.0;
  vFeather = FEATHER / (WIDTH * pixelRatio + FEATHER);
  vStyle = leaderStyle;
}
`

const LEADER_FRAGMENT = /* glsl */ `
varying float vAcross;
varying float vFeather;
varying vec4 vStyle;

void main() {
  float alpha = (1.0 - smoothstep(1.0 - vFeather, 1.0, abs(vAcross))) * vStyle.a;
  gl_FragColor = vec4(vStyle.rgb * alpha, alpha);
}
`

/**
 * Labels drawn in the scene: every visible one is an instance of a single quad,
 * sampling one shared atlas. One draw call for the names and one for their
 * leader lines.
 *
 * Two kinds share all of that. A **star's** name is upright, offset from the
 * node by a callout with a leader. A **connection's** name comes from
 * `edge.label`, rides the line at its midpoint turned to the line's direction
 * on screen, and has no leader, because the line itself is one. Both are laid
 * out and decluttered together, so a connection's name never lands on a star's.
 *
 * Both meshes are on LABEL_LAYER, which `bloom.js` draws last, onto the canvas
 * over the star light, so a star's glow never washes a label out and labels
 * never bloom. Nothing in the scene writes depth, so labels are not hidden
 * behind nearer stars; they are sorted among themselves instead, by keeping
 * them from overlapping at all (see `update`).
 *
 * The labels' text comes from `node.label`, read every frame, so an edit
 * shows with no call to this module. A node with no label draws nothing.
 * `radiusOf(id)` is the drawn node radius, eased; `baseRadius` is its 1x.
 */
export function createLabels(graph, parent, renderer, { radiusOf, baseRadius }) {
  // Allocated on the GPU at full size but never uploaded from here: WebGL
  // zero-fills it, so the 8 MB of zeros need not exist in JS as well.
  const atlas = new THREE.DataTexture(null, ATLAS_SIZE, ATLAS_SIZE, THREE.RGFormat, THREE.UnsignedByteType)
  atlas.source.dataReady = false
  atlas.minFilter = THREE.LinearMipmapLinearFilter
  atlas.magFilter = THREE.LinearFilter
  atlas.generateMipmaps = true // allocates the mip chain; see `flushRasters`
  atlas.needsUpdate = true
  renderer.initTexture(atlas)
  // Every later write is a sub-image copy from a canvas, which is
  // premultiplied: taken as is, r and g are the two coverages exactly.
  atlas.premultiplyAlpha = true

  // One scratch canvas per span, so a copy is always the whole canvas. Never
  // uploaded as textures in their own right, only copied from.
  const scratch = Array.from({ length: MAX_SPAN }, (_, i) => {
    const canvas = document.createElement('canvas')
    canvas.width = (i + 1) * CELL_W
    canvas.height = CELL_H
    const ctx = canvas.getContext('2d')
    return { canvas, ctx, texture: new THREE.Texture(canvas) }
  })
  const measure = scratch[0].ctx

  /** The font and tracking of one tier, on any 2D context. */
  function useFont(ctx, tier, hovered) {
    ctx.font = `${WEIGHT[tier]} ${FONT_PX}px ${FAMILY}`
    ctx.letterSpacing = `${(TRACKING[tier] + (hovered ? HOVER_TRACKING : 0)) * FONT_PX}px`
  }

  // Where the ink sits inside a cell, in texels. Read from the font itself, so
  // a fall-back face while Jost loads is still centred.
  let baseline = 0
  let ascent = 0
  let descent = 0
  function readMetrics() {
    useFont(measure, CORE, false)
    const metrics = measure.measureText('Hg')
    ascent = metrics.fontBoundingBoxAscent ?? FONT_PX * 0.93
    descent = metrics.fontBoundingBoxDescent ?? FONT_PX * 0.24
    baseline = Math.round((CELL_H + ascent - descent) / 2)
  }
  readMetrics()

  // Canvas 2D falls back silently, so nothing may be rasterised in Jost until
  // the face is in: whatever was drawn before it lands is thrown away and
  // redrawn once, on the frame after.
  Promise.all(WEIGHT.map((weight) => document.fonts.load(`${weight} ${FONT_PX}px Jost`)))
    .then(() => {
      readMetrics()
      for (const entry of entries.values()) {
        release(entry)
        entry.source = null // forces setText, and with it a fresh measure
      }
    })
    .catch(() => {})

  const occupied = new Uint8Array(ROWS * COLS)
  const copyTo = new THREE.Vector2()

  const quad = new THREE.PlaneGeometry(1, 1)
  const uniforms = {
    atlas: { value: atlas },
    viewport: { value: new THREE.Vector2(1, 1) },
    pixelRatio: { value: 1 },
  }

  function instanced(count, attributes) {
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = quad.index
    geometry.setAttribute('position', quad.getAttribute('position'))
    const written = {}
    for (const [name, size] of attributes) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size)
      a.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute(name, a)
      written[name] = a
    }
    geometry.instanceCount = 0
    return { geometry, ...written }
  }

  const {
    geometry,
    labelCentre: centres,
    labelBox: boxes,
    labelRect: rects,
    labelStyle: styles,
    labelTurn: turns,
  } = instanced(MAX_LABELS, [
    ['labelCentre', 3],
    ['labelBox', 4],
    ['labelRect', 4],
    ['labelStyle', 4],
    ['labelTurn', 2],
  ])
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: { HALO_OPACITY: HALO_OPACITY.toFixed(3), LOD_BIAS: LOD_BIAS.toFixed(3) },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    premultipliedAlpha: true, // NormalBlending as ONE, ONE_MINUS_SRC_ALPHA
    depthTest: false,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'labels'
  mesh.layers.set(LABEL_LAYER)
  mesh.frustumCulled = false // positions come from the instance attributes
  mesh.visible = false
  mesh.renderOrder = 1 // over the leaders
  parent.add(mesh)

  // Two runs to a leader: the diagonal and the shelf.
  const {
    geometry: leaderGeometry,
    leaderCentre: leaderCentres,
    leaderEnds,
    leaderStyle: leaderStyles,
  } = instanced(2 * MAX_LABELS, [
    ['leaderCentre', 3],
    ['leaderEnds', 4],
    ['leaderStyle', 4],
  ])
  const leaderMesh = new THREE.Mesh(
    leaderGeometry,
    new THREE.ShaderMaterial({
      uniforms,
      defines: { WIDTH: LEADER_WIDTH.toFixed(3), FEATHER: '1.0' },
      vertexShader: LEADER_VERTEX,
      fragmentShader: LEADER_FRAGMENT,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
    })
  )
  leaderMesh.name = 'labelLeaders'
  leaderMesh.layers.set(LABEL_LAYER)
  leaderMesh.frustumCulled = false
  leaderMesh.visible = false
  leaderMesh.renderOrder = 0
  parent.add(leaderMesh)

  // 'n:<node id>' or 'e:<edge id>' -> { id, kind, source, text, tier, width,
  // cell, alpha, placed, used, ... }. Prefixed because a loaded file's node and
  // edge ids are whatever was in it, and need not be from two namespaces.
  const entries = new Map()
  let hoverId = null
  let hoverKind = null
  let frame = 0
  const drawn = [] // entries the last update put on screen, for `shown()`
  const pending = [] // entries given cells this frame, rasterised before it is drawn

  /** Width of the ink alone: the trailing letter-space is not part of it. */
  function textWidth(text, tier, hovered) {
    if (!text) return 0
    useFont(measure, tier, hovered)
    const tracking = (TRACKING[tier] + (hovered ? HOVER_TRACKING : 0)) * FONT_PX
    return Math.max(0, measure.measureText(text).width - tracking)
  }

  /** Fits the label on one line within MAX_TEXT_PX, cutting it short with an ellipsis. */
  function fit(source, tier, hovered) {
    const text = source.replace(/\s+/g, ' ').trim()
    if (!text || textWidth(text, tier, hovered) <= MAX_TEXT_PX) return text
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (textWidth(`${text.slice(0, mid).trimEnd()}…`, tier, hovered) <= MAX_TEXT_PX) lo = mid
      else hi = mid - 1
    }
    return `${text.slice(0, lo).trimEnd()}…`
  }

  /**
   * The drawn text of an entry, for its tier and hover state. A core is set in
   * capitals, so its raster changes when a node is marked or unmarked, and the
   * hovered label's wider tracking is another raster again: `rasterKey` is
   * what decides whether the one in the atlas is still the right picture.
   */
  function setText(entry, source, tier, hovered) {
    release(entry)
    entry.source = source
    entry.tier = tier
    entry.rasterHovered = hovered
    const cased = tier === CORE ? (source ?? '').toLocaleUpperCase() : (source ?? '')
    entry.text = fit(cased, tier, hovered)
    entry.width = textWidth(entry.text, tier, hovered)
    entry.span = Math.min(MAX_SPAN, Math.ceil((entry.width + 2 * PAD_X) / CELL_W))
  }

  function release(entry) {
    if (!entry.cell) return
    const { row, col } = entry.cell
    occupied.fill(0, row * COLS + col, row * COLS + col + entry.span)
    entry.cell = null
  }

  function findRun(span) {
    for (let row = 0; row < ROWS; row++) {
      let run = 0
      for (let col = 0; col < COLS; col++) {
        run = occupied[row * COLS + col] ? 0 : run + 1
        if (run === span) return { row, col: col - span + 1 }
      }
    }
    return null
  }

  /**
   * Claims atlas cells for an entry, evicting labels that are not on screen,
   * least recently shown first, until a run fits. Returns false if everything
   * that could go is on screen now.
   */
  function allocate(entry) {
    let cell = findRun(entry.span)
    if (!cell) {
      const idle = [...entries.values()].filter((e) => e.cell && e.used < frame).sort((a, b) => a.used - b.used)
      for (const victim of idle) {
        release(victim)
        cell = findRun(entry.span)
        if (cell) break
      }
    }
    if (!cell) return false
    occupied.fill(1, cell.row * COLS + cell.col, cell.row * COLS + cell.col + entry.span)
    entry.cell = cell
    pending.push(entry)
    return true
  }

  function rasterise(entry) {
    const { canvas, ctx, texture } = scratch[entry.span - 1]
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    useFont(ctx, entry.tier, entry.rasterHovered)
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.lineJoin = 'round'
    // Halo into the green channel, glyphs into red; 'lighter' adds them
    // without either covering the other. Two blurred passes of the glyphs
    // themselves, near and far, make a fall-off rather than an outline.
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = 'rgb(0, 0, 0)'
    ctx.shadowColor = 'rgb(0, 255, 0)'
    for (const blur of [HALO_NEAR, HALO_FAR]) {
      ctx.shadowBlur = blur
      ctx.fillText(entry.text, PAD_X, baseline)
    }
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = 'rgb(255, 0, 0)'
    ctx.fillText(entry.text, PAD_X, baseline)
    copyTo.set(entry.cell.col * CELL_W, entry.cell.row * CELL_H)
    return texture
  }

  /**
   * Copies this frame's new labels into the atlas, then rebuilds the mip
   * chain once: three regenerates it on every copy that has `generateMipmaps`
   * set, and the whole 2048² chain per label would add up fast.
   */
  function flushRasters() {
    for (let i = 0; i < pending.length; i++) {
      const texture = rasterise(pending[i])
      atlas.generateMipmaps = i === pending.length - 1
      renderer.copyTextureToTexture(texture, atlas, null, copyTo)
    }
    atlas.generateMipmaps = true
    pending.length = 0
  }

  // Placed labels, bucketed by screen area for the overlap test.
  const BUCKET = 64
  const buckets = new Map()
  function bucketRange(r, visit) {
    const x0 = Math.floor(r.x0 / BUCKET)
    const x1 = Math.floor(r.x1 / BUCKET)
    const y0 = Math.floor(r.y0 / BUCKET)
    const y1 = Math.floor(r.y1 / BUCKET)
    for (let by = y0; by <= y1; by++) {
      for (let bx = x0; bx <= x1; bx++) if (visit(bx * 4096 + by) === false) return false
    }
    return true
  }
  const overlaps = (r) =>
    !bucketRange(r, (key) => {
      const list = buckets.get(key)
      if (!list) return true
      for (const o of list) if (r.x0 < o.x1 && o.x0 < r.x1 && r.y0 < o.y1 && o.y0 < r.y1) return false
      return true
    })
  const occupy = (r) =>
    bucketRange(r, (key) => {
      const list = buckets.get(key)
      if (list) list.push(r)
      else buckets.set(key, [r])
    })

  // Every star on screen, in the same buckets, so a name can be kept off the
  // discs. Rebuilt each frame from the pass over the nodes; the discs
  // themselves are pooled, since a big map indexes thousands a frame.
  const starBuckets = new Map()
  const discs = []
  let discCount = 0
  const discBox = { x0: 0, y0: 0, x1: 0, y1: 0 }
  function addStar(x, y, r, id) {
    let disc = discs[discCount]
    if (!disc) discs[discCount] = disc = { x: 0, y: 0, r: 0, id: null, mark: 0 }
    discCount++
    disc.x = x
    disc.y = y
    disc.r = r
    disc.id = id
    discBox.x0 = x - r
    discBox.x1 = x + r
    discBox.y0 = y - r
    discBox.y1 = y + r
    bucketRange(discBox, (key) => {
      const list = starBuckets.get(key)
      if (list) list.push(disc)
      else starBuckets.set(key, [disc])
    })
  }
  // One disc sits in several buckets and a rect may span the same ones, so a
  // stamp keeps a star from being counted twice against one rect.
  let stamp = 0
  /** How many stars other than `selfId`'s the rect `r` lies across. */
  function starsUnder(r, selfId) {
    stamp++
    let n = 0
    bucketRange(r, (key) => {
      const list = starBuckets.get(key)
      if (!list) return
      for (const disc of list) {
        if (disc.id === selfId || disc.mark === stamp) continue
        disc.mark = stamp
        const nx = clamp(disc.x, r.x0, r.x1)
        const ny = clamp(disc.y, r.y0, r.y1)
        const reach = disc.r + STAR_CLEAR_PX
        if ((nx - disc.x) ** 2 + (ny - disc.y) ** 2 < reach * reach) n++
      }
    })
    return n
  }

  const size = new THREE.Vector2()
  const viewMatrix = new THREE.Matrix4()
  const eye = new THREE.Vector3()
  const point = new THREE.Vector3()
  const candidates = []

  // The frame's camera, for `project`. Held here rather than passed down so
  // that projecting a point allocates nothing.
  const screenPoint = new THREE.Vector3()
  const mid = { x: 0, y: 0 }
  const endA = { x: 0, y: 0 }
  const endB = { x: 0, y: 0 }
  let frameWidth = 1
  let frameHeight = 1
  let frameNear = 0
  let frameProjection = null

  /**
   * A world point to CSS px, y down, into `out`. Returns the point's depth, or
   * 0 for one at or behind the near plane, which has no screen position at all.
   */
  function project(x, y, z, out) {
    screenPoint.set(x, y, z).applyMatrix4(viewMatrix)
    const depth = -screenPoint.z
    if (depth <= frameNear) return 0
    screenPoint.applyMatrix4(frameProjection)
    out.x = (screenPoint.x * 0.5 + 0.5) * frameWidth
    out.y = (0.5 - screenPoint.y * 0.5) * frameHeight
    return depth
  }

  /**
   * Lays a connection's name along its line: the ink's centre, offset to the
   * upper side of the line, and the axis-aligned box it covers. That box is
   * what the overlap test sees, so a turned name reserves a little more than
   * it really covers. Which way the name runs is already on the entry.
   */
  function setEdgeLayout(entry) {
    const out = entry.layout ?? (entry.layout = { rect: {} })
    const off = EDGE_OFFSET_PX + entry.inkHeight / 2
    out.cx = entry.sx + entry.perpX * off
    out.cy = entry.sy + entry.perpY * off
    const hw = entry.inkWidth / 2 + CLEARANCE_PX / 2
    const hh = entry.inkHeight / 2 + CLEARANCE_PX / 2
    const ax = Math.abs(entry.dirX) * hw + Math.abs(entry.dirY) * hh
    const ay = Math.abs(entry.dirY) * hw + Math.abs(entry.dirX) * hh
    const r = out.rect
    r.x0 = out.cx - ax
    r.x1 = out.cx + ax
    r.y0 = out.cy - ay
    r.y1 = out.cy + ay
    return out
  }

  const layoutFor = (entry) => (entry.kind === 'edge' ? setEdgeLayout(entry) : setLayout(entry, entry.quad))

  /**
   * Lays out one entry's callout on `quad`: the leader's corners and the ink's
   * rect, all in CSS px, y down. The rects are what the overlap test sees —
   * the text, and the leader, which no other name may sit across either.
   */
  function setLayout(entry, quadIndex) {
    const [qx, qy] = QUADS[quadIndex]
    const out = entry.layout ?? (entry.layout = { rect: {}, lead: {} })
    const start = entry.gap * Math.SQRT1_2
    const run = (LEADER_PX + LEADER_PER_RADIUS * entry.radiusPx) * Math.SQRT1_2
    out.qx = qx
    out.qy = qy
    out.x0 = entry.sx + qx * start
    out.y0 = entry.sy + qy * start
    out.x1 = out.x0 + qx * run
    out.y1 = out.y0 + qy * run
    out.x2 = out.x1 + qx * SHELF_PX
    out.y2 = out.y1
    const textX = qx > 0 ? out.x2 + TEXT_GAP_PX : out.x2 - TEXT_GAP_PX - entry.inkWidth
    const textY = out.y2 - entry.inkHeight / 2
    out.textX = textX
    out.textY = textY
    const r = out.rect
    r.x0 = textX - CLEARANCE_PX / 2
    r.y0 = textY - CLEARANCE_PX / 2
    r.x1 = textX + entry.inkWidth + CLEARANCE_PX / 2
    r.y1 = textY + entry.inkHeight + CLEARANCE_PX / 2
    const l = out.lead
    l.x0 = Math.min(out.x0, out.x2)
    l.x1 = Math.max(out.x0, out.x2)
    l.y0 = Math.min(out.y0, out.y2)
    l.y1 = Math.max(out.y0, out.y2)
    return out
  }

  /**
   * Lays every label out for `camera` and writes the instances. Call once a
   * frame, after positions and sizes are current and before the frame is
   * drawn. `dt` is the frame time, for the fades.
   *
   * Each labelled node that is in range and on screen becomes a candidate;
   * candidates are placed in priority order, and one whose text or leader
   * would cross a label already placed is left out. The hovered node comes
   * first, then cores and landmarks, biggest first, then the rest; ties go to
   * the star that looks biggest (drawn radius over distance). A label that
   * loses its place fades out rather than vanishing, and the winner fades in.
   */
  function update(camera, dt) {
    frame++
    renderer.getSize(size)
    const width = size.x
    const height = size.y
    const pixelRatio = renderer.getPixelRatio()
    uniforms.viewport.value.set(width * pixelRatio, height * pixelRatio)
    uniforms.pixelRatio.value = pixelRatio

    // The flight controls moved the camera since the last render updated it.
    camera.updateMatrixWorld()
    viewMatrix.copy(camera.matrixWorld).invert()
    eye.setFromMatrixPosition(camera.matrixWorld)
    // A perspective camera; CSS px per world unit at a depth of 1.
    const pxPerUnit = 0.5 * height * camera.projectionMatrix.elements[5]
    const fade = 1 - Math.exp(-Math.max(dt, 0) / FADE_EASE)
    frameWidth = width
    frameHeight = height
    frameNear = camera.near
    frameProjection = camera.projectionMatrix

    candidates.length = 0
    starBuckets.clear()
    discCount = 0
    let seen = 0
    for (const node of graph.nodes.values()) {
      let entry = entries.get(`n:${node.id}`)
      if (!entry) {
        entry = { id: node.id, kind: 'node', source: null, text: '', tier: PLAIN, cluster: 0, width: 0, span: 1, cell: null, alpha: 0, placed: false, quad: 0, used: 0 }
        entries.set(`n:${node.id}`, entry)
      }
      entry.seen = frame
      seen++
      entry.visibility = 0
      entry.ax = node.x
      entry.ay = node.y
      entry.az = node.z

      const radius = radiusOf(node.id)
      const nodeSize = radius / baseRadius
      const hovered = hoverKind === 'node' && node.id === hoverId
      const landmark = nodeSize >= ALWAYS_ON_SIZE
      // A core is read from the model, not from its drawn size: the size eases
      // over a quarter second, and the capitals should not flicker on the way.
      const tier = node.is_core ? CORE : landmark ? LANDMARK : PLAIN
      if (entry.source !== node.label || entry.tier !== tier || entry.rasterHovered !== hovered) {
        setText(entry, node.label, tier, hovered)
      }

      point.set(node.x, node.y, node.z)
      const distance = point.distanceTo(eye)
      point.applyMatrix4(viewMatrix)
      const depth = -point.z
      if (depth <= camera.near) continue
      // Screen position, CSS px, y down.
      point.applyMatrix4(camera.projectionMatrix)
      const sx = (point.x * 0.5 + 0.5) * width
      const sy = (0.5 - point.y * 0.5) * height
      const radiusPx = (radius * pxPerUnit) / depth
      // Named or not, every star on screen is indexed: a name has to keep off
      // all of them, not only the ones carrying a name of their own.
      if (radiusPx >= STAR_MIN_PX && sx + radiusPx > 0 && sx - radiusPx < width && sy + radiusPx > 0 && sy - radiusPx < height) {
        addStar(sx, sy, radiusPx, node.id)
      }
      if (!entry.text) continue

      const range = revealRange(nodeSize)
      let visibility = hovered || landmark ? 1 : smoothstep(range, range * (1 - REVEAL_FADE), distance)
      visibility *= smoothstep(NEAR_CLEAR, NEAR_FULL, distance / radius)
      if (visibility <= 0) continue

      const fontPx = clamp(LABEL_HEIGHT * radiusPx, MIN_PX[tier], MAX_PX[tier])
      const scale = fontPx / FONT_PX
      // Distance drains the far ones; the hovered label is never drained.
      const dim = hovered
        ? 1
        : Math.max(FAR_DIM + (1 - FAR_DIM) * smoothstep(MIN_PX[tier], DIM_FULL_PX, fontPx), tier === CORE ? CORE_DIM : 0)
      const inkWidth = entry.width * scale
      const inkHeight = (ascent + descent) * scale
      const gap = GAP_RADII * radiusPx + GAP_PX
      const reach = gap + LEADER_PX + LEADER_PER_RADIUS * radiusPx + SHELF_PX + TEXT_GAP_PX + inkWidth
      // Off screen however the callout is turned.
      if (sx + reach < 0 || sx - reach > width || sy + reach < 0 || sy - reach > height) continue

      entry.visibility = visibility
      entry.dim = dim
      entry.fontPx = fontPx
      entry.scale = scale
      entry.sx = sx
      entry.sy = sy
      entry.gap = gap
      entry.radiusPx = radiusPx
      entry.inkWidth = inkWidth
      entry.inkHeight = inkHeight
      entry.hovered = hovered
      // Colour only: the casing and size already carry the tier, so the hue is
      // free to say which cluster this name belongs to.
      entry.cluster = node.cluster_color_id
      // Cores and landmarks rank by size before nearness, so a core keeps its
      // label over a neighbour that happens to be closer.
      const rank = hovered ? 1e6 : landmark ? 1e3 * nodeSize : 0
      entry.priority = rank + (radius / depth) * (entry.placed ? HOLD_BONUS : 1)
      // Still fading out, so still drawn: its cells must survive this frame.
      if (entry.alpha > 0) entry.used = frame
      candidates.push(entry)
    }

    // Connections with a name of their own. Only a labelled edge is projected
    // at all: most carry no text, and a map may hold thousands of them.
    for (const edge of graph.edges.values()) {
      if (!edge.label) continue
      const from = graph.getNode(edge.from)
      const to = graph.getNode(edge.to)
      if (!from || !to) continue

      const key = `e:${edge.id}`
      let entry = entries.get(key)
      if (!entry) {
        entry = { id: edge.id, kind: 'edge', source: null, text: '', tier: EDGE, cluster: 0, width: 0, span: 1, cell: null, alpha: 0, placed: false, quad: 0, used: 0 }
        entries.set(key, entry)
      }
      entry.seen = frame
      seen++
      entry.visibility = 0

      const hovered = hoverKind === 'edge' && edge.id === hoverId
      if (entry.source !== edge.label || entry.rasterHovered !== hovered) {
        setText(entry, edge.label, EDGE, hovered)
      }
      if (!entry.text) continue

      const midX = (from.x + to.x) / 2
      const midY = (from.y + to.y) / 2
      const midZ = (from.z + to.z) / 2
      const depth = project(midX, midY, midZ, mid)
      if (!depth) continue
      // Both ends too: an end behind the camera means the line is being
      // clipped, and the direction the name would take is meaningless.
      const depthFrom = project(from.x, from.y, from.z, endA)
      const depthTo = project(to.x, to.y, to.z, endB)
      if (!depthFrom || !depthTo) continue

      let dirX = endB.x - endA.x
      let dirY = endB.y - endA.y
      const screenLength = Math.hypot(dirX, dirY)
      if (screenLength < 1) {
        // Seen end-on: both ends land on the same pixel and there is no
        // direction to set a name along. Under the crosshair it is wanted
        // anyway, so it is set level; otherwise there is no line to label.
        if (!hovered) continue
        dirX = 1
        dirY = 0
      } else {
        dirX /= screenLength
        dirY /= screenLength
      }
      // Never upside down: the name runs left to right, and a line straight up
      // the screen is read bottom-to-top, the way a chart sets a meridian.
      if (dirX < 0 || (dirX === 0 && dirY > 0)) {
        dirX = -dirX
        dirY = -dirY
      }

      const fromRadius = radiusOf(from.id)
      const toRadius = radiusOf(to.id)
      const distance = Math.hypot(midX - eye.x, midY - eye.y, midZ - eye.z)
      const range = edgeRevealRange(Math.max(fromRadius, toRadius) / baseRadius)
      const visibility = hovered ? 1 : smoothstep(range, range * (1 - REVEAL_FADE), distance)
      if (visibility <= 0) continue

      const fontPx = clamp((EDGE_HEIGHT * baseRadius * pxPerUnit) / depth, MIN_PX[EDGE], MAX_PX[EDGE])
      const scale = fontPx / FONT_PX
      const inkWidth = entry.width * scale
      const inkHeight = (ascent + descent) * scale
      // The run of line left between the two glows is all there is to write on
      // — except under the crosshair, where the name is wanted whether it fits
      // that run or not. A connection seen nearly end-on is a few px long
      // however far apart its ends really are, and a name that came and went
      // with the foreshortening would read as a fault rather than a rule.
      const glows = EDGE_END_CLEAR * ((fromRadius * pxPerUnit) / depthFrom + (toRadius * pxPerUnit) / depthTo)
      if (!hovered && screenLength - glows < inkWidth + 2 * EDGE_AIR_PX) continue

      entry.visibility = visibility
      entry.dim = hovered ? 1 : FAR_DIM + (1 - FAR_DIM) * smoothstep(MIN_PX[EDGE], DIM_FULL_PX, fontPx)
      entry.fontPx = fontPx
      entry.scale = scale
      entry.sx = mid.x
      entry.sy = mid.y
      entry.ax = midX
      entry.ay = midY
      entry.az = midZ
      entry.inkWidth = inkWidth
      entry.inkHeight = inkHeight
      entry.hovered = hovered
      entry.dirX = dirX
      entry.dirY = dirY
      // The upper side of the line, whichever way it runs: with the name's own
      // direction turned to dirX >= 0, this perpendicular always points up.
      entry.perpX = dirY
      entry.perpY = -dirX
      // No cluster hue: an edge takes none (see `clustering.js`), and a name in
      // one cluster's colour on a line between two clusters would be a lie.
      entry.cluster = 0
      // Under every star's name, so a contested spot goes to the star.
      entry.priority = (hovered ? 1e6 : 0) + EDGE_PRIORITY * (baseRadius / depth) * (entry.placed ? HOLD_BONUS : 1)
      if (entry.alpha > 0) entry.used = frame
      candidates.push(entry)
    }

    // Deleted nodes and edges, and edges whose label was cleared.
    if (entries.size > seen) {
      for (const [id, entry] of entries) {
        if (entry.seen === frame) continue
        release(entry)
        entries.delete(id)
      }
    }

    candidates.sort((a, b) => b.priority - a.priority)
    buckets.clear()
    let placed = 0
    for (const entry of candidates) {
      entry.placed = false
      entry.clean = false
      if (placed === MAX_LABELS) {
        layoutFor(entry)
        continue
      }
      // A connection's name has one place, on its own line. If it cannot sit
      // there it waits, rather than moving somewhere the line does not explain,
      // so the quadrant search below is handed nothing to try.
      if (entry.kind === 'edge') {
        const { rect } = setEdgeLayout(entry)
        if (rect.x1 > 0 && rect.x0 < width && rect.y1 > 0 && rect.y0 < height && !overlaps(rect)) {
          entry.placed = true
          // Clean means what it does for a star's name: whole on screen and
          // off every star, its own two ends included — a name lying over a
          // star reads as that star's, whichever line it is really on.
          entry.clean =
            rect.x0 >= 0 && rect.x1 <= width && rect.y0 >= 0 && rect.y1 <= height && starsUnder(rect, null) === 0
        }
      }
      // A star's label on screen keeps the quadrant it is in: if that one is
      // taken it fades out, and only once it has gone may it come back on
      // another side, so a name never jumps around its star.
      const options = entry.kind === 'edge' ? NO_QUADS : entry.alpha === 0 ? QUADS.map((_, i) => i) : [entry.quad]
      // A clean spot first: the whole name on screen and clear of every other
      // star, taking the quadrants in preference order.
      for (const option of options) {
        const { rect, lead } = setLayout(entry, option)
        if (rect.x0 < 0 || rect.x1 > width || rect.y0 < 0 || rect.y1 > height) continue
        if (overlaps(rect) || overlaps(lead)) continue
        if (starsUnder(rect, entry.id) > 0) continue
        entry.quad = option
        entry.placed = true
        entry.clean = true
        break
      }
      // Failing that, the least bad quadrant — fewest stars under the name,
      // and the name may hang off the edge. In a crowded field that beats
      // dropping it, which would leave the biggest star on screen anonymous.
      if (!entry.placed) {
        let best = -1
        let fewest = Infinity
        for (const option of options) {
          const { rect, lead } = setLayout(entry, option)
          if (rect.x1 <= 0 || rect.x0 >= width || rect.y1 <= 0 || rect.y0 >= height) continue
          if (overlaps(rect) || overlaps(lead)) continue
          const under = starsUnder(rect, entry.id)
          if (under >= fewest) continue
          fewest = under
          best = option
        }
        if (best >= 0) {
          setLayout(entry, best)
          entry.quad = best
          entry.placed = true
        }
      }
      if (!entry.placed) {
        layoutFor(entry)
        continue
      }
      if (!entry.cell && (pending.length === MAX_RASTERS_PER_FRAME || !allocate(entry))) {
        entry.placed = false
        continue
      }
      entry.used = frame
      occupy(entry.layout.rect)
      if (entry.layout.lead) occupy(entry.layout.lead)
      placed++
    }
    if (pending.length) flushRasters()

    for (const entry of candidates) {
      entry.alpha += ((entry.placed ? 1 : 0) - entry.alpha) * fade
      if (Math.abs((entry.placed ? 1 : 0) - entry.alpha) < 0.005) entry.alpha = entry.placed ? 1 : 0
    }

    // Lowest priority first, so where a fading label and its replacement
    // overlap, the one that won is drawn on top.
    drawn.length = 0
    let n = 0
    let leaders = 0
    for (let i = candidates.length - 1; i >= 0 && n < MAX_LABELS; i--) {
      const entry = candidates[i]
      entry.opacity = entry.alpha * entry.visibility * entry.dim
      if (entry.opacity < 0.004 || !entry.cell) continue

      const layout = entry.layout
      const edgeLabel = entry.kind === 'edge'
      const quadWidth = (entry.width + 2 * PAD_X) * entry.scale
      const quadHeight = CELL_H * entry.scale
      // From the projected anchor to the quad's centre, y up. A star's name is
      // boxed from its corner — the ink starts PAD_X in and (baseline - ascent)
      // down from the cell's — while a connection's is centred on its line
      // already, and the shader turns it about that centre.
      const centreX = edgeLabel ? layout.cx : layout.textX - PAD_X * entry.scale + quadWidth / 2
      const centreY = edgeLabel ? layout.cy : layout.textY - (baseline - ascent) * entry.scale + quadHeight / 2
      const ink = entry.hovered ? HOVER_INK : inkFor(entry.tier, entry.cluster)
      const c = centres.array
      c[n * 3] = entry.ax
      c[n * 3 + 1] = entry.ay
      c[n * 3 + 2] = entry.az
      const b = boxes.array
      b[n * 4] = centreX - entry.sx
      b[n * 4 + 1] = -(centreY - entry.sy)
      b[n * 4 + 2] = quadWidth
      b[n * 4 + 3] = quadHeight
      const t = turns.array
      t[n * 2] = edgeLabel ? entry.dirX : 1
      // The shader works in y-up pixels; dirY is y-down.
      t[n * 2 + 1] = edgeLabel ? -entry.dirY : 0
      const u = rects.array
      u[n * 4] = (entry.cell.col * CELL_W) / ATLAS_SIZE
      u[n * 4 + 1] = (entry.cell.row * CELL_H) / ATLAS_SIZE
      u[n * 4 + 2] = (entry.width + 2 * PAD_X) / ATLAS_SIZE
      u[n * 4 + 3] = CELL_H / ATLAS_SIZE
      const st = styles.array
      st[n * 4] = ink[0]
      st[n * 4 + 1] = ink[1]
      st[n * 4 + 2] = ink[2]
      st[n * 4 + 3] = entry.opacity
      n++

      // A connection's line is its own leader, so it draws none.
      const leaderAlpha = entry.opacity * (entry.hovered ? HOVER_LEADER_ALPHA : LEADER_ALPHA)
      for (const [ax, ay, bx, by] of edgeLabel
        ? []
        : [
            [layout.x0, layout.y0, layout.x1, layout.y1],
            [layout.x1, layout.y1, layout.x2, layout.y2],
          ]) {
        const lc = leaderCentres.array
        lc[leaders * 3] = entry.ax
        lc[leaders * 3 + 1] = entry.ay
        lc[leaders * 3 + 2] = entry.az
        const e = leaderEnds.array
        e[leaders * 4] = ax - entry.sx
        e[leaders * 4 + 1] = -(ay - entry.sy)
        e[leaders * 4 + 2] = bx - entry.sx
        e[leaders * 4 + 3] = -(by - entry.sy)
        const ls = leaderStyles.array
        ls[leaders * 4] = ink[0]
        ls[leaders * 4 + 1] = ink[1]
        ls[leaders * 4 + 2] = ink[2]
        ls[leaders * 4 + 3] = leaderAlpha
        leaders++
      }
      drawn.push(entry)
    }
    // Whatever was not a candidate this frame is off screen or out of range;
    // it comes back from nothing, which the fade-in covers.
    for (const entry of entries.values()) {
      if (entry.visibility === 0) {
        entry.alpha = 0
        entry.placed = false
      }
    }

    for (const [a, count] of [
      [centres, n],
      [boxes, n],
      [rects, n],
      [styles, n],
      [turns, n],
      [leaderCentres, leaders],
      [leaderEnds, leaders],
      [leaderStyles, leaders],
    ]) {
      a.clearUpdateRanges()
      a.addUpdateRange(0, count * a.itemSize)
      a.needsUpdate = true
    }
    geometry.instanceCount = n
    leaderGeometry.instanceCount = leaders
    mesh.visible = n > 0
    leaderMesh.visible = leaders > 0
  }

  /** Nothing drawn until the next `update` — for a view updated without a camera. */
  function hide() {
    mesh.visible = false
    leaderMesh.visible = false
    drawn.length = 0
  }

  /**
   * What is under the crosshair, as `{ kind: 'node' | 'edge', id }` or null.
   * Its label is shown whatever its range, in the hover colour.
   */
  function setHovered(target) {
    hoverKind = target?.kind ?? null
    hoverId = target?.id ?? null
  }

  /**
   * Forgets every label, for a graph replaced wholesale: a file reuses ids,
   * and a label mid-fade under a reused id should not carry over.
   */
  function reset() {
    entries.clear()
    occupied.fill(0)
    pending.length = 0
    hide()
  }

  function dispose() {
    parent.remove(mesh)
    parent.remove(leaderMesh)
    geometry.dispose()
    leaderGeometry.dispose()
    quad.dispose()
    material.dispose()
    leaderMesh.material.dispose()
    atlas.dispose()
  }

  return {
    update,
    hide,
    setHovered,
    reset,
    dispose,
    /**
     * Labels on screen after the last update: which kind it is, its id, text,
     * tier, opacity and the distance dimming inside it, font size, and whether
     * it found a clean spot (on screen and off every star).
     *
     * A star's name adds which way the callout turns, its leader's three
     * corners, and the ink's rect. A connection's adds the angle it is set at
     * (degrees, y down, so a line running down to the right is positive), the
     * ink's centre on screen, and the ink's own width and height — `x`/`y`
     * there are the corner of the box it reserves, which for a turned name is
     * larger than the ink. Lengths are CSS px, y down.
     */
    shown: () =>
      drawn.map((entry) => {
        const { id, kind, text, tier, cluster, opacity, dim, fontPx, clean, layout } = entry
        const common = { id, kind, text, tier: ['plain', 'landmark', 'core', 'edge'][tier], cluster, opacity, dim, fontPx, clean }
        if (kind === 'edge') {
          return {
            ...common,
            angle: (Math.atan2(entry.dirY, entry.dirX) * 180) / Math.PI,
            centre: [layout.cx, layout.cy],
            width: entry.inkWidth,
            height: entry.inkHeight,
            x: layout.rect.x0 + CLEARANCE_PX / 2,
            y: layout.rect.y0 + CLEARANCE_PX / 2,
          }
        }
        return {
          ...common,
          leader: [layout.x0, layout.y0, layout.x1, layout.y1, layout.x2, layout.y2],
          side: layout.qy > 0 ? 'below' : 'above',
          align: layout.qx > 0 ? 'right' : 'left',
          x: layout.rect.x0 + CLEARANCE_PX / 2,
          y: layout.rect.y0 + CLEARANCE_PX / 2,
          width: layout.rect.x1 - layout.rect.x0 - CLEARANCE_PX,
          height: layout.rect.y1 - layout.rect.y0 - CLEARANCE_PX,
        }
      }),
  }
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

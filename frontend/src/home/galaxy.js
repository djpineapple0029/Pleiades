/**
 * The homepage's hero: a small made-up map, turning slowly. Plain three, none
 * of the app's scene code (bloom, labels, physics), so the page stays light;
 * the colours are the app's cluster palette so it still looks like AtlasMap.
 *
 * `createGalaxy(canvas)` returns null when there's no WebGL, so the caller can
 * show the still picture instead.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from 'three'
import { CLUSTER_INKS, LATE_IDS } from '../palette.js'
import { seededRandom } from '../random.js'

const SEED = 0x5eed
const CLUSTERS = 6
const SKY_STARS = 1400
// The page background, so the canvas edge never shows.
const NIGHT = 0x070a16

/** Gaussian-ish offset: the sum of three uniforms, centred. */
const spread = (rand, size) => (rand() + rand() + rand() - 1.5) * size

/** Stars, links and cluster colours for the hero map. Pure, so it's testable. */
export function makeMap(seed = SEED) {
  const rand = seededRandom(seed)
  // Colour ids 1.. that aren't held back for late use: the hues a new map gets.
  const inks = CLUSTER_INKS.filter((_, i) => !LATE_IDS.has(i + 1))
  const stars = []
  const links = []
  const cores = []
  for (let c = 0; c < CLUSTERS; c++) {
    // Clusters on a loose, tilted ring, like a map someone's been adding to.
    const angle = (c / CLUSTERS) * Math.PI * 2 + rand() * 0.6
    const reach = 70 + rand() * 50
    const centre = [Math.cos(angle) * reach, spread(rand, 50), Math.sin(angle) * reach]
    const ink = inks[(c * 5 + 2) % inks.length]
    const first = stars.length
    cores.push(first)
    const count = 22 + Math.floor(rand() * 20)
    for (let i = 0; i < count; i++) {
      const core = i === 0
      stars.push({
        position: core
          ? centre
          : [centre[0] + spread(rand, 26), centre[1] + spread(rand, 26), centre[2] + spread(rand, 26)],
        ink,
        size: core ? 22 : 6 + rand() * 7,
      })
      // A tree inside each cluster: every star hangs off one nearer the core.
      if (!core) links.push([first + Math.floor(rand() * Math.min(i, 6)), first + i])
    }
  }
  // Clusters join through their cores, round the ring.
  cores.forEach((core, c) => links.push([core, cores[(c + 1) % cores.length]]))
  // A few loose stars with no cluster: those are pale blue-white in the app.
  for (let i = 0; i < 14; i++) {
    stars.push({
      position: [spread(rand, 260), spread(rand, 120), spread(rand, 260)],
      ink: [0.8, 0.86, 1],
      size: 3,
    })
  }
  return { stars, links }
}

const STAR_VERTEX = /* glsl */ `
  attribute float size;
  attribute float phase;
  attribute vec3 ink;
  uniform float time;
  uniform float scale;
  varying vec3 vInk;
  varying float vTwinkle;
  void main() {
    vInk = ink;
    vTwinkle = 0.85 + 0.15 * sin(time * 1.3 + phase);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const STAR_FRAGMENT = /* glsl */ `
  varying vec3 vInk;
  varying float vTwinkle;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float halo = exp(-d * d * 7.0) * 0.55;
    float core = smoothstep(0.26, 0.0, d);
    vec3 colour = mix(vInk, vec3(1.0), core * 0.7);
    gl_FragColor = vec4(colour * (halo + core) * vTwinkle, 1.0);
  }
`

function starPoints(stars, rand) {
  const n = stars.length
  const position = new Float32Array(n * 3)
  const ink = new Float32Array(n * 3)
  const size = new Float32Array(n)
  const phase = new Float32Array(n)
  stars.forEach((star, i) => {
    position.set(star.position, i * 3)
    // sRGB as is: a raw ShaderMaterial writes straight to the sRGB canvas.
    ink.set(star.ink, i * 3)
    size[i] = star.size
    phase[i] = rand() * Math.PI * 2
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  geometry.setAttribute('ink', new BufferAttribute(ink, 3))
  geometry.setAttribute('size', new BufferAttribute(size, 1))
  geometry.setAttribute('phase', new BufferAttribute(phase, 1))
  const material = new ShaderMaterial({
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    uniforms: { time: { value: 0 }, scale: { value: 1 } },
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  })
  return new Points(geometry, material)
}

function linkLines(stars, links) {
  const position = new Float32Array(links.length * 6)
  const colour = new Float32Array(links.length * 6)
  const c = new Color()
  links.forEach(([a, b], i) => {
    for (const [k, index] of [a, b].entries()) {
      position.set(stars[index].position, i * 6 + k * 3)
      c.setRGB(...stars[index].ink, 'srgb')
      colour.set([c.r, c.g, c.b], i * 6 + k * 3)
    }
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  geometry.setAttribute('color', new BufferAttribute(colour, 3))
  const material = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.22,
    blending: AdditiveBlending,
    depthWrite: false,
  })
  return new LineSegments(geometry, material)
}

function skyStars(rand) {
  const stars = []
  for (let i = 0; i < SKY_STARS; i++) {
    // Evenly over a far sphere.
    const u = rand() * 2 - 1
    const t = rand() * Math.PI * 2
    const r = 900 + rand() * 300
    const s = Math.sqrt(1 - u * u)
    const grey = 0.5 + rand() * 0.4
    stars.push({
      position: [s * Math.cos(t) * r, u * r, s * Math.sin(t) * r],
      ink: [grey, grey, grey + 0.08],
      size: 6 + rand() * 10,
    })
  }
  return starPoints(stars, rand)
}

export function createGalaxy(canvas, { still = false } = {}) {
  let renderer
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' })
  } catch {
    return null
  }
  renderer.setClearColor(NIGHT, 1)
  const scene = new Scene()
  const camera = new PerspectiveCamera(55, 1, 1, 3000)
  const rand = seededRandom(SEED + 1)
  const { stars, links } = makeMap()

  const map = new Group()
  const points = starPoints(stars, rand)
  map.add(linkLines(stars, links), points)
  map.rotation.x = 0.35
  const spin = new Group()
  spin.add(map)
  const sky = skyStars(rand)
  scene.add(sky, spin)

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 }
  let running = false
  let visible = true
  let frame = 0
  let last = 0
  let elapsed = 0

  function resize() {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    // Portrait screens: step back so the map still fits across, and lift it
    // into the empty sky above the words. Wide ones: move it right of them.
    const distance = camera.aspect < 1 ? 330 / Math.max(camera.aspect, 0.45) : 390
    camera.position.set(0, 60, distance)
    camera.lookAt(0, 0, 0)
    if (camera.aspect < 1) camera.setViewOffset(width, height, 0, height * 0.24, width, height)
    else if (camera.aspect > 1.2) camera.setViewOffset(width, height, -width * 0.25, 0, width, height)
    else camera.clearViewOffset()
    camera.updateProjectionMatrix()
    const scale = renderer.getPixelRatio() * height * 0.9
    points.material.uniforms.scale.value = scale
    sky.material.uniforms.scale.value = scale
    draw()
  }

  function draw() {
    spin.rotation.y = elapsed * 0.035
    points.material.uniforms.time.value = elapsed
    pointer.x += (pointer.tx - pointer.x) * 0.04
    pointer.y += (pointer.ty - pointer.y) * 0.04
    // A little parallax: the map leans away from the pointer.
    map.rotation.z = pointer.x * 0.06
    map.rotation.x = 0.35 + pointer.y * 0.05
    sky.rotation.y = elapsed * 0.004 + pointer.x * 0.02
    renderer.render(scene, camera)
  }

  function tick(now) {
    frame = requestAnimationFrame(tick)
    // Capped, so coming back to the tab doesn't jump the map round.
    elapsed += Math.min((now - (last || now)) / 1000, 0.1)
    last = now
    draw()
  }

  function update() {
    const should = !still && visible && document.visibilityState === 'visible'
    if (should === running) return
    running = should
    if (running) {
      last = 0
      frame = requestAnimationFrame(tick)
    } else cancelAnimationFrame(frame)
  }

  new ResizeObserver(resize).observe(canvas)
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    update()
  }).observe(canvas)
  document.addEventListener('visibilitychange', update)
  if (!still) {
    window.addEventListener('pointermove', (event) => {
      pointer.tx = (event.clientX / window.innerWidth) * 2 - 1
      pointer.ty = (event.clientY / window.innerHeight) * 2 - 1
    })
  }
  resize()
  update()
  return { stars, links }
}

/** A still star field for browsers without WebGL, drawn from the same map. */
export function drawStill(svg) {
  const { stars, links } = makeMap()
  const ns = 'http://www.w3.org/2000/svg'
  // Straight down the y axis, tilted a little, fitted to the 800×600 viewBox.
  const project = ([x, y, z]) => [400 + x * 1.3, 300 + z * 0.9 - y * 0.4]
  const hex = (ink) => `rgb(${ink.map((v) => Math.round(v * 255)).join(' ')})`
  for (const [a, b] of links) {
    const [x1, y1] = project(stars[a].position)
    const [x2, y2] = project(stars[b].position)
    const line = document.createElementNS(ns, 'line')
    Object.entries({ x1, y1, x2, y2, stroke: hex(stars[a].ink), 'stroke-opacity': 0.25 }).forEach(([k, v]) =>
      line.setAttribute(k, v),
    )
    svg.append(line)
  }
  for (const star of stars) {
    const [cx, cy] = project(star.position)
    const dot = document.createElementNS(ns, 'circle')
    Object.entries({ cx, cy, r: star.size / 4, fill: hex(star.ink) }).forEach(([k, v]) =>
      dot.setAttribute(k, v),
    )
    svg.append(dot)
  }
}

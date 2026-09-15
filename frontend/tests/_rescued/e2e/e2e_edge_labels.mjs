/**
 * Session 11: connection labels, against the real modules.
 * Deterministic SwiftShader. Covers riding the line (angle, offset, never
 * upside down), the reveal rule, hover, the room-along-the-line gate,
 * declutter against star names, text edits, and the draw.
 */
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5180'
let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))
const within = (a, b, tol) => Math.abs(a - b) <= tol

const browser = await chromium.launch({
  executablePath:
    '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('ReadPixels')) errors.push(`${m.type()}: ${m.text()}`)
})
await page.goto(`${BASE}/`)
await page.waitForTimeout(1500)

const r = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView, NODE_RADIUS } = await import('/src/graphView.js')
  const { createBloom, LABEL_LAYER } = await import('/src/bloom.js')
  const { edgeRevealRange } = await import('/src/labels.js')
  document.getElementById('viewport').remove()
  await document.fonts.ready

  const W = 640
  const H = 480
  const canvas = document.createElement('canvas')
  canvas.style.cssText = `width:${W}px;height:${H}px`
  document.body.append(canvas)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(1)
  renderer.setSize(W, H, false)
  renderer.setClearColor(0x000000)
  const gl = renderer.getContext()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000)
  scene.add(camera)
  const graph = createGraph()
  const view = createGraphView(graph, scene, renderer)
  const bloom = createBloom(renderer, scene, camera)
  const names = () => scene.getObjectByName('labels')
  const leaders = () => scene.getObjectByName('labelLeaders')
  const out = {}

  const read = () => {
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    return buf
  }
  // The names alone, onto black, with the leader lines left out: a lit pixel
  // is a glyph and nothing else.
  const nameFrame = () => {
    const was = leaders().visible
    leaders().visible = false
    camera.layers.set(LABEL_LAYER)
    renderer.setRenderTarget(null)
    renderer.render(scene, camera)
    camera.layers.set(0)
    leaders().visible = was
    return read()
  }
  const at = (buf, x, y) => {
    const i = (y * W + x) * 4
    return [buf[i], buf[i + 1], buf[i + 2]]
  }
  // Bounding box of lit pixels in CSS px, y down.
  const litBox = (buf, min = 24) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [rr, gg, bb] = at(buf, x, y)
        if (rr + gg + bb < min) continue
        n++
        const cy = H - 1 - y
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy)
      }
    }
    return n ? { x0, y0, x1: x1 + 1, y1: y1 + 1, n } : null
  }

  let clock = 10
  const run = (frames = 30, dt = 0.05) => {
    for (let i = 0; i < frames; i++) {
      clock += dt
      view.update(clock, camera)
    }
  }
  const lookAt = (px, py, pz, tx, ty, tz) => {
    camera.position.set(px, py, pz)
    camera.up.set(0, 1, 0)
    camera.lookAt(tx, ty, tz)
    camera.updateMatrixWorld(true)
  }
  // `stars` names the two nodes; blank them to leave the connection's name the
  // only thing on the label layer, which is what the pixel tests need.
  const pair = (ax, ay, az, bx, by, bz, label = 'depends on', stars = ['Alpha', 'Beta']) => {
    graph.load({
      nodes: [
        { id: 'n1', label: stars[0], notes: '', links: [], x: ax, y: ay, z: az, cluster_color_id: 0, is_core: false },
        { id: 'n2', label: stars[1], notes: '', links: [], x: bx, y: by, z: bz, cluster_color_id: 0, is_core: false },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', directed: false, label }],
    })
    view.sync()
    view.setHover(null)
  }
  const edges = () => view.labelsShown().filter((l) => l.kind === 'edge')
  const one = () => edges()[0] ?? null

  // --- Rides its line ---------------------------------------------------------
  pair(-100, 0, 0, 100, 0, 0)
  lookAt(0, 0, 150, 0, 0, 0)
  run()
  const flat = one()
  out.flat = flat && { angle: flat.angle, centre: flat.centre, text: flat.text, tier: flat.tier, kind: flat.kind }
  // The midpoint projects to the centre of the screen; the ink sits above it.
  out.flatAboveLine = flat ? flat.centre[0] === W / 2 && flat.centre[1] < H / 2 && H / 2 - flat.centre[1] < 25 : false

  pair(100, 0, 0, -100, 0, 0)
  lookAt(0, 0, 150, 0, 0, 0)
  run()
  out.reversedAngle = one()?.angle ?? null

  pair(-100, -100, 0, 100, 100, 0)
  lookAt(0, 0, 150, 0, 0, 0)
  run()
  out.upRightAngle = one()?.angle ?? null

  pair(-100, 100, 0, 100, -100, 0)
  lookAt(0, 0, 150, 0, 0, 0)
  run()
  out.downRightAngle = one()?.angle ?? null

  pair(0, -100, 0, 0, 100, 0)
  lookAt(0, 0, 150, 0, 0, 0)
  run()
  out.verticalAngle = one()?.angle ?? null

  // --- The ink really is turned -----------------------------------------------
  // A level name is far wider than tall; a 45 degree one is nearly square.
  pair(-100, 0, 0, 100, 0, 0, 'connects to', ['', ''])
  lookAt(0, 0, 120, 0, 0, 0)
  run()
  const levelShown = one()
  const levelBox = litBox(nameFrame())
  pair(-100, -100, 0, 100, 100, 0, 'connects to', ['', ''])
  lookAt(0, 0, 120, 0, 0, 0)
  run()
  const turnedBox = litBox(nameFrame())
  out.boxes = {
    level: levelBox && { w: levelBox.x1 - levelBox.x0, h: levelBox.y1 - levelBox.y0 },
    turned: turnedBox && { w: turnedBox.x1 - turnedBox.x0, h: turnedBox.y1 - turnedBox.y0 },
  }
  // Every glyph pixel inside the box the entry reports it reserves.
  out.inkInsideRect = levelShown && levelBox
    ? levelBox.x0 >= levelShown.x - 2 &&
      levelBox.x1 <= levelShown.x + levelShown.width + 3 &&
      levelBox.y0 >= levelShown.y - 2 &&
      levelBox.y1 <= levelShown.y + levelShown.height + 3
    : false
  out.inkReported = levelShown && { x: levelShown.x, y: levelShown.y, w: levelShown.width, h: levelShown.height }

  // --- Reveal ------------------------------------------------------------------
  pair(-100, 0, 0, 100, 0, 0)
  out.range = { plain: edgeRevealRange(1.15), core: edgeRevealRange(3) }
  out.overRange = []
  for (const d of [100, 150, 200, 260]) {
    lookAt(0, 0, d, 0, 0, 0)
    run()
    out.overRange.push({ d, shown: edges().length })
  }
  // A core at one end carries its connections much further out.
  graph.load({
    nodes: [
      { id: 'n1', label: 'Alpha', notes: '', links: [], x: -100, y: 0, z: 0, cluster_color_id: 0, is_core: true },
      { id: 'n2', label: 'Beta', notes: '', links: [], x: 100, y: 0, z: 0, cluster_color_id: 0, is_core: false },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', directed: false, label: 'depends on' }],
  })
  view.sync()
  view.setHover(null)
  lookAt(0, 0, 700, 0, 0, 0)
  run(60)
  out.coreCarries = edges().length

  // --- Hover -------------------------------------------------------------------
  pair(-100, 0, 0, 100, 0, 0)
  lookAt(0, 0, 900, 0, 0, 0)
  run()
  out.farGone = edges().length === 0
  view.setHover({ kind: 'edge', id: 'e1' })
  run()
  const hovered = one()
  out.hovered = hovered && { opacity: hovered.opacity, dim: hovered.dim }
  view.setHover(null)
  run()
  out.hoverCleared = edges().length === 0

  // Seen end-on there is no line to write along, but the crosshair still names it.
  pair(0, 0, -100, 0, 0, 100)
  lookAt(0, 0, 260, 0, 0, 0)
  run()
  out.endOnGone = edges().length === 0
  view.setHover({ kind: 'edge', id: 'e1' })
  run()
  out.endOnHovered = edges().length === 1 && one().angle === 0
  view.setHover(null)

  // A connection too short on screen to write on drops its name.
  pair(-8, 0, 0, 8, 0, 0)
  lookAt(0, 0, 60, 0, 0, 0)
  run()
  out.tooShort = edges().length === 0

  // --- Text --------------------------------------------------------------------
  pair(-100, 0, 0, 100, 0, 0)
  lookAt(0, 0, 120, 0, 0, 0)
  run()
  const before = one()?.width ?? 0
  graph.getEdge('e1').label = 'a considerably longer relationship'
  run(2)
  const after = one()
  out.editShows = after?.text === 'a considerably longer relationship' && after.width > before
  graph.getEdge('e1').label = '  spaced   out  '
  run(2)
  out.collapsed = one()?.text ?? null
  graph.getEdge('e1').label = 'x'.repeat(400)
  run(2)
  out.truncated = (one()?.text ?? '').endsWith('…')
  graph.getEdge('e1').label = ''
  run(2)
  out.clearedGone = edges().length === 0
  graph.getEdge('e1').label = 'depends on'
  run(2)
  graph.removeEdge('e1')
  view.syncEdges()
  run(2)
  out.deletedGone = edges().length === 0

  // A file reusing an edge id must not inherit the old name mid-fade.
  pair(-100, 0, 0, 100, 0, 0, 'first name')
  lookAt(0, 0, 120, 0, 0, 0)
  run()
  pair(-100, 0, 0, 100, 0, 0, 'second name')
  run(2)
  const reloaded = one()
  out.loadFadesIn = reloaded?.text === 'second name' && reloaded.opacity < 0.9

  // --- Against star names -------------------------------------------------------
  // A star's name wins a contested spot; the connection's waits.
  const overlapping = []
  graph.load({
    nodes: [
      { id: 'n1', label: 'Alpha', notes: '', links: [], x: -60, y: 0, z: 0, cluster_color_id: 0, is_core: false },
      { id: 'n2', label: 'Beta', notes: '', links: [], x: 60, y: 0, z: 0, cluster_color_id: 0, is_core: false },
      { id: 'n3', label: 'Gamma', notes: '', links: [], x: 0, y: -14, z: 0, cluster_color_id: 0, is_core: false },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', directed: false, label: 'depends on' }],
  })
  view.sync()
  view.setHover(null)
  lookAt(0, 0, 150, 0, 0, 0)
  run()
  const all = view.labelsShown()
  for (const a of all) {
    for (const b of all) {
      if (a === b) continue
      const ar = { x0: a.x, y0: a.y, x1: a.x + (a.width ?? 0), y1: a.y + (a.height ?? 0) }
      const br = { x0: b.x, y0: b.y, x1: b.x + (b.width ?? 0), y1: b.y + (b.height ?? 0) }
      if (ar.x0 < br.x1 && br.x0 < ar.x1 && ar.y0 < br.y1 && br.y0 < ar.y1) overlapping.push([a.id, b.id])
    }
  }
  out.contested = { stars: all.filter((l) => l.kind === 'node').length, overlapping: overlapping.length }

  // --- The draw ------------------------------------------------------------------
  pair(-100, 0, 0, 100, 0, 0)
  lookAt(0, 0, 120, 0, 0, 0)
  run()
  const withEdge = { names: names().geometry.instanceCount, leaders: leaders().geometry.instanceCount }
  graph.getEdge('e1').label = ''
  run(30)
  const withoutEdge = { names: names().geometry.instanceCount, leaders: leaders().geometry.instanceCount }
  out.draw = { withEdge, withoutEdge }
  // A connection's name adds an instance but no leader: its line is its leader.
  out.noLeader = withEdge.names === withoutEdge.names + 1 && withEdge.leaders === withoutEdge.leaders

  graph.getEdge('e1').label = 'depends on'
  run(2)
  let nameDraws = 0
  let leaderDraws = 0
  names().onBeforeRender = () => { nameDraws++ }
  leaders().onBeforeRender = () => { leaderDraws++ }
  bloom.render()
  names().onBeforeRender = () => {}
  leaders().onBeforeRender = () => {}
  out.drawsPerFrame = [nameDraws, leaderDraws]
  // The label layer on its own: the names and their leaders, and nothing else.
  camera.layers.set(LABEL_LAYER)
  renderer.setRenderTarget(null)
  renderer.render(scene, camera)
  camera.layers.set(0)
  out.labelCalls = renderer.info.render.calls

  // --- Cost -------------------------------------------------------------------
  const nodes = []
  const edgeList = []
  let s = 3
  const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32
  for (let i = 0; i < 600; i++) {
    nodes.push({ id: `n${i}`, label: `node ${i}`, notes: '', links: [], x: (rand() - 0.5) * 900, y: (rand() - 0.5) * 900, z: (rand() - 0.5) * 900, cluster_color_id: 0, is_core: false })
  }
  for (let i = 1; i < 600; i++) {
    edgeList.push({ id: `e${i}`, from: `n${i}`, to: `n${Math.floor(rand() * i)}`, directed: false, label: `link ${i}` })
  }
  graph.load({ nodes, edges: edgeList })
  view.sync()
  lookAt(0, 0, 700, 0, 0, 0)
  run(10)
  const t0 = performance.now()
  for (let i = 0; i < 30; i++) { clock += 0.016; view.update(clock, camera) }
  out.cost600 = (performance.now() - t0) / 30
  out.cost600Shown = edges().length

  out.NODE_RADIUS = NODE_RADIUS
  return out
})

console.log(JSON.stringify(r, null, 1))
check('a connection name rides its line: level line, level name, centred on the midpoint', r.flat?.angle === 0 && r.flat?.kind === 'edge' && r.flat?.tier === 'edge' && r.flat?.text === 'depends on', JSON.stringify(r.flat))
check('the name sits just off the line, on its upper side', r.flatAboveLine, JSON.stringify(r.flat?.centre))
check('never upside down: the same line drawn the other way reads the same', r.reversedAngle === 0, r.reversedAngle)
check('turned to the line: -45 up to the right, +45 down to the right', within(r.upRightAngle, -45, 1e-6) && within(r.downRightAngle, 45, 1e-6), JSON.stringify([r.upRightAngle, r.downRightAngle]))
check('a line straight up the screen is read bottom-to-top', r.verticalAngle === -90, r.verticalAngle)
check('the ink itself is turned: level is wide and flat, 45 degrees is nearly square', r.boxes.level && r.boxes.turned && r.boxes.level.w / r.boxes.level.h > 3 && within(r.boxes.turned.w / r.boxes.turned.h, 1, 0.45), JSON.stringify(r.boxes))
check('glyph pixels fall inside the box the entry reserves', r.inkInsideRect, JSON.stringify([r.boxes.level, r.inkReported]))
check('revealed within range and gone past it (185u for a plain pair)', r.overRange[0].shown === 1 && r.overRange[1].shown === 1 && r.overRange[3].shown === 0, JSON.stringify(r.overRange))
check('a core at one end carries its connection names much further out', r.range.core > r.range.plain * 6 && r.coreCarries === 1, JSON.stringify([r.range, r.coreCarries]))
check('out of range: nothing; under the crosshair: shown, undimmed', r.farGone && r.hovered?.opacity === 1 && r.hovered?.dim === 1, JSON.stringify([r.farGone, r.hovered]))
check('hover cleared: the out-of-range name goes again', r.hoverCleared)
check('seen end-on there is no line to write along; the crosshair still names it, level', r.endOnGone && r.endOnHovered, JSON.stringify([r.endOnGone, r.endOnHovered]))
check('a connection too short on screen to hold its name drops it', r.tooShort)
check('an edited name shows next frame, wider, with no view call', r.editShows)
check('whitespace collapsed to one line', r.collapsed === 'spaced out', r.collapsed)
check('a long name is cut with an ellipsis', r.truncated)
check('a cleared name and a deleted edge both draw nothing', r.clearedGone && r.deletedGone, JSON.stringify([r.clearedGone, r.deletedGone]))
check('a file reusing an edge id gets the new name, fading in from nothing', r.loadFadesIn)
check('no label overlaps another, stars and connections together', r.contested.overlapping === 0 && r.contested.stars >= 2, JSON.stringify(r.contested))
check('a connection name draws one instance and no leader: its line is the leader', r.noLeader, JSON.stringify(r.draw))
check('names and leaders draw once each a frame; two calls on the label layer', JSON.stringify(r.drawsPerFrame) === '[1,1]' && r.labelCalls === 2, JSON.stringify([r.drawsPerFrame, r.labelCalls]))
check('600 labelled edges: update < 2 ms/frame', r.cost600 < 2, JSON.stringify([r.cost600, r.cost600Shown]))
check('no console errors or warnings', errors.length === 0, JSON.stringify(errors))
console.log(`\n${ok} passed, ${fails} failed`)
await browser.close()
process.exit(fails ? 1 : 0)

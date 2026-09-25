// Ported from tests/_rescued/e2e/e2e_labels.mjs (session 9).
//
// The redesigned node labels, against the real modules. Covers the reveal
// rule, the three tiers, size and dimming with distance, the callout and
// its leader, keeping off other stars, declutter, hover, edits/deletes/
// loads, the atlas, and the draw.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, threeModuleUrl } from '../helpers/gestures.js'

test('node labels: reveal, tiers, callout, declutter, hover, edits', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  const threeUrl = await threeModuleUrl(page)

  const r = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView, NODE_RADIUS } = await import('/src/graphView.js')
    const { createBloom, STAR_LAYER, LABEL_LAYER } = await import('/src/bloom.js')
    const { revealRange, ALWAYS_ON_SIZE } = await import('/src/labels.js')
    document.getElementById('viewport').remove()
    // The atlas is rasterised on a canvas, which falls back silently: every
    // width here assumes the real face is in.
    await document.fonts.ready

    let W = 640, H = 480
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
    const mesh = () => scene.getObjectByName('labels')
    const leaders = () => scene.getObjectByName('labelLeaders')
    const out = {}

    let dw = W, dh = H // drawing buffer
    const read = () => {
      const buf = new Uint8Array(dw * dh * 4)
      gl.readPixels(0, 0, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      return buf
    }
    // Labels alone, onto black; `names` leaves the leader lines out, so a lit
    // box is the glyphs and nothing else.
    const labelFrame = (names = false) => {
      const was = leaders().visible
      if (names) leaders().visible = false
      camera.layers.set(LABEL_LAYER)
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      camera.layers.set(0)
      leaders().visible = was
      return read()
    }
    const at = (buf, x, y) => { const i = (y * dw + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]] }
    // Bounding box of lit pixels in CSS px, y down.
    const litBox = (buf, min = 24, ratio = 1) => {
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0
      for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const [r, g, b] = at(buf, x, y)
        if (r + g + b < min) continue
        n++
        const cy = dh - 1 - y
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy)
      }
      return n ? { x0: x0 / ratio, y0: y0 / ratio, x1: (x1 + 1) / ratio, y1: (y1 + 1) / ratio, n } : null
    }
    const lookAt = (px, py, pz, tx, ty, tz) => {
      camera.position.set(px, py, pz); camera.up.set(0, 1, 0); camera.lookAt(tx, ty, tz); camera.updateMatrixWorld(true)
    }
    let clock = 10
    const run = (frames = 1, dt = 0.05) => { for (let i = 0; i < frames; i++) { clock += dt; view.update(clock, camera) } }
    const shown = () => view.labelsShown()
    const shownOf = (id) => shown().find((l) => l.id === id) ?? null
    const reset = () => { graph.load({ nodes: [], edges: [] }); view.sync(); view.setHover(null); run(1) }
    const screenOf = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(camera)
      return [(v.x * 0.5 + 0.5) * W, (0.5 - v.y * 0.5) * H]
    }
    const pxPerUnit = () => 0.5 * H * camera.projectionMatrix.elements[5]
    const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }
    const scratch = new THREE.Vector3()
    // Every star on screen as a disc, the way the layout sees them.
    const discs = () => [...graph.nodes.values()].map((n) => {
      scratch.set(n.x, n.y, n.z).applyMatrix4(camera.matrixWorldInverse)
      const [x, y] = screenOf(n.x, n.y, n.z)
      return { id: n.id, x, y, r: (view.radiusOf(n.id) * pxPerUnit()) / -scratch.z }
    })
    const hits = (l, disc) => {
      const nx = Math.min(Math.max(disc.x, l.x), l.x + l.width)
      const ny = Math.min(Math.max(disc.y, l.y), l.y + l.height)
      return (nx - disc.x) ** 2 + (ny - disc.y) ** 2 < disc.r ** 2
    }

    // --- Structure ---------------------------------------------------------------
    out.layerOnly = mesh().layers.mask === 1 << LABEL_LAYER && leaders().layers.mask === 1 << LABEL_LAYER
    out.hiddenEmpty = mesh().visible === false && leaders().visible === false
    out.rule = [1, 1.15, 1.3, 1.6, 1.99, 2, 3].map((s) => revealRange(s))
    out.alwaysOn = ALWAYS_ON_SIZE

    // --- Unlabelled nodes draw nothing; a labelled one draws beside its star ------
    const blank = graph.addNode({ x: -40, y: 0, z: 0 })
    const named = graph.addNode({ x: 0, y: 0, z: 0, label: 'Project Atlas' })
    view.sync()
    lookAt(0, 0, 90, 0, 0, 0)
    run(20)
    out.onlyNamed = shown().map((l) => l.id).join() === named.id
    const rep = shownOf(named.id)
    out.named = rep && { tier: rep.tier, clean: rep.clean, opacity: +rep.opacity.toFixed(3), dim: +rep.dim.toFixed(3), fontPx: +rep.fontPx.toFixed(2) }
    // Full strength but for the distance dimming.
    out.namedFull = rep && Math.abs(rep.opacity / rep.dim - 1) < 1e-6
    const box = litBox(labelFrame(true))
    out.box = box && { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 }
    out.rect = rep && { x: +rep.x.toFixed(1), y: +rep.y.toFixed(1), w: +rep.width.toFixed(1), h: +rep.height.toFixed(1) }
    const [cx, cy] = screenOf(0, 0, 0)
    const rPx = (NODE_RADIUS * pxPerUnit()) / 90
    // The callout: a leader out of the star at 45 degrees, a level shelf, then
    // the name. It starts 1.5 drawn radii + 3 px out, clear of the hover ring.
    const lead = rep.leader
    out.callout = {
      start: +Math.hypot(lead[0] - cx, lead[1] - cy).toFixed(1),
      startWant: +(1.5 * rPx + 3).toFixed(1),
      diagonal: +Math.abs((lead[3] - lead[1]) / (lead[2] - lead[0])).toFixed(3), // 45 degrees
      shelfLevel: lead[5] === lead[3],
      textAfterShelf: +(rep.x - lead[4]).toFixed(1),
      side: rep.side,
      align: rep.align,
      // The name's middle sits on the shelf.
      centred: +Math.abs(rep.y + rep.height / 2 - lead[5]).toFixed(2),
    }
    // Nothing in the canvas pass or the star pass.
    renderer.setRenderTarget(null); renderer.render(scene, camera)
    out.layer0Empty = litBox(read()) === null

    // --- Reveal: a base node shows within 200 units, fading in from 200 to 150 ----
    reset()
    const lone = graph.addNode({ x: 0, y: 0, z: 0, label: 'far away' })
    view.sync()
    out.reveal = [120, 160, 175, 190, 199, 205, 300].map((d) => {
      lookAt(0, 0, d, 0, 0, 0); run(20)
      const l = shownOf(lone.id)
      return { d, got: +((l ? l.opacity / l.dim : 0)).toFixed(3), want: +smooth(200, 150, d).toFixed(3) }
    })
    let firstSeen = null
    for (let d = 400; d >= 60; d -= 5) { lookAt(0, 0, d, 0, 0, 0); run(1, 0.016); if (firstSeen === null && shownOf(lone.id)) firstSeen = d }
    out.firstSeen = firstSeen
    // One link: still 1x, so the same range as a lone node — a link no longer
    // carries the name further.
    const friend = graph.addNode({ x: 3000, y: 0, z: 0, label: 'friend' })
    graph.addEdge(lone.id, friend.id)
    run(20)
    out.oneLink = [140, 180, 220].map((d) => {
      lookAt(0, 0, d, 0, 0, 0); run(20)
      const l = shownOf(lone.id)
      return +((l ? l.opacity / l.dim : 0)).toFixed(3)
    })

    // --- Too close: flying through the star, the label goes ----------------------
    lookAt(0, 0, 1.2 * view.radiusOf(lone.id), 0, 0, 0); run(20)
    out.tooClose = shownOf(lone.id) === null
    lookAt(0, 0, 100, 0, 0, 200); run(20)
    out.behind = shownOf(lone.id) === null

    // --- Size and strength follow distance ----------------------------------------
    // The point of the redesign: a near name is far bigger than a far one, so
    // size alone pairs a name to its star in a crowd. A core is always on, so
    // one star can be sampled the whole way out.
    reset()
    const zoom = graph.addNode({ x: 0, y: 0, z: 0, label: 'Deep field' })
    graph.setCore(zoom.id, true)
    view.sync()
    run(40)
    out.sizes = [90, 130, 180, 240, 320, 900, 4000].map((d) => {
      lookAt(0, 0, d, 0, 0, 0); run(30)
      const l = shownOf(zoom.id)
      return { d, px: +l.fontPx.toFixed(2), dim: +l.dim.toFixed(3) }
    })
    // Two stars side by side at different depths: the nearer name is bigger.
    reset()
    const front = graph.addNode({ x: 0, y: 0, z: 0, label: 'in front' })
    const back = graph.addNode({ x: 300, y: 0, z: -900, label: 'behind' })
    for (const id of [front.id, back.id]) graph.setCore(id, true)
    view.sync()
    // 110 rather than 150: a core is 2.25x now, not 3x, so its name at 150 is
    // a size smaller than it was.
    lookAt(0, 0, 110, 0, 0, 0); run(40)
    out.depthPair = [shownOf(front.id)?.fontPx, shownOf(back.id)?.fontPx].map((v) => (v ? +v.toFixed(2) : null))

    // --- Tiers: a core in capitals, the rest as typed ------------------------------
    // A core's neighbour used to be a landmark (it grew to 2.24x); with only
    // cores bigger than 1x it is plain like everything else.
    reset()
    // Well inside the plain node's 200-unit reveal range, and spread out so
    // three callouts all have room.
    const tiers = []
    const spots = [[-80, 40], [0, -40], [80, 40]]
    for (let i = 0; i < 3; i++) {
      tiers.push(graph.addNode({ x: spots[i][0], y: spots[i][1], z: 0, label: ['Core node', 'Hop one', 'Alone'][i] }).id)
    }
    graph.addEdge(tiers[0], tiers[1])
    graph.setCore(tiers[0], true)
    view.sync()
    lookAt(0, 0, 130, 0, 0, 0); run(40)
    out.tiers = tiers.map((id) => {
      const l = shownOf(id)
      return l && { tier: l.tier, text: l.text }
    })

    // --- The callout follows the star's eased radius ------------------------------
    reset()
    const grow = graph.addNode({ x: 0, y: 0, z: 0, label: 'grows' })
    view.sync()
    lookAt(0, 0, 140, 0, 0, 0)
    graph.setCore(grow.id, true)
    run(40)
    const [gx, gy] = screenOf(0, 0, 0)
    const startOf = (id) => { const l = shownOf(id); return +Math.hypot(l.leader[0] - gx, l.leader[1] - gy).toFixed(1) }
    const grownR = (view.radiusOf(grow.id) * pxPerUnit()) / 140
    out.coreStart = startOf(grow.id)
    out.coreStartWant = +(1.5 * grownR + 3).toFixed(1)
    graph.setCore(grow.id, false)
    run(2)
    out.coreStartEasing = startOf(grow.id)
    run(40)
    out.coreStartAfter = startOf(grow.id)

    // --- Stacked stars: the callouts turn to different sides -----------------------
    reset()
    const near2 = graph.addNode({ x: 0, y: 0, z: 0, label: 'nearer' })
    const behind = graph.addNode({ x: 0, y: 0, z: -30, label: 'behind it' })
    view.sync()
    lookAt(0, 0, 100, 0, 0, 0); run(30)
    const stacked = shown()
    out.stacked = {
      both: stacked.length === 2,
      quadrants: new Set(stacked.map((l) => `${l.side}${l.align}`)).size === 2,
      apart: stacked.length === 2 && !(stacked[0].x < stacked[1].x + stacked[1].width && stacked[1].x < stacked[0].x + stacked[0].width &&
        stacked[0].y < stacked[1].y + stacked[1].height && stacked[1].y < stacked[0].y + stacked[0].height),
    }

    // --- A label that loses its spot fades out rather than vanishing ---------------
    reset()
    const crowd = []
    for (let i = 0; i < 8; i++) crowd.push(graph.addNode({ x: (i % 2) * 3, y: i * 0.5, z: -i * 2, label: `a fairly long name number ${i}` }).id)
    view.sync()
    lookAt(0, 0, 120, 0, 0, 0); run(60)
    const before = new Map(shown().map((l) => [l.id, l.opacity]))
    out.crowdPlaced = before.size < crowd.length && before.size > 0
    // The hovered label takes a spot at any cost: someone has to give one up.
    const intruder = crowd.find((id) => !before.has(id))
    view.setHover({ kind: 'node', id: intruder })
    run(1)
    const after = new Map(shown().map((l) => [l.id, l.opacity]))
    out.fading = [...before].some(([id, was]) => after.has(id) && after.get(id) < was && after.get(id) > 0)
    run(40)
    out.fadedOut = [...before].some(([id]) => !after.has(id) || !shownOf(id))
    view.setHover(null)

    // --- Hover: shown past its range, amber, full strength, wider tracking ---------
    reset()
    const far = graph.addNode({ x: 0, y: 0, z: 0, label: 'aimed at' })
    view.sync()
    lookAt(0, 0, 1000, 0, 0, 0); run(20)
    out.hoverBefore = shownOf(far.id) === null
    lookAt(0, 0, 150, 0, 0, 0); run(20)
    const plain = shownOf(far.id)
    view.setHover({ kind: 'node', id: far.id })
    run(20)
    const hot = shownOf(far.id)
    out.hover = {
      shown: hot && +hot.opacity.toFixed(3),
      undimmed: hot && hot.dim === 1,
      wider: hot && plain && hot.width > plain.width,
      biggerText: hot && plain && hot.fontPx > plain.fontPx === false, // size is the star's, not the hover's
    }
    const hf = labelFrame()
    let red = 0, blue = 0
    for (let i = 0; i < hf.length; i += 4) { red += hf[i]; blue += hf[i + 2] }
    out.hoverWarm = red > blue * 1.4
    lookAt(0, 0, 1000, 0, 0, 0); run(20)
    out.hoverPastRange = shownOf(far.id)?.opacity === 1
    view.setHover(null)
    run(40)
    out.hoverGone = shownOf(far.id) === null

    // --- Edits: new text shows with no view call; an empty label draws nothing -----
    reset()
    const ed = graph.addNode({ x: 0, y: 0, z: 0, label: 'short' })
    view.sync()
    lookAt(0, 0, 100, 0, 0, 0); run(20)
    const wShort = shownOf(ed.id).width
    ed.label = 'a considerably longer label'
    run(1)
    out.editText = shownOf(ed.id)?.text
    out.editWider = shownOf(ed.id).width > wShort * 2
    const editBox = litBox(labelFrame(true))
    out.editPixelsWider = editBox.x1 - editBox.x0 > wShort * 2
    ed.label = '  spaced \n\n out  '
    run(1)
    out.editCollapsed = shownOf(ed.id)?.text
    ed.label = ''
    run(1)
    out.editEmpty = shownOf(ed.id) === null && labelFrame().every((v, i) => (i & 3) === 3 || v === 0)
    ed.label = 'word '.repeat(80)
    run(20)
    const long = shownOf(ed.id)
    out.truncated = long.text.endsWith('…') && long.text.length < 80
    out.truncatedWidth = +long.width.toFixed(1)

    // --- Deletes and loads ---------------------------------------------------------
    graph.removeNode(ed.id)
    view.syncNodes()
    run(1)
    out.deleted = shown().length === 0 && mesh().visible === false && leaders().visible === false
    const g1 = graph.addNode({ x: 0, y: 0, z: 0, label: 'old map' })
    view.sync()
    run(20)
    graph.load({ nodes: [{ id: g1.id, label: 'new map', notes: '', links: [], x: 0, y: 0, z: 0, cluster_color_id: 0, is_core: false }], edges: [] })
    view.sync()
    run(1)
    out.loadFadesIn = (shownOf(g1.id)?.opacity ?? 0) < 0.6 && shownOf(g1.id)?.text !== 'old map'
    run(20)
    out.loadText = shownOf(g1.id)?.text

    // --- Drawn after the star composite: star light never lies over a label --------
    reset()
    renderer.setPixelRatio(2)
    dw = W * 2; dh = H * 2
    const lit = graph.addNode({ x: 0, y: 0, z: 0, label: 'Over a star' })
    view.sync()
    lookAt(0, 0, 60, 0, 0, 0); run(20)
    const l = shownOf(lit.id)
    out.litFull = l.opacity === 1 // near enough that nothing is dimmed
    // A big star straight behind the name's ink, 140 units further on — a
    // 2.25x core at 200 from the camera, the same apparent size a 3x one had
    // at 260 before the sizing rule changed.
    const through = new THREE.Vector3(((l.x + l.width / 2) / W) * 2 - 1, 1 - ((l.y + l.height / 2) / H) * 2, 0.5).unproject(camera)
    through.sub(camera.position).setLength(200).add(camera.position)
    const star = graph.addNode({ x: through.x, y: through.y, z: through.z })
    graph.setCore(star.id, true)
    view.syncNodes()
    run(40)
    const alone = labelFrame() // over black
    const full = (bloom.render(), read())
    graph.getNode(lit.id).label = ''
    view.update(clock, camera) // same instant: the stars pulse, so the clock must not move
    const bare = (bloom.render(), read())
    let solid = 0, same = 0, underLit = 0
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const a = at(alone, x, y)
      // Pixels the glyphs fully cover draw the plain tier's ink exactly.
      if (Math.abs(a[0] - 0xc2) > 1 || Math.abs(a[1] - 0xcc) > 1 || Math.abs(a[2] - 0xdb) > 1) continue
      solid++
      const f = at(full, x, y), b = at(bare, x, y)
      if (Math.abs(f[0] - a[0]) <= 2 && Math.abs(f[1] - a[1]) <= 2 && Math.abs(f[2] - a[2]) <= 2) same++
      if (b[0] + b[1] + b[2] > 240) underLit++
    }
    out.overStar = { solid, same, underLit }
    // Labels are not bloomed: well outside the ink nothing changes.
    let outside = 0
    const rr = { x0: l.x - 40, x1: l.x + l.width + 40, y0: l.y - 40, y1: l.y + l.height + 40 }
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const cxp = x / 2, cyp = (dh - 1 - y) / 2
      if (cxp > rr.x0 && cxp < rr.x1 && cyp > rr.y0 && cyp < rr.y1) continue
      const f = at(full, x, y), b = at(bare, x, y)
      outside = Math.max(outside, Math.abs(f[0] - b[0]), Math.abs(f[1] - b[1]), Math.abs(f[2] - b[2]))
    }
    out.noBloomOutside = outside
    let nameDraws = 0, leaderDraws = 0
    mesh().onBeforeRender = () => nameDraws++
    leaders().onBeforeRender = () => leaderDraws++
    graph.getNode(lit.id).label = 'Over a star'
    run(20)
    bloom.render()
    out.drawsPerFrame = [nameDraws, leaderDraws]
    mesh().onBeforeRender = () => {}
    leaders().onBeforeRender = () => {}
    out.cameraRestored = camera.layers.mask === 1

    // --- Pixel ratio: sizes are CSS px ---------------------------------------------
    reset()
    const pr = graph.addNode({ x: 0, y: 0, z: 0, label: 'ratio' })
    view.sync()
    lookAt(0, 0, 150, 0, 0, 0); run(20)
    const two = { rep: { ...shownOf(pr.id) }, box: litBox(labelFrame(true), 24, 2) }
    renderer.setPixelRatio(1)
    dw = W; dh = H
    run(2)
    const one = { rep: { ...shownOf(pr.id) }, box: litBox(labelFrame(true), 24, 1) }
    out.ratio = {
      rep: [two.rep.width, one.rep.width].map((v) => +v.toFixed(2)),
      box: [two.box.x1 - two.box.x0, one.box.x1 - one.box.x0].map((v) => +v.toFixed(1)),
      centre: [(two.box.x0 + two.box.x1) / 2, (one.box.x0 + one.box.x1) / 2].map((v) => +v.toFixed(1)),
    }

    // --- A dense map: no two names overlap, and a clean one crosses no star --------
    reset()
    let s = 5
    const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32
    const ids = []
    for (let i = 0; i < 300; i++) {
      ids.push(graph.addNode({ x: (rand() - 0.5) * 400, y: (rand() - 0.5) * 400, z: (rand() - 0.5) * 400, label: `node ${i}` }).id)
      if (i && rand() < 0.8) graph.addEdge(ids[i], ids[Math.floor(rand() * i)])
    }
    graph.setCore(ids[0], true)
    view.sync()
    lookAt(0, 0, 150, 0, 0, -100); run(40)
    const list = shown()
    let overlapping = 0
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlapping++
    }
    const field = discs().filter((d) => d.r >= 3)
    let cleanCrossings = 0, crossings = 0, cleanCount = 0
    for (const label of list) {
      if (label.clean) cleanCount++
      for (const disc of field) {
        if (disc.id === label.id || !hits(label, disc)) continue
        crossings++
        if (label.clean) cleanCrossings++
      }
    }
    out.dense = { shown: list.length, clean: cleanCount, overlapping, cleanCrossings, crossings }
    renderer.info.autoReset = false
    renderer.info.reset()
    labelFrame()
    out.labelCalls = renderer.info.render.calls
    renderer.info.autoReset = true

    // The same again at an ordinary spread rather than a saturated one: here
    // nearly every name should find a clean spot, which is what the first pass
    // is for. Scaled to 0.7, for the same reason as the dense map.
    reset()
    const spread = []
    for (let i = 0; i < 60; i++) {
      spread.push(graph.addNode({ x: (rand() - 0.5) * 434, y: (rand() - 0.5) * 322, z: (rand() - 0.5) * 252, label: `node ${i}` }).id)
      if (i % 2) graph.addEdge(spread[i - 1], spread[i])
    }
    view.sync()
    lookAt(0, 0, 105, 0, 0, -70); run(40)
    const open = shown()
    const openField = discs().filter((d) => d.r >= 3)
    let openCrossings = 0, openCleanCrossings = 0
    for (const label of open) for (const disc of openField) {
      if (disc.id === label.id || !hits(label, disc)) continue
      openCrossings++
      if (label.clean) openCleanCrossings++
    }
    out.open = { shown: open.length, clean: open.filter((l) => l.clean).length, cleanCrossings: openCleanCrossings, crossings: openCrossings }

    // --- New labels are rasterised a batch per frame -------------------------------
    reset()
    const grid = []
    for (let i = 0; i < 100; i++) {
      grid.push(graph.addNode({ x: (i % 10) * 22.5 - 101.25, y: Math.floor(i / 10) * 17 - 76.5, z: 0, label: `n${i}` }).id)
      if (i % 2) graph.addEdge(grid[i - 1], grid[i])
    }
    view.sync()
    // Grid and camera at ~2/3 scale, so all 100 sit inside the 200-unit range.
    lookAt(0, 0, 120, 0, 0, 0)
    const counts = []
    for (let i = 0; i < 8; i++) { run(1); counts.push(shown().length) }
    out.batches = counts

    // --- Eviction: fly past 2000 labels, come back, the first reads the same --------
    reset()
    const line = []
    for (let i = 0; i < 2000; i++) line.push(graph.addNode({ x: i * 25, y: 0, z: 0, label: `label number ${i} of the line` }).id)
    view.sync()
    lookAt(0, 0, 120, 0, 0, 0); run(20)
    const firstShot = labelFrame()
    const firstRep = { ...shownOf(line[0]) }
    let maxShown = 0
    const ever = new Set()
    for (let x = 0; x <= 2000 * 25; x += 60) {
      lookAt(x, 0, 120, x, 0, 0); run(1)
      maxShown = Math.max(maxShown, shown().length)
      for (const l of shown()) ever.add(l.id)
    }
    lookAt(0, 0, 120, 0, 0, 0); run(20)
    const againShot = labelFrame()
    let worst = 0
    for (let i = 0; i < firstShot.length; i++) worst = Math.max(worst, Math.abs(firstShot[i] - againShot[i]))
    out.eviction = { worst, maxShown, ever: ever.size, text: shownOf(line[0])?.text, sameRect: shownOf(line[0])?.x === firstRep.x }

    // --- Cost -----------------------------------------------------------------------
    reset()
    for (let i = 0; i < 3000; i++) graph.addNode({ x: (rand() - 0.5) * 2000, y: (rand() - 0.5) * 2000, z: (rand() - 0.5) * 2000, label: `n ${i}` })
    view.sync()
    lookAt(0, 0, 0, 0, 0, -1)
    run(30)
    let t0 = performance.now()
    for (let i = 0; i < 60; i++) run(1, 0.016)
    out.update3000 = +((performance.now() - t0) / 60).toFixed(3)
    for (const n of graph.nodes.values()) n.label = ''
    run(2)
    t0 = performance.now()
    for (let i = 0; i < 60; i++) run(1, 0.016)
    out.update3000Blank = +((performance.now() - t0) / 60).toFixed(3)
    return out
  }, threeUrl)

  const within = (got, want, tol) => Math.abs(got - want) <= tol
  expect.soft(r.layerOnly && r.hiddenEmpty, 'name and leader meshes on LABEL_LAYER only, both hidden when empty').toBe(true)
  expect.soft(within(r.rule[0], 200, 1e-9) && within(r.rule[1], 304.2, 0.1) && within(r.rule[4], 1576, 1) && r.rule[5] === Infinity && r.rule[6] === Infinity, 'reveal range: 200 at 1x, ~304 at 1 link, cubic, infinite from 2x').toBe(true)
  expect.soft(r.onlyNamed && r.namedFull && r.named.clean, 'unlabelled node draws nothing; a labelled one draws at full strength').toBe(true)
  expect.soft(r.box && r.box.x0 >= r.rect.x - 1 && r.box.x1 <= r.rect.x + r.rect.w + 1 && r.box.y0 >= r.rect.y - 1 && r.box.y1 <= r.rect.y + r.rect.h + 1 && r.box.x1 - r.box.x0 > r.rect.w - 6, 'glyph pixels inside the reported rect, and nearly as wide').toBe(true)
  expect.soft(within(r.callout.start, r.callout.startWant, 0.3) && within(r.callout.diagonal, 1, 0.01) && r.callout.shelfLevel && within(r.callout.textAfterShelf, 5, 0.5) && r.callout.centred < 0.6, 'callout: leader starts 1.5 radii + 3 px out, runs at 45 degrees to a level shelf, name on the end').toBe(true)
  expect.soft(r.layer0Empty, 'labels are not in the canvas pass').toBe(true)
  expect.soft(r.reveal.every((p) => within(p.got, p.want, 0.05)), 'reveal fades in from 200 to 150 units (smoothstep, +-0.05), none past 200').toBe(true)
  expect.soft(r.firstSeen !== null && r.firstSeen <= 200 && r.firstSeen >= 190, 'flying straight at a node, its label turns up at ~200 units').toBe(true)
  expect.soft(r.oneLink[0] === 1 && within(r.oneLink[1], 0.352, 0.03) && r.oneLink[2] === 0, 'one link does not carry the label further: full at 140, fading at 180, gone at 220').toBe(true)
  expect.soft(r.tooClose && r.behind, "flying through the star hides its label; behind the camera draws nothing").toBe(true)
  expect.soft(r.sizes.every((p, i) => i === 0 || p.px <= r.sizes[i - 1].px) && r.sizes[0].px >= 28 && r.sizes.at(-1).px === 12 && r.sizes[0].px / r.sizes.at(-1).px > 2.3, 'size follows distance: biggest close in, smaller every step out, down to a floor').toBe(true)
  expect.soft(r.sizes[0].dim === 1 && within(r.sizes.at(-1).dim, 0.75, 0.001), 'distance drains a label too: full close in, down to the core floor far out').toBe(true)
  expect.soft(r.depthPair[0], 'of two stars, the nearer one carries the bigger name').toBeGreaterThan(r.depthPair[1] * 1.8)
  expect.soft(r.tiers[0]?.tier === 'core' && r.tiers[0]?.text === 'CORE NODE' && r.tiers[1]?.tier === 'plain' && r.tiers[1]?.text === 'Hop one' && r.tiers[2]?.tier === 'plain' && r.tiers[2]?.text === 'Alone', 'tiers: a core in capitals; its neighbour, like a lone node, plain').toBe(true)
  expect.soft(within(r.coreStart, r.coreStartWant, 1.5) && r.coreStartEasing < r.coreStart && r.coreStartEasing > r.coreStartAfter && r.coreStartAfter < r.coreStart / 2, 'marked core: the callout moves out with the grown radius, eases back').toBe(true)
  expect.soft(r.stacked.both && r.stacked.quadrants && r.stacked.apart, 'two stars on the same spot: both named, callouts turned to different sides').toBe(true)
  expect.soft(r.crowdPlaced && r.fading && r.fadedOut, 'in a crowd some names wait, and one that loses its spot fades out').toBe(true)
  expect.soft(r.hover.shown === 1 && r.hover.undimmed && r.hover.wider && r.hoverWarm && r.hoverBefore && r.hoverPastRange, 'hovered: amber, undimmed, wider tracking, and shown past its range').toBe(true)
  expect.soft(r.hoverGone, 'hover cleared: out-of-range label goes').toBe(true)
  expect.soft(r.editText === 'a considerably longer label' && r.editWider && r.editPixelsWider, 'edited text shows next frame, no view call, wider in pixels too').toBe(true)
  expect.soft(r.editCollapsed === 'spaced out' && r.editEmpty, 'whitespace collapsed to one line; empty label draws nothing').toBe(true)
  expect.soft(r.truncated && r.truncatedWidth < 400, 'long label truncated with an ellipsis, width bounded').toBe(true)
  expect.soft(r.deleted, 'deleted node: label gone, both meshes hidden').toBe(true)
  expect.soft(r.loadFadesIn && r.loadText === 'new map', 'load reusing an id: new text, fades in from nothing').toBe(true)
  expect.soft(r.litFull && r.overStar.solid > 30 && r.overStar.same === r.overStar.solid && r.overStar.underLit > r.overStar.solid * 0.5, 'over a bright star, fully covered glyph pixels keep the exact ink colour').toBe(true)
  expect.soft(r.noBloomOutside, 'labels do not bloom: nothing changes outside their ink').toBeLessThanOrEqual(2)
  expect.soft(JSON.stringify(r.drawsPerFrame) === '[1,1]' && r.labelCalls === 2 && r.cameraRestored, 'one draw call for the names and one for the leaders; camera layers restored').toBe(true)
  expect.soft(within(r.ratio.rep[0], r.ratio.rep[1], 0.01) && within(r.ratio.box[0], r.ratio.box[1], 2) && within(r.ratio.centre[0], r.ratio.centre[1], 1), 'pixel ratio 2: same CSS size and place as at 1').toBe(true)
  // Clean names as a share of those shown, not a fixed count: with every
  // non-core at 1x, fewer of this map's names are in range than when links
  // grew them (30 shown against 86), and the share that finds a clean spot is
  // the same ~23% either way. The hard invariants are the zeros.
  expect.soft(r.dense.shown > 20 && r.dense.overlapping === 0 && r.dense.cleanCrossings === 0 && r.dense.clean >= r.dense.shown * 0.15 && r.dense.crossings < r.dense.shown * 1.5, 'dense map: names shown, none overlapping, clean ones clear of every star').toBe(true)
  expect.soft(r.open.shown >= 8 && r.open.clean >= r.open.shown * 0.8 && r.open.cleanCrossings === 0 && r.open.crossings <= r.open.shown - r.open.clean, 'an ordinary spread: nearly every name finds a clean spot, and a clean one is off every star').toBe(true)
  expect.soft(JSON.stringify(r.batches.slice(0, 3)) === '[24,48,72]' && r.batches[4] >= 88 && r.batches[4] === r.batches.at(-1), '100 new labels: 24 rasterised a frame, and all that fit are in by the fifth').toBe(true)
  expect.soft(r.eviction.ever > 400 && r.eviction.worst <= 1 && r.eviction.text === 'label number 0 of the line' && r.eviction.sameRect, 'after 2000 labels cycle through the atlas, the first reads pixel-identical').toBe(true)
  expect.soft(r.update3000, '3000 labelled nodes: update < 2 ms/frame').toBeLessThan(2)
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})

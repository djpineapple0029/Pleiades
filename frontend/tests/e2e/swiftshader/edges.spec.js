// Ported from tests/_rescued/e2e/e2e_edges.mjs (session 7).
//
// Edge width, depth fog, endpoint fade, hover, and drift motes, against the
// real modules. Layer-0 renders only, onto black, so the stars (STAR_LAYER)
// never enter a measurement.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, threeModuleUrl } from '../helpers/gestures.js'

test('edges: width, fog, endpoint fade, hover, drift motes', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  const threeUrl = await threeModuleUrl(page)

  const r = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView } = await import('/src/graphView.js')
    const { createPhysics } = await import('/src/physics.js')
    document.getElementById('viewport').remove()

    let W = 640,
      H = 480
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
    const physics = createPhysics(graph, view)
    const lines = () => scene.getObjectByName('edges')
    const drift = () => scene.getObjectByName('edge-drift')
    const out = {}
    // sync() sets visibility, so isolate with layers instead: layer 7 is never rendered.
    const show = ({ edges = true, motes = true }) => {
      lines().layers.set(edges ? 0 : 7)
      drift().layers.set(motes ? 0 : 7)
    }

    const P11 = camera.projectionMatrix.elements[5]
    const pxAt = (d) => (0.5 * H * P11) / d // CSS px per world unit at depth d (pixel ratio 1)
    const read = () => {
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      return buf
    }
    const frame = () => {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      return read()
    }
    const at = (buf, x, y, c) => buf[(y * W + x) * 4 + c]
    const screenOf = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(camera)
      return [(v.x * 0.5 + 0.5) * W, (v.y * 0.5 + 0.5) * H]
    }
    // Summed channel c over a vertical window around row yc, averaged over columns x0..x1.
    const band = (buf, x0, x1, yc, half = 8, c = 2) => {
      let s = 0
      for (let x = Math.round(x0); x <= Math.round(x1); x++)
        for (let y = Math.round(yc) - half; y <= Math.round(yc) + half; y++) s += at(buf, x, y, c)
      return s / (Math.round(x1) - Math.round(x0) + 1)
    }
    const litRows = (buf, x, yc, half = 8, c = 2, min = 8) => {
      let n = 0
      for (let y = Math.round(yc) - half; y <= Math.round(yc) + half; y++) if (at(buf, x, y, c) >= min) n++
      return n
    }
    const lookAt = (px, py, pz, tx, ty, tz) => {
      camera.position.set(px, py, pz)
      camera.up.set(0, 1, 0)
      camera.lookAt(tx, ty, tz)
      camera.updateMatrixWorld(true)
    }
    const reset = () => {
      graph.load({ nodes: [], edges: [] })
      physics.reset()
      view.sync()
      view.setHover(null)
    }
    const link = (a, b) => {
      const na = graph.addNode({ x: a[0], y: a[1], z: a[2] }),
        nb = graph.addNode({ x: b[0], y: b[1], z: b[2] })
      return { a: na, b: nb, edge: graph.addEdge(na.id, nb.id) }
    }
    let clock = 10
    const tick = (dt) => {
      clock += dt
      view.update(clock)
    }
    const smooth = (e0, e1, x) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
      return t * t * (3 - 2 * t)
    }

    // --- Structure -----------------------------------------------------------
    link([-100, 0, 0], [100, 0, 0])
    view.sync()
    tick(0)
    out.layers = lines().layers.mask === 1 && drift().layers.mask === 1
    out.sharedEndpoints =
      drift().geometry.getAttribute('instanceStart').data ===
        lines().geometry.getAttribute('instanceStart').data &&
      drift().geometry.getAttribute('instanceEdge') === lines().geometry.getAttribute('instanceEdge')

    // --- Width and strength follow distance ----------------------------------
    // Lines alone; an edge square to the view, measured across its middle.
    show({ motes: false })
    const expectLine = (d) => {
      const tw = 1 * pxAt(d) // EDGE_WORLD_WIDTH = 1
      const drawn = Math.min(2.5, Math.max(1, tw)),
        cov = Math.sqrt(Math.min(1, tw))
      const near = Math.max(200, d - 100),
        far = Math.max(d + 100, near + 800) // sphere r = 100 around the origin
      const fog = 1 + (0.25 - 1) * smooth(near, far, d)
      return drawn * cov * fog
    }
    out.widths = [80, 200, 343, 700, 1400].map((d) => {
      lookAt(0, 0, d, 0, 0, 0)
      const f = frame()
      const half = 40 * pxAt(d) // the middle 80 units, well clear of the ends
      return {
        d,
        sum: band(f, W / 2 - half, W / 2 + half, H / 2),
        rows: litRows(f, Math.round(W / 2 + 7), H / 2),
        expect: expectLine(d),
      }
    })
    const k = out.widths[0].sum / out.widths[0].expect
    out.widthRatios = out.widths.map((w) => +(w.sum / (k * w.expect)).toFixed(3))
    out.fogRangeSmall = (() => {
      lookAt(0, 0, 150, 0, 0, 0)
      frame()
      return lines().material.uniforms.fogRange.value.toArray()
    })()

    // --- Depth fog spans the map, not a fixed range ---------------------------
    // Near edge at z=+400, far edge at z=-400, viewed from far outside.
    reset()
    link([-600, 60, 400], [600, 60, 400])
    link([-600, -60, -400], [600, -60, -400])
    view.sync()
    const D = 3000
    lookAt(0, 0, D, 0, 0, 0)
    const ff = frame()
    const range = lines().material.uniforms.fogRange.value.toArray()
    const R = Math.hypot(600, 60, 400)
    out.fogRange = range.map((v) => +v.toFixed(1))
    out.fogRangeExpected = [Math.max(200, D - R), Math.max(D + R, Math.max(200, D - R) + 800)].map(
      (v) => +v.toFixed(1),
    )
    const measureAt = (y, z) => {
      const d = D - z,
        [, sy] = screenOf(0, y, z),
        half = 300 * pxAt(d)
      const tw = pxAt(d),
        drawn = Math.min(2.5, Math.max(1, tw)),
        cov = Math.sqrt(Math.min(1, tw))
      return {
        sum: band(ff, W / 2 - half, W / 2 + half, sy, 4),
        drawnCov: drawn * cov,
        fog: 1 - 0.75 * smooth(range[0], range[1], d),
      }
    }
    const nearSide = measureAt(60, 400),
      farSide = measureAt(-60, -400)
    out.fogNearSide = +(nearSide.sum / (k * nearSide.drawnCov)).toFixed(3) // ~1: not fogged at 2600 units
    out.fogFarSide = +(farSide.sum / (k * farSide.drawnCov)).toFixed(3) // ~FOG_FLOOR
    out.fogPredicted = [nearSide.fog, farSide.fog].map((v) => +v.toFixed(3))

    // --- Each end fades out inside its node's glow ----------------------------
    reset()
    const f1 = link([0, 0, 0], [200, 0, 0])
    view.sync()
    lookAt(100, 0, 150, 100, 0, 0)
    const strengthAt = (buf, x) => {
      const [sx] = screenOf(x, 0, 0)
      return band(buf, sx, sx, H / 2, 6)
    }
    const ref = strengthAt(frame(), 100)
    const rA = view.radiusOf(f1.a.id)
    out.endRadius = rA
    const endFrame = frame()
    out.endProfile = [0.5, 0.9, 1.1, 1.6, 2.0, 2.6, 4, 8].map((m) => ({
      m,
      got: +(strengthAt(endFrame, m * rA) / ref).toFixed(3),
      want: +smooth(1.1 * rA, 2.4 * rA, m * rA).toFixed(3),
    }))
    // A core end grows, and its fade grows with it (radii follow easing).
    graph.setCore(f1.a.id, true)
    for (let i = 0; i < 40; i++) tick(0.05)
    const rCore = view.radiusOf(f1.a.id)
    const coreFrame = frame()
    out.coreRadius = rCore
    out.coreEnd = [1.6 * rA, 1.5 * rCore, 2.6 * rCore].map(
      (x) => +(strengthAt(coreFrame, x) / ref).toFixed(3),
    )

    // --- Hover: full strength, wider, in the hover colour, at any distance ----
    reset()
    const h1 = link([-300, 0, 0], [300, 0, 0])
    view.sync()
    lookAt(0, 0, 1400, 0, 0, 0)
    const plain = frame()
    view.setHover({ kind: 'edge', id: h1.edge.id })
    const lit = frame()
    const hx = [W / 2 - 60, W / 2 + 60]
    out.hoverPlain = {
      red: +band(plain, ...hx, H / 2, 6, 0).toFixed(1),
      blue: +band(plain, ...hx, H / 2, 6, 2).toFixed(1),
    }
    out.hoverLit = {
      red: +band(lit, ...hx, H / 2, 6, 0).toFixed(1),
      blue: +band(lit, ...hx, H / 2, 6, 2).toFixed(1),
      rows: litRows(lit, W / 2 + 7, H / 2, 6, 0, 60),
    }
    // Survives a sync that renumbers it, and clears when its edge goes.
    const other = graph.addNode({ x: 0, y: 2000, z: 0 })
    graph.addEdge(other.id, h1.a.id) // index 1, after the hovered edge
    view.syncEdges()
    graph.removeEdge(h1.edge.id)
    graph.addEdge(h1.a.id, h1.b.id) // hovered id gone; re-added as a new id
    view.syncEdges()
    out.hoverClearedWithEdge = lines().material.uniforms.hovered.value === -1
    reset()
    const s1 = link([-300, 200, 0], [300, 200, 0]) // index 0
    const s2 = link([-300, 0, 0], [300, 0, 0]) // index 1, hovered
    view.sync()
    view.setHover({ kind: 'edge', id: s2.edge.id })
    graph.removeEdge(s1.edge.id)
    view.syncEdges() // s2 moves to index 0
    lookAt(0, 0, 1400, 0, 0, 0)
    const moved = frame()
    out.hoverSurvivesSync =
      lines().material.uniforms.hovered.value === 0 &&
      band(moved, ...hx, H / 2, 6, 0) > out.hoverPlain.red * 3
    graph.removeEdge(s2.edge.id)
    view.syncEdges()
    out.hoverGone = lines().material.uniforms.hovered.value === -1
    view.setHover(null)

    // --- Picking ---------------------------------------------------------------
    reset()
    const p1 = link([-300, 0, 0], [300, 0, 0])
    view.sync()
    lookAt(0, 0, 1400, 0, 0, 0)
    frame()
    const raycaster = new THREE.Raycaster()
    raycaster.camera = camera
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
    out.farThinPick = view.raycast(raycaster)?.id === p1.edge.id
    raycaster.setFromCamera(new THREE.Vector2(0, 10 / H), camera) // 5 px off: inside the pick width (2.5 + 9 px across)
    out.farThinPickOffset = view.raycast(raycaster)?.id === p1.edge.id
    // A settled map: every edge pickable at its midpoint from beside it.
    reset()
    let s = 3
    const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32
    const ids = []
    for (let i = 0; i < 120; i++) {
      ids.push(
        graph.addNode({ x: (rand() - 0.5) * 300, y: (rand() - 0.5) * 300, z: (rand() - 0.5) * 300 }).id,
      )
      if (i) graph.addEdge(ids[i], ids[Math.floor(rand() * i)])
    }
    view.sync()
    physics.start()
    let g = 0
    while (physics.isRunning && g++ < 4000) physics.update()
    let picked = 0,
      tried = 0
    for (const edge of graph.edges.values()) {
      const a = graph.getNode(edge.from),
        b = graph.getNode(edge.to)
      const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
      const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize()
      const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize()
      lookAt(...mid.clone().addScaledVector(side, 25).toArray(), ...mid.toArray())
      renderer.render(scene, camera) // resolution/fog current
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
      const hit = view.raycast(raycaster)
      tried++
      if (hit?.kind === 'edge' && hit.id === edge.id) picked++
    }
    out.settledPick = [picked, tried]

    // --- Drift motes -----------------------------------------------------------
    reset()
    const m1 = link([0, 0, 0], [200, 0, 0])
    view.sync()
    show({ edges: false })
    lookAt(100, 0, 120, 100, 0, 0)
    const ppu = pxAt(120)
    // Mote centres along the edge's row, in screen px (intensity centroids).
    const motes = (buf) => {
      const prof = []
      for (let x = 0; x < W; x++) {
        let v = 0
        for (let y = H / 2 - 4; y <= H / 2 + 4; y++) v += at(buf, x, y, 2)
        prof.push(v)
      }
      // One connected run of lit columns per mote; its intensity centroid.
      const found = []
      for (let x = 0; x < W;) {
        if (prof[x] < 30) {
          x++
          continue
        }
        let m = 0,
          w = 0
        while (x < W && prof[x] >= 30) {
          m += x * prof[x]
          w += prof[x]
          x++
        }
        found.push(m / w)
      }
      return found
    }
    const shifts = (before, after) =>
      after
        .map((x) => {
          let best = null
          for (const y of before) if (best === null || Math.abs(x - y) < Math.abs(x - best)) best = y
          return best === null ? null : x - best
        })
        .filter((d) => d !== null && Math.abs(d) < 12)
    tick(0)
    const d0 = frame()
    out.moteCount = motes(d0).length
    tick(0.1)
    tick(0.1)
    const d1 = frame()
    const expectShift = 9 * 0.2 * ppu
    out.undirectedShifts = shifts(motes(d0), motes(d1)).map((v) => +v.toFixed(2))
    out.expectShift = +expectShift.toFixed(2)
    // Directed: one stream, from -> to.
    graph.getEdge(m1.edge.id).directed = true
    view.syncEdges()
    const d2 = frame()
    tick(0.1)
    tick(0.1)
    const d3 = frame()
    out.directedShifts = shifts(motes(d2), motes(d3)).map((v) => +v.toFixed(2))
    out.directedCount = motes(d2).length
    // Speed is in world units: a 400-unit edge moves its motes as fast.
    reset()
    const m2 = link([0, 0, 0], [400, 0, 0])
    view.sync()
    graph.getEdge(m2.edge.id).directed = true
    view.syncEdges()
    lookAt(200, 0, 240, 200, 0, 0)
    tick(0)
    const l0 = frame()
    tick(0.1)
    tick(0.1)
    const l1 = frame()
    out.longShifts = shifts(motes(l0), motes(l1)).map((v) => +(v / pxAt(240)).toFixed(2)) // world units
    // Stretching the edge moves motes continuously (phase untouched).
    const phaseBefore = drift().geometry.getAttribute('instanceEdge').array[2]
    const beforeStretch = motes(l1)
    graph.getNode(m2.b.id).x += 30
    view.updateEdgePositions()
    tick(0)
    const afterStretch = motes(frame())
    const x0 = screenOf(0, 0, 0)[0],
      perUnit = pxAt(240)
    out.stretchPhaseSame = drift().geometry.getAttribute('instanceEdge').array[2] === phaseBefore
    out.stretch = beforeStretch.map((x) => {
      const t = (x - x0) / (400 * perUnit)
      const want = x + t * 30 * perUnit
      const got = afterStretch.reduce((b, y) => (Math.abs(y - want) < Math.abs(b - want) ? y : b), Infinity)
      return +(got - want).toFixed(2)
    })
    // Another edge synced in leaves this one's motes where they were.
    const quiet = frame()
    const far = graph.addNode({ x: 430, y: 3000, z: 0 })
    graph.addEdge(m2.b.id, far.id)
    view.syncEdges()
    tick(0)
    const afterSync = frame()
    let syncDiff = 0
    const bx = screenOf(430, 0, 0)[0]
    for (let x = 0; x < bx - 20; x++)
      for (let y = H / 2 - 6; y <= H / 2 + 6; y++)
        syncDiff = Math.max(syncDiff, Math.abs(at(quiet, x, y, 2) - at(afterSync, x, y, 2)))
    out.syncKeepsMotes = syncDiff
    // Motes fog out: none at 800 units, some at 100.
    reset()
    link([-100, 0, 0], [100, 0, 0])
    view.sync()
    const litCount = (buf) => {
      let n = 0
      for (let i = 0; i < buf.length; i += 4) if (buf[i] + buf[i + 1] + buf[i + 2] > 0) n++
      return n
    }
    lookAt(0, 0, 800, 0, 0, 0)
    tick(0)
    out.motesAt800 = litCount(frame())
    lookAt(0, 0, 100, 0, 0, 0)
    out.motesAt100 = litCount(frame())
    // Hovered edge's motes take the hover colour.
    view.setHover({ kind: 'edge', id: [...graph.edges.keys()][0] })
    const hm = frame()
    let red = 0,
      blue = 0
    for (let i = 0; i < hm.length; i += 4) {
      red += hm[i]
      blue += hm[i + 2]
    }
    out.hoverMotesWarm = red > blue
    view.setHover(null)
    show({})

    // --- Near-plane trim: an edge running from behind the camera to ahead ------
    reset()
    link([-1000, 0, 0], [1000, 0, 0])
    view.sync()
    show({ motes: false })
    lookAt(0, 10, 0, 1000, 10, 0)
    const trim = frame()
    let low = 0,
      high = 0,
      off = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (at(trim, x, y, 2) < 8) continue
        if (Math.abs(x - W / 2) > 6) off++
        else if (y < H / 2) low++
        else high++
      }
    out.trim = { low, high, off }

    // --- Pixel ratio: widths are CSS px -----------------------------------------
    reset()
    link([-100, 0, 0], [100, 0, 0])
    view.sync()
    lookAt(0, 0, 80, 0, 0, 0)
    const one = band(frame(), W / 2 - 20, W / 2 + 20, H / 2, 10)
    renderer.setPixelRatio(2)
    W = 1280
    H = 960
    const two = band(frame(), W / 2 - 40, W / 2 + 40, H / 2, 20)
    out.ratioSums = [+one.toFixed(1), +two.toFixed(1)]
    renderer.setPixelRatio(1)
    W = 640
    H = 480
    show({})

    // --- Draw calls and cost -------------------------------------------------------
    reset()
    const many = []
    for (let i = 0; i < 3001; i++)
      many.push(graph.addNode({ x: (i % 60) * 20, y: Math.floor(i / 60) * 20, z: 0 }).id)
    for (let i = 1; i < 3001; i++) graph.addEdge(many[i - 1], many[i])
    let t0 = performance.now()
    view.sync()
    out.syncMs3000 = +(performance.now() - t0).toFixed(2)
    lookAt(600, 500, 1500, 600, 500, 0)
    renderer.info.reset()
    renderer.info.autoReset = false
    renderer.render(scene, camera)
    out.callsLayer0 = renderer.info.render.calls // edges + drift (stars are on their own layer)
    renderer.info.autoReset = true
    tick(0.016)
    t0 = performance.now()
    for (let i = 0; i < 200; i++) tick(0.016)
    out.updateMs3000 = +((performance.now() - t0) / 200).toFixed(3)
    t0 = performance.now()
    for (let i = 0; i < 50; i++) view.updateEdgePositions()
    out.positionsMs3000 = +((performance.now() - t0) / 50).toFixed(3)
    return out
  }, threeUrl)

  const within = (got, want, tol) => Math.abs(got - want) <= tol
  expect.soft(r.layers, 'edges and motes on layer 0 only').toBe(true)
  expect
    .soft(r.sharedEndpoints, 'motes read the edge endpoint buffer and edge attributes (one upload)')
    .toBe(true)
  expect
    .soft(
      r.widthRatios.every((v) => within(v, 1, 0.15)),
      'strength follows width x coverage x fog within 15% at 80..1400 units',
    )
    .toBe(true)
  expect
    .soft(
      r.widths[0].rows >= 2 &&
        r.widths[0].rows <= 4 &&
        r.widths.slice(3).every((w) => w.rows >= 1 && w.rows <= 2),
      'near edge is ~2.5 px, far ones 1-2 px',
    )
    .toBe(true)
  expect
    .soft(
      r.fogRangeSmall[0] === 200 && r.fogRangeSmall[1] >= 1000,
      'small map: fog never starts inside 200 units',
    )
    .toBe(true)
  expect
    .soft(
      r.fogRange.every((v, i) => within(v, r.fogRangeExpected[i], 1)),
      'fog range spans the map bounding sphere as seen from the camera',
    )
    .toBe(true)
  expect
    .soft(
      within(r.fogNearSide, r.fogPredicted[0], 0.12) && r.fogNearSide > 0.8,
      'map seen from 2600+ units: near side barely fogged (sphere is loose)',
    )
    .toBe(true)
  expect
    .soft(within(r.fogFarSide, r.fogPredicted[1], 0.08), 'map seen from outside: far side at the fog floor')
    .toBe(true)
  expect
    .soft(
      r.endProfile.every((p) => within(p.got, p.want, 0.12)),
      'edge fades out inside its end node (smoothstep 1.1r..2.4r, +-0.12)',
    )
    .toBe(true)
  expect
    .soft(
      r.coreRadius > 11 && r.coreEnd[0] < 0.05 && r.coreEnd[1] < 0.35 && r.coreEnd[2] > 0.9,
      'core end: fade grows with the eased radius',
    )
    .toBe(true)
  expect
    .soft(
      r.hoverLit.red > r.hoverLit.blue && r.hoverLit.red > r.hoverPlain.red * 5 && r.hoverLit.rows >= 3,
      'hovered far edge: warm, wider and far stronger',
    )
    .toBe(true)
  expect.soft(r.hoverSurvivesSync, 'hover follows its edge through a renumbering sync').toBe(true)
  expect.soft(r.hoverClearedWithEdge && r.hoverGone, 'hover clears when its edge is removed').toBe(true)
  expect
    .soft(r.farThinPick && r.farThinPickOffset, 'far 1 px edge still pickable, at centre and 5 px off')
    .toBe(true)
  expect
    .soft(
      r.settledPick[0] >= 0.95 * r.settledPick[1],
      'settled map: edges pickable at their midpoints (>= 95%)',
    )
    .toBe(true)
  expect.soft(r.moteCount >= 3 && r.moteCount <= 7, 'motes drawn along an edge').toBe(true)
  expect
    .soft(
      r.undirectedShifts.some((v) => within(v, r.expectShift, 1.2)) &&
        r.undirectedShifts.some((v) => within(v, -r.expectShift, 1.2)) &&
        r.undirectedShifts.every((v) => within(Math.abs(v), r.expectShift, 1.2)),
      'undirected: motes drift both ways at DRIFT_SPEED',
    )
    .toBe(true)
  expect
    .soft(
      r.directedShifts.length >= 2 && r.directedShifts.every((v) => within(v, r.expectShift, 1.2)),
      'directed: every mote drifts from -> to',
    )
    .toBe(true)
  expect
    .soft(
      r.longShifts.length >= 3 && r.longShifts.every((v) => within(v, 1.8, 0.5)),
      'speed is in world units, whatever the length (400-unit edge)',
    )
    .toBe(true)
  expect
    .soft(
      r.stretchPhaseSame && r.stretch.length >= 3 && r.stretch.every((v) => Math.abs(v) <= 1.5),
      'stretching an edge moves motes continuously, phase untouched',
    )
    .toBe(true)
  expect.soft(r.syncKeepsMotes, 'syncing another edge leaves existing motes in place').toBeLessThanOrEqual(2)
  expect
    .soft(r.motesAt800 === 0 && r.motesAt100 > 20, 'motes fog out by 800 units, present at 100')
    .toBe(true)
  expect.soft(r.hoverMotesWarm, 'hovered edge motes take the hover colour').toBe(true)
  expect
    .soft(
      r.trim.low > 100 && r.trim.high === 0 && r.trim.off === 0,
      'edge through the camera plane: trimmed, drawn ahead only, nothing stray',
    )
    .toBe(true)
  expect
    .soft(
      within(r.ratioSums[1] / r.ratioSums[0], 2, 0.2),
      'widths are CSS px: twice the device-px strength at pixel ratio 2',
    )
    .toBe(true)
  expect.soft(r.callsLayer0, '3000 edges: 2 draw calls on layer 0 (edges + motes)').toBe(2)
  expect.soft(r.updateMs3000, '3000 edges: drift update < 0.5 ms/frame').toBeLessThan(0.5)
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})

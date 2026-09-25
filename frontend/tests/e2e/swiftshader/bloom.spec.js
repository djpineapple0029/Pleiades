// Ported from tests/_rescued/e2e/e2e_bloom.mjs (session 6). Pixel-sensitive
// — ported last, per V2.md's suggested order, since it's the most fragile
// to environment drift (SwiftShader version, colour management).
//
// The bloom pipeline and the sky, against the real modules. Deterministic
// SwiftShader, so pixel comparisons are exact.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, threeModuleUrl } from '../helpers/gestures.js'

test('bloom pipeline and sky: layers, composite, roundness, orientation', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  const threeUrl = await threeModuleUrl(page)

  const r = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView, NODE_RADIUS } = await import('/src/graphView.js')
    const { createBloom, STAR_LAYER } = await import('/src/bloom.js')
    const { createSkybox } = await import('/src/skybox.js')
    const { createDust } = await import('/src/dust.js')
    const { VOID_COLOR } = await import('/src/scene.js')

    // Stop the app's own loop: it shares nothing with this page's renderer, but
    // it costs SwiftShader time.
    document.getElementById('viewport').remove()

    let W = 640,
      H = 480
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(1)
    renderer.setSize(W, H, false)
    renderer.setClearColor(VOID_COLOR)
    const gl = renderer.getContext()
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000)
    scene.add(camera)
    const t0 = performance.now()
    const sky = createSkybox(renderer)
    const bakeMs = performance.now() - t0
    scene.add(sky.object)
    const dust = createDust()
    scene.add(dust)

    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    const bloom = createBloom(renderer, scene, camera)
    const noBloom = createBloom(renderer, scene, camera, { strength: 0 })
    const out = { bakeMs: Math.round(bakeMs) }

    const look = (x, y, z, dist) => {
      camera.position.set(x, y, z + dist)
      camera.rotation.set(0, 0, 0)
      camera.updateMatrixWorld(true)
    }
    const read = () => {
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      return buf
    }
    // The old path: everything, stars included, straight onto the canvas.
    const singlePass = () => {
      camera.layers.enable(STAR_LAYER)
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      camera.layers.set(0)
      return read()
    }
    const baseOnly = () => {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      return read()
    }
    const through = (pipeline) => {
      pipeline.render()
      return read()
    }
    const px = (buf, x, y) => {
      const i = (Math.round(y) * W + Math.round(x)) * 4
      return [buf[i], buf[i + 1], buf[i + 2]]
    }
    const screenOf = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(camera)
      return [(v.x * 0.5 + 0.5) * W, (v.y * 0.5 + 0.5) * H]
    }
    const diffStats = (a, b) => {
      let worst = 0,
        over2 = 0
      for (let i = 0; i < a.length; i++) {
        if ((i & 3) === 3) continue
        const d = Math.abs(a[i] - b[i])
        if (d > worst) worst = d
        if (d > 2) over2++
      }
      return { worst, over2 }
    }
    const lum = (p) => p[0] + p[1] + p[2]

    view.update(1)

    // --- Layers -------------------------------------------------------------
    const a = graph.addNode({ x: 0, y: 0, z: 0 })
    view.sync()
    const mesh = () => scene.getObjectByName('nodes')
    out.meshOnStarLayerOnly = mesh().layers.mask === 1 << STAR_LAYER
    out.cameraDefault = camera.layers.mask === 1

    // --- The canvas pass leaves the stars out -------------------------------
    look(0, 0, 0, 90)
    const withStar = singlePass()
    const base = baseOnly()
    const [cx, cy] = screenOf(0, 0, 0)
    out.singlePassCentre = px(withStar, cx, cy)
    out.baseCentre = px(base, cx, cy)

    // --- Bloom off: the composite reproduces the old single-pass frame ------
    const off = through(noBloom)
    out.offVsSingle = diffStats(off, withStar)

    // --- Stars drawn exactly once per frame ---------------------------------
    let draws = 0
    mesh().onBeforeRender = () => draws++
    bloom.render()
    out.starDrawsPerFrame = draws
    mesh().onBeforeRender = () => {}

    // --- Renderer state restored --------------------------------------------
    const cc = new THREE.Color()
    renderer.getClearColor(cc)
    out.stateRestored =
      camera.layers.mask === 1 &&
      renderer.autoClear === true &&
      cc.getHex() === new THREE.Color(VOID_COLOR).getHex() &&
      renderer.getClearAlpha() === 1 &&
      renderer.getRenderTarget() === null &&
      scene.background === null

    // --- Bloom on: light beyond the billboard, round rather than square ------
    const on = through(bloom)
    const pxPerUnit = (screenOf(NODE_RADIUS, 0, 0)[0] - cx) / NODE_RADIUS
    const ring = (buf, radii) => {
      const d = radii * NODE_RADIUS * pxPerUnit
      return [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
        const ang = (k * Math.PI) / 4 + 0.2
        return lum(px(buf, cx + d * Math.cos(ang), cy + d * Math.sin(ang)))
      })
    }
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
    out.beyondBillboard = [4.5, 6, 8, 12].map((radii) => ({
      radii,
      off: mean(ring(off, radii)),
      on: mean(ring(on, radii)),
      sky: mean(ring(base, radii)),
    }))
    // Axis vs diagonal at 8 radii (well beyond the rays): a box blur would be
    // brighter on the diagonals.
    const axisVsDiag = (radii) => {
      const d = radii * NODE_RADIUS * pxPerUnit
      const at = (ang) =>
        lum(px(on, cx + d * Math.cos(ang), cy + d * Math.sin(ang))) -
        lum(px(off, cx + d * Math.cos(ang), cy + d * Math.sin(ang)))
      return {
        axis: mean([0, 1, 2, 3].map((k) => at((k * Math.PI) / 2))),
        diag: mean([0, 1, 2, 3].map((k) => at((k * Math.PI) / 2 + Math.PI / 4))),
      }
    }
    out.roundness = [6, 9].map(axisVsDiag)
    out.coreStillSaturated = lum(px(on, cx, cy)) >= 750

    // --- Nothing but the stars blooms ---------------------------------------
    const b = graph.addNode({ x: 30, y: 10, z: 0 })
    graph.addEdge(a.id, b.id)
    view.sync()
    view.setHover({ kind: 'node', id: b.id })
    view.setSource(a.id)
    view.setPending(a.id, new THREE.Vector3(-30, -15, 0))
    look(10, 0, 0, 120)
    mesh().visible = false
    const uiBase = baseOnly()
    const uiThrough = through(bloom)
    out.nonStarsUnbloomed = diffStats(uiThrough, uiBase)
    mesh().visible = true
    view.setHover(null)
    view.setSource(null)
    view.setPending(null)

    // --- A scene background is lifted out of the star pass ------------------
    scene.background = new THREE.Color(0x203040)
    sky.object.visible = false
    look(0, 0, 0, 90)
    const bgSingle = singlePass()
    const bgOff = through(noBloom)
    out.backgroundVsSingle = diffStats(bgOff, bgSingle)
    scene.background = null
    sky.object.visible = true

    // --- Resize and pixel ratio: targets follow the drawing buffer -----------
    W = 500
    H = 360
    renderer.setSize(W, H, false)
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    look(0, 0, 0, 90)
    out.resizedVsSingle = diffStats(through(noBloom), singlePass())
    renderer.setPixelRatio(1.5)
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    W = size.x
    H = size.y
    out.ratioSize = [W, H]
    out.ratioVsSingle = diffStats(through(noBloom), singlePass())
    renderer.setPixelRatio(1)
    W = 640
    H = 480
    renderer.setSize(W, H, false)
    camera.aspect = W / H
    camera.updateProjectionMatrix()

    // --- Temporal stability: a distant star crossing pixels in 1/8 steps -----
    // Its bloom (composite minus the bloom-off frame) should keep its total.
    graph.load({
      nodes: [
        {
          id: 'far',
          label: '',
          notes: '',
          links: [],
          x: 0,
          y: 0,
          z: 0,
          cluster_color_id: null,
          is_core: false,
        },
      ],
      edges: [],
    })
    view.sync()
    const dist = 1400
    const unitPx = (() => {
      look(0, 0, 0, dist)
      return screenOf(1, 0, 0)[0] - screenOf(0, 0, 0)[0]
    })()
    const lin = Array.from({ length: 256 }, (_, c) => {
      const v = c / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    const bloomSums = [],
      starSums = []
    for (let s = 0; s < 17; s++) {
      const node = graph.getNode('far')
      node.x = s / 8 / unitPx
      view.syncNodes()
      look(0, 0, 0, dist)
      const withB = through(bloom),
        without = through(noBloom),
        sky0 = ((mesh().visible = false), baseOnly())
      mesh().visible = true
      // In linear light: the encoded difference over-weights faint bloom and
      // is mostly dither.
      let bs = 0,
        ss = 0
      for (let i = 0; i < withB.length; i++) {
        if ((i & 3) === 3) continue
        bs += lin[withB[i]] - lin[without[i]]
        ss += lin[without[i]] - lin[sky0[i]]
      }
      bloomSums.push(bs)
      starSums.push(ss)
    }
    const cv = (xs) => {
      const m = mean(xs)
      return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m
    }
    out.farStarPx = +(NODE_RADIUS * unitPx).toFixed(2)
    out.bloomCV = +cv(bloomSums).toFixed(4)
    out.starCV = +cv(starSums).toFixed(4)
    out.bloomMean = +mean(bloomSums).toFixed(2)

    // --- Sky orientation: bake a direction-coded cube exactly as the nebula
    // is baked, put it under the real sky mesh, and read directions back.
    graph.load({ nodes: [], edges: [] })
    view.sync()
    dust.visible = false
    const skyStars = sky.object.getObjectByName('sky-stars')
    skyStars.visible = false
    const probe = new THREE.WebGLCubeRenderTarget(64, {
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    })
    const probeScene = new THREE.Scene()
    probeScene.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.ShaderMaterial({
          vertexShader:
            'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader:
            'varying vec3 vD; void main(){ gl_FragColor = vec4(normalize(vD) * 0.5 + 0.5, 1.0); }',
          side: THREE.BackSide,
        }),
      ),
    )
    new THREE.CubeCamera(0.1, 10, probe).update(renderer, probeScene)
    const nebula = sky.object.getObjectByName('nebula')
    const realMap = nebula.material.uniforms.map.value
    nebula.material.uniforms.map.value = probe.texture
    const decode = (c) => {
      const s = c / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    let worstAngle = 0
    const raycaster = new THREE.Raycaster()
    for (const [rx, ry, rz] of [
      [0, 0, 0],
      [0.6, 1.9, 0.3],
      [-0.9, -2.7, 0],
      [1.2, 0.4, -0.8],
    ]) {
      camera.position.set(123, -45, 678)
      camera.rotation.set(rx, ry, rz)
      camera.updateMatrixWorld(true)
      const frame = baseOnly()
      for (const [sx, sy] of [
        [0.5, 0.5],
        [0.1, 0.15],
        [0.9, 0.2],
        [0.2, 0.85],
        [0.85, 0.9],
      ]) {
        const p = px(frame, sx * W, sy * H)
        const got = new THREE.Vector3(...p.map((c) => decode(c) * 2 - 1)).normalize()
        raycaster.setFromCamera(new THREE.Vector2(sx * 2 - 1, sy * 2 - 1), camera)
        worstAngle = Math.max(worstAngle, THREE.MathUtils.radToDeg(got.angleTo(raycaster.ray.direction)))
      }
    }
    out.skyWorstAngleDeg = +worstAngle.toFixed(2)
    nebula.material.uniforms.map.value = realMap
    probe.dispose()

    // The brightest sky star lands where its direction projects.
    skyStars.visible = true
    nebula.visible = false
    const lights = skyStars.geometry.getAttribute('light')
    let brightest = 0
    for (let i = 1; i < lights.count; i++)
      if (lights.getX(i) + lights.getY(i) > lights.getX(brightest) + lights.getY(brightest)) brightest = i
    const dir = new THREE.Vector3().fromBufferAttribute(skyStars.geometry.getAttribute('position'), brightest)
    camera.position.set(-300, 200, 50)
    camera.lookAt(camera.position.clone().add(dir))
    camera.rotateZ(0.3)
    camera.rotateY(0.15) // off-centre, so a mirrored or unrotated sky would miss
    camera.updateMatrixWorld(true)
    const starFrame = baseOnly()
    const [ex, ey] = screenOf(...camera.position.clone().addScaledVector(dir, 1000).toArray())
    // The brightest pixel within 8 px of where it should be, and how far off it is.
    let best = { l: -1 }
    for (let y = Math.round(ey) - 8; y <= Math.round(ey) + 8; y++)
      for (let x = Math.round(ex) - 8; x <= Math.round(ex) + 8; x++) {
        const l = lum(px(starFrame, x, y))
        if (l > best.l) best = { l, x, y }
      }
    out.skyStarOffsetPx = +Math.hypot(best.x - ex, best.y - ey).toFixed(2)
    out.skyStarPeak = best.l
    // Mirrored in x, the same star would land somewhere else entirely.
    const mirrored = camera.position.clone().addScaledVector(new THREE.Vector3(-dir.x, dir.y, dir.z), 1000)
    const [mx, my] = screenOf(...mirrored.toArray())
    out.skyStarMirrorApartPx = +Math.hypot(mx - ex, my - ey).toFixed(1)
    nebula.visible = true

    // The band is where it should be: brighter looking along it than at its pole.
    skyStars.visible = false
    const meanFrame = () => {
      const f = baseOnly()
      let s = 0
      for (let i = 0; i < f.length; i += 4) s += f[i] + f[i + 1] + f[i + 2]
      return s / (f.length / 4)
    }
    const N = new THREE.Vector3(0.35, 0.85, 0.4).normalize()
    camera.position.set(0, 0, 0)
    camera.lookAt(N)
    camera.updateMatrixWorld(true)
    const pole = meanFrame()
    camera.lookAt(N.clone().negate())
    camera.updateMatrixWorld(true)
    const pole2 = meanFrame()
    const inBand = new THREE.Vector3(1, 0, 0).cross(N).normalize()
    const bandMeans = [0, 1, 2, 3].map((k) => {
      const d = inBand.clone().applyAxisAngle(N, (k * Math.PI) / 2)
      camera.lookAt(d)
      camera.updateMatrixWorld(true)
      return meanFrame()
    })
    out.poleMeans = [pole, pole2].map((v) => +v.toFixed(1))
    out.bandMeans = bandMeans.map((v) => +v.toFixed(1))
    skyStars.visible = true
    dust.visible = true

    // --- Dust wraps around the camera: there is some wherever you are --------
    sky.object.visible = false
    const dustAt = (x, y, z) => {
      camera.position.set(x, y, z)
      camera.rotation.set(0, 0, 0)
      camera.updateMatrixWorld(true)
      const f = baseOnly()
      let lit = 0
      for (let i = 0; i < f.length; i += 4) if (f[i] + f[i + 1] + f[i + 2] > 3 * 12) lit++
      return lit
    }
    out.dustLit = [dustAt(0, 0, 260), dustAt(50000, -20000, 90000), dustAt(-1e6, 3e5, 7e5)]
    sky.object.visible = true

    // --- Growth past 256: the rebuilt mesh is still on the star layer ---------
    for (let i = 0; i < 300; i++) graph.addNode({ x: i, y: 0, z: 0 })
    view.sync()
    out.grownMeshOnStarLayer = mesh().layers.mask === 1 << STAR_LAYER && mesh().count === 300

    bloom.dispose()
    noBloom.dispose()
    sky.dispose()
    return out
  }, threeUrl)

  expect
    .soft(r.meshOnStarLayerOnly && r.cameraDefault, 'star mesh is on the star layer only; camera on layer 0')
    .toBe(true)
  expect
    .soft(
      Math.max(...r.baseCentre) < 60 && Math.min(...r.singlePassCentre) > 240,
      'canvas pass leaves the star out (sky at its centre)',
    )
    .toBe(true)
  expect
    .soft(r.offVsSingle.worst, 'bloom off reproduces the single-pass frame within 2/255')
    .toBeLessThanOrEqual(2)
  expect.soft(r.starDrawsPerFrame, 'stars drawn exactly once per frame').toBe(1)
  expect.soft(r.stateRestored, 'renderer, camera and scene state restored after a frame').toBe(true)
  expect
    .soft(
      r.beyondBillboard.slice(0, 3).every((s) => s.on > s.off && Math.abs(s.off - s.sky) <= 3),
      'bloom lights the sky beyond the billboard (4.5-8 radii)',
    )
    .toBe(true)
  expect
    .soft(
      r.beyondBillboard.every((s, i, xs) => i === 0 || s.on - s.off <= xs[i - 1].on - xs[i - 1].off),
      'bloom fades with distance',
    )
    .toBe(true)
  expect
    .soft(
      r.roundness.every(({ axis, diag }) => Math.abs(axis - diag) <= 0.25 * Math.max(axis, diag) + 1),
      'bloom is round, not boxy (axis vs diagonal within 25%)',
    )
    .toBe(true)
  expect.soft(r.coreStillSaturated, 'core still saturated with bloom').toBe(true)
  expect
    .soft(r.nonStarsUnbloomed.worst, 'edges, halos, pending line and sky never bloom (frame identical)')
    .toBe(0)
  expect
    .soft(r.backgroundVsSingle.worst, 'a scene background stays out of the star pass')
    .toBeLessThanOrEqual(2)
  expect.soft(r.resizedVsSingle.worst, 'resize: targets follow the canvas').toBeLessThanOrEqual(2)
  expect
    .soft(
      r.ratioVsSingle.worst <= 2 && r.ratioSize[0] === 750,
      'pixel ratio change: targets follow the drawing buffer',
    )
    .toBe(true)
  expect
    .soft(
      r.bloomCV <= r.starCV * 1.1 && r.bloomMean > 0,
      'distant star: bloom varies no more than the star itself under sub-pixel motion',
    )
    .toBe(true)
  expect.soft(r.skyWorstAngleDeg, 'sky samples the world direction (not mirrored), < 3 deg').toBeLessThan(3)
  expect
    .soft(
      r.skyStarOffsetPx <= 1.5 && r.skyStarPeak > 300 && r.skyStarMirrorApartPx > 30,
      'brightest sky star lands where its direction projects',
    )
    .toBe(true)
  expect
    .soft(Math.min(...r.bandMeans), 'band brighter than both poles')
    .toBeGreaterThan(Math.max(...r.poleMeans) * 1.15)
  expect
    .soft(
      r.dustLit.every((n) => n > 5),
      'dust present anywhere in space',
    )
    .toBe(true)
  expect.soft(r.grownMeshOnStarLayer, 'mesh rebuilt past 256 keeps the star layer').toBe(true)
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})

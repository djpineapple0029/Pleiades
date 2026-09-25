// Ported from tests/_rescued/e2e/e2e_view_regress.mjs.
//
// The load path against the real GraphView and the real physics: a map that
// comes back off disk has to render, raycast, and balance like one that was
// built by hand.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, threeModuleUrl } from '../helpers/gestures.js'

test('a loaded map renders, raycasts and balances like a hand-built one', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  const threeUrl = await threeModuleUrl(page)

  const out = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView, NODE_RADIUS } = await import('/src/graphView.js')
    const { createPhysics } = await import('/src/physics.js')
    const { createFiles } = await import('/src/files.js')
    // The original rescued script produced its bytes with a raw fetch to
    // /api/save, which only exists on the Flask server (:5001) — this
    // suite runs against plain Vite (:5180), no backend. localhost is a
    // secure context, so files.js's own client-side WebCrypto path
    // (container.js) is what actually encodes on this origin now; calling
    // it directly is more faithful to current behavior than standing up a
    // second server just to round-trip bytes this test never inspects.
    const { writeContainer } = await import('/src/format/container.js')

    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    document.body.append(canvas)
    const renderer = new THREE.WebGLRenderer({ canvas })
    renderer.setSize(1280, 720, false)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, 1280 / 720, 0.5, 20000)
    camera.layers.enable(1) // session 6: the star mesh is on layer 1 only
    scene.add(camera)

    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    const physics = createPhysics(graph, view)
    const files = createFiles({ graph, view, camera, physics })
    const r = {}

    // A map with a shape worth balancing, saved and reopened for real.
    const ids = []
    for (let i = 0; i < 40; i++)
      ids.push(graph.addNode({ x: (i % 8) * 40 - 140, y: Math.floor(i / 8) * 40 - 80, z: 0 }).id)
    for (let i = 1; i < 40; i++) graph.addEdge(ids[i], ids[Math.floor(i / 3)])
    view.sync()
    files.setCredentials('pw', 'render test')
    const payload = JSON.parse(JSON.stringify(files.toPayload()))

    // Balance is mid-flight when the new file lands — the worst moment for it.
    physics.start()
    for (let i = 0; i < 5; i++) physics.update()
    r.wasRunning = physics.isRunning

    const blob = await writeContainer(payload, 'pw')

    // A different, smaller map to land on top of it, reusing the same ids.
    const other = createGraph()
    const oa = other.addNode({ x: -60, y: 0, z: 0, label: 'left' })
    const ob = other.addNode({ x: 60, y: 0, z: 0, label: 'right' })
    other.addEdge(oa.id, ob.id)
    const otherBytes = await writeContainer(
      { ...other.toPayload(), camera: { position: [0, 0, 200], rotation: [0, 0, 0] } },
      'pw',
    )
    const openResult = await files.open(new File([otherBytes], 'other.atlasmap'), 'pw')
    r.openResult = openResult
    r.balanceStopped = physics.isRunning === false
    r.nodeCount = graph.nodes.size
    r.edgeCount = graph.edges.size

    renderer.render(scene, camera)
    r.rendered = true

    // The loaded nodes and the loaded edge must both be pickable. Camera looks
    // down -Z from +Z, so the crosshair sits on the edge's midpoint at (0,0,0).
    camera.position.set(0, 0, 300)
    camera.rotation.set(0, 0, 0)
    camera.updateMatrixWorld(true)
    renderer.render(scene, camera)
    const raycaster = new THREE.Raycaster()

    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
    r.midpointHit = view.raycast(raycaster)

    // And straight at a node: project its world position back to NDC.
    const target = graph.getNode(oa.id)
    const ndc = new THREE.Vector3(target.x, target.y, target.z).project(camera)
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
    r.nodeHit = view.raycast(raycaster)
    r.nodeHitIsLeft = r.nodeHit?.id === oa.id

    // Balancing a freshly loaded graph exercises the seed ordering: the previous
    // run's links still pointed at bodies that no longer exist.
    const before = { x: graph.getNode(oa.id).x, y: graph.getNode(oa.id).y, z: graph.getNode(oa.id).z }
    r.restarted = physics.start()
    for (let i = 0; i < 60; i++) physics.update()
    const after = graph.getNode(oa.id)
    r.moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) > 0.5
    r.finite = [after.x, after.y, after.z].every(Number.isFinite)

    // Edges must still be pickable after physics has moved everything.
    camera.position.set(
      (graph.getNode(oa.id).x + graph.getNode(ob.id).x) / 2,
      (graph.getNode(oa.id).y + graph.getNode(ob.id).y) / 2,
      (graph.getNode(oa.id).z + graph.getNode(ob.id).z) / 2 + 300,
    )
    camera.rotation.set(0, 0, 0)
    camera.updateMatrixWorld(true)
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
    r.midpointHitAfterSettle = view.raycast(raycaster)

    // Finally, the original 40-node file back over the top of the small one.
    const back = await files.open(new File([blob], 'render test.atlasmap'), 'pw')
    r.backResult = back
    r.backNodeCount = graph.nodes.size
    r.backEdgeCount = graph.edges.size
    r.backRestart = physics.start()
    for (let i = 0; i < 20; i++) physics.update()
    r.backFinite = [...graph.nodes.values()].every(
      (n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z),
    )
    r.nodeRadius = NODE_RADIUS
    return r
  }, threeUrl)

  expect.soft(out.rendered, 'WebGL renderer came up and drew').toBe(true)
  expect.soft(out.wasRunning, 'balance was running when the file landed').toBe(true)
  expect.soft(out.openResult?.ok, 'open succeeded').toBe(true)
  expect.soft(out.balanceStopped, 'loading stopped the balance run').toBe(true)
  expect.soft(out.nodeCount === 2 && out.edgeCount === 1, 'graph replaced by the loaded one').toBe(true)
  expect.soft(out.midpointHit?.kind, 'loaded edge is pickable at its midpoint').toBe('edge')
  expect.soft(out.nodeHit?.kind === 'node' && out.nodeHitIsLeft, 'loaded node is pickable').toBe(true)
  expect.soft(out.restarted, 'a loaded graph can be balanced').toBe(true)
  expect.soft(out.moved, 'balancing moves loaded nodes').toBe(true)
  expect.soft(out.finite, 'positions stay finite').toBe(true)
  expect.soft(out.midpointHitAfterSettle?.kind, 'edges still pickable after a settle').toBe('edge')
  expect.soft(out.backResult?.ok, 'second load succeeded').toBe(true)
  expect
    .soft(out.backNodeCount === 40 && out.backEdgeCount === 39, '40-node map restored over the small one')
    .toBe(true)
  expect.soft(out.backRestart === true && out.backFinite === true, 'and balances without NaN').toBe(true)
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})

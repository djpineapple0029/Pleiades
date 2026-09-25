// Ported from tests/_rescued/e2e/smoke.mjs.
//
// Does labels.js run at all: shaders compile, labels place, leaders get
// instances, the font lands. The original script only printed JSON for a
// human to eyeball — no check()/assertions at all — so this adds real
// assertions from what its own comments and printed fields describe, rather
// than dropping the coverage. labels.spec.js covers the detailed behavior;
// this stays a fast compile/placement smoke test.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, threeModuleUrl } from '../helpers/gestures.js'

test('labels compile and place: font, shaders, instances', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  const threeUrl = await threeModuleUrl(page)

  const out = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView } = await import('/src/graphView.js')
    const { LABEL_LAYER } = await import('/src/bloom.js')
    document.getElementById('viewport').remove()
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:800px;height:600px'
    document.body.append(canvas)
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(1)
    renderer.setSize(800, 600, false)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, 800 / 600, 0.5, 20000)
    scene.add(camera)
    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    await document.fonts.ready

    const core = graph.addNode({ x: 0, y: 0, z: 0, label: 'Quarterly plan' })
    const near = graph.addNode({ x: 90, y: 20, z: 0, label: 'Hiring' })
    graph.addNode({ x: 40, y: -30, z: -900, label: 'distant idea' })
    graph.addEdge(core.id, near.id)
    graph.setCore(core.id, true)
    view.sync()
    camera.position.set(40, 0, 260)
    camera.lookAt(40, 0, 0)
    camera.updateMatrixWorld(true)
    let clock = 10
    for (let i = 0; i < 40; i++) view.update((clock += 0.05), camera)

    const mesh = scene.getObjectByName('labels')
    const leaders = scene.getObjectByName('labelLeaders')
    // Force a compile and catch any shader error as a console message.
    camera.layers.set(LABEL_LAYER)
    renderer.render(scene, camera)
    camera.layers.set(0)
    const programs = renderer.info.programs.map((p) => p.name)

    view.setHover({ kind: 'node', id: near.id })
    for (let i = 0; i < 20; i++) view.update((clock += 0.05), camera)
    const hovered = view.labelsShown().find((l) => l.id === near.id)

    return {
      fontLoaded: document.fonts.check(`400 40px Jost`),
      shown: view.labelsShown().map((l) => ({ id: l.id, text: l.text, tier: l.tier })),
      instances: [mesh.geometry.instanceCount, leaders.geometry.instanceCount],
      visible: [mesh.visible, leaders.visible],
      programs,
      hoveredText: hovered?.text,
      renderCalls:
        ((renderer.info.autoReset = false),
        renderer.info.reset(),
        camera.layers.set(LABEL_LAYER),
        renderer.render(scene, camera),
        camera.layers.set(0),
        renderer.info.render.calls),
    }
  }, threeUrl)

  expect.soft(out.fontLoaded, 'the Jost face used to raster labels is loaded').toBe(true)
  expect.soft(out.shown.length, 'both nodes with a label are shown (the far one is out of range)').toBe(2)
  expect
    .soft(
      out.shown.some((l) => l.tier === 'core'),
      'the core node is shown at the core tier',
    )
    .toBe(true)
  expect.soft(out.instances[0], 'the name mesh got at least one instance').toBeGreaterThan(0)
  expect.soft(out.instances[1], 'the leader mesh got at least one instance').toBeGreaterThan(0)
  expect.soft(out.visible[0] && out.visible[1], 'both meshes are visible with labels on screen').toBe(true)
  expect.soft(out.programs.length, 'the label shaders compiled without throwing').toBeGreaterThan(0)
  expect.soft(out.hoveredText, 'the hovered node reports its text').toBe('Hiring')
  expect.soft(out.renderCalls, 'the label layer draws in exactly two calls (names, leaders)').toBe(2)
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})

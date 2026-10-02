// The map's Yjs doc (context/MOONSHOT.md) against the real GraphView and
// physics: after ordinary edits, a real Balance run, undo, redo and an open,
// the doc and the graph hold the same map.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, threeModuleUrl } from '../helpers/gestures.js'

test('doc and graph agree after spawn, connect, rename, Balance, undo, redo and open', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  const threeUrl = await threeModuleUrl(page)

  const out = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView } = await import('/src/graphView.js')
    const { createPhysics } = await import('/src/physics.js')
    const { createFiles } = await import('/src/files.js')
    const { createMapDoc } = await import('/src/mapDoc.js')
    const { createDocBridge } = await import('/src/docBridge.js')
    const { createUndo } = await import('/src/undo.js')
    const { createCommands } = await import('/src/commands.js')

    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 240
    document.body.append(canvas)
    const renderer = new THREE.WebGLRenderer({ canvas })
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, 4 / 3, 0.5, 20000)
    scene.add(camera)

    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    const physics = createPhysics(graph, view)
    const mapDoc = createMapDoc()
    const undo = createUndo({ mapDoc, graph })
    createDocBridge({ mapDoc, graph, view, physics })
    const files = createFiles({ graph, view, camera, physics, mapDoc })
    const commands = createCommands({ graph, view, physics, mapDoc, undo })

    const byId = (p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)
    // Field order differs between a Y.Map and a graph node; values must not.
    const canon = (value) =>
      Array.isArray(value)
        ? value.map(canon)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((k) => [k, canon(value[k])]),
            )
          : value
    const same = (p, q) =>
      JSON.stringify(canon([...p].sort(byId))) === JSON.stringify(canon([...q].sort(byId)))
    const agree = () => {
      const { nodes, edges } = graph.toPayload()
      return (
        same(
          [...mapDoc.nodes.values()].map((n) => n.toJSON()),
          nodes,
        ) &&
        same(
          [...mapDoc.edges.values()].map((e) => e.toJSON()),
          edges,
        )
      )
    }
    const balance = () => {
      commands.toggleBalance()
      for (let i = 0; i < 10_000 && physics.isRunning; i++) physics.update()
    }
    const r = { steps: [] }
    const check = (name) => r.steps.push([name, agree()])

    const a = commands.spawn({ x: 0, y: 0, z: 0 })
    const b = commands.spawn({ x: 20, y: 0, z: 0 })
    const c = commands.spawn({ x: 0, y: 20, z: 0 })
    commands.connect(a.id, b.id)
    commands.connect(b.id, c.id)
    check('edits')
    commands.setNodeText(a.id, 'Alpha', 'notes ✦')
    commands.toggleCore(b.id)
    check('text and kind')
    r.idShape = /^n-[0-9a-z]{10}$/.test(a.id)
    const before = graph.getNode(a.id).x
    balance()
    r.moved = graph.getNode(a.id).x !== before
    check('balance')
    r.undoLabel = commands.undo()
    r.backAfterUndo = graph.getNode(a.id).x === before
    check('undo balance')
    commands.redo()
    check('redo balance')
    commands.deleteNode(b.id)
    check('delete')
    commands.undo()
    r.linksBack = graph.degree(b.id)
    check('undo delete')
    files.applyPayload({ ...graph.toPayload(), camera: { position: [0, 0, 100] } })
    commands.clear()
    check('open')
    commands.spawn({ x: 5, y: 5, z: 5 })
    check('edit after open')
    return r
  }, threeUrl)

  for (const [name, same] of out.steps) expect.soft(same, `doc and graph agree: ${name}`).toBe(true)
  expect.soft(out.idShape, 'a new star gets a random id').toBe(true)
  expect.soft(out.moved, 'the Balance moved the stars').toBe(true)
  expect.soft(out.undoLabel, 'one undo takes the whole Balance back').toBe('balance')
  expect.soft(out.backAfterUndo, 'and puts them where they were').toBe(true)
  expect.soft(out.linksBack, 'undoing a delete brings its links back').toBe(2)
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})

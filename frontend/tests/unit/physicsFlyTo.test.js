// physics.flyTo: someone else's layout eases in (docBridge.js, MOONSHOT.md),
// with no recluster and no reblend — their Balance chose the colours already.
import { describe, it, expect } from 'vitest'
import { createGraph } from '../../src/graph.js'
import { sequentialIds } from '../../src/ids.js'
import { createPhysics } from '../../src/physics.js'

const view = { syncNodes() {}, updateEdgePositions() {} }

function setup() {
  const graph = createGraph({ newId: sequentialIds() })
  const a = graph.addNode({ x: 0, y: 0, z: 0 })
  const b = graph.addNode({ x: 10, y: 0, z: 0 })
  graph.addEdge(a.id, b.id)
  return { graph, physics: createPhysics(graph, view), a, b }
}

const land = (physics) => {
  for (let i = 0; i < 10_000 && physics.isRunning; i++) physics.update()
}

describe('physics.flyTo', () => {
  it('flies the named stars to their targets and leaves the rest', () => {
    const { graph, physics, a, b } = setup()
    physics.flyTo(new Map([[a.id, [5, 6, 7]]]))
    expect(physics.isRunning).toBe(true)
    physics.update()
    expect(graph.getNode(a.id).x).toBeGreaterThan(0)
    expect(graph.getNode(a.id).x).toBeLessThan(5)
    land(physics)
    expect([graph.getNode(a.id).x, graph.getNode(a.id).y, graph.getNode(a.id).z]).toEqual([5, 6, 7])
    expect(graph.getNode(b.id).x).toBe(10)
  })

  it('never reblends or touches the saved state when it lands', () => {
    const { graph, physics, a } = setup()
    const token = graph.contentRevision
    physics.flyTo(new Map([[a.id, [5, 0, 0]]]))
    land(physics)
    expect(graph.getNode(a.id).blend).toBeNull()
    expect(graph.contentRevision).toBe(token)
  })

  it('stopped early, the stars land where they were going', () => {
    const { graph, physics, a } = setup()
    physics.flyTo(new Map([[a.id, [5, 0, 0]]]))
    physics.update()
    physics.stop()
    expect(physics.isRunning).toBe(false)
    expect(graph.getNode(a.id).x).toBe(5)
  })

  it('a star deleted mid-flight is dropped, a new one holds still', () => {
    const { graph, physics, a, b } = setup()
    physics.flyTo(new Map([[a.id, [5, 0, 0]]]))
    graph.removeNode(b.id)
    const c = graph.addNode({ x: -3, y: 0, z: 0 })
    expect(() => physics.invalidate()).not.toThrow()
    land(physics)
    expect(graph.getNode(c.id).x).toBe(-3)
    expect(graph.getNode(a.id).x).toBe(5)
  })

  it('replaces a local run in flight, which then never settles', () => {
    const { graph, physics, a } = setup()
    expect(physics.start()).toBe(true)
    physics.flyTo(new Map([[a.id, [1, 1, 1]]]))
    land(physics)
    expect(graph.getNode(a.id).x).toBe(1)
    expect(graph.getNode(a.id).blend).toBeNull() // the abandoned Balance never faded colours
  })

  it('a second remote move mid-flight keeps the first flight going', () => {
    const { graph, physics, a, b } = setup()
    physics.flyTo(new Map([[a.id, [5, 0, 0]]]))
    physics.update()
    physics.flyTo(new Map([[b.id, [20, 0, 0]]]))
    land(physics)
    expect(graph.getNode(a.id).x).toBe(5)
    expect(graph.getNode(b.id).x).toBe(20)
  })

  it("says whether the run in flight is this tab's own", () => {
    const { physics, a } = setup()
    expect(physics.isLocalRun).toBe(false)
    physics.start()
    expect(physics.isLocalRun).toBe(true)
    physics.flyTo(new Map([[a.id, [1, 1, 1]]]))
    expect(physics.isLocalRun).toBe(false)
  })
})

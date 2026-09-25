// riverFlow.js: the dust-river simulation. Pure, so it runs against a real
// `createGraph()` model with radii read straight from `sizeOf`.
import { describe, it, expect } from 'vitest'
import { createGraph } from '../../src/graph.js'
import { createRiverFlow } from '../../src/riverFlow.js'

const RADIUS = 5

function setup(build) {
  const graph = createGraph()
  build(graph)
  const flow = createRiverFlow(graph, { radiusOf: (id) => RADIUS * graph.sizeOf(id) })
  return { graph, flow }
}

/** A chain a - b - c - d along x, plus an unlinked node far off. */
function chain(graph) {
  const ids = []
  for (let i = 0; i < 4; i++) ids.push(graph.addNode({ x: i * 120, y: 0, z: 0 }).id)
  for (let i = 0; i < 3; i++) graph.addEdge(ids[i], ids[i + 1])
  const lone = graph.addNode({ x: 0, y: 900, z: 0 }).id
  return { ids, lone }
}

function run(flow, seconds, dt = 1 / 30, shocks) {
  for (let s = 0; s < seconds; s += dt) flow.step(dt, shocks)
}

function linked(graph, a, b) {
  for (const edge of graph.edges.values()) {
    if ((edge.from === a && edge.to === b) || (edge.from === b && edge.to === a)) return edge.id
  }
  return null
}

describe('riverFlow', () => {
  it('grains only ever travel along links that exist', () => {
    const { graph, flow } = setup(chain)
    let transits = 0
    for (let frame = 0; frame < 900; frame++) {
      flow.step(1 / 30)
      for (let g = 0; g < flow.count; g++) {
        const grain = flow.grain(g)
        if (grain.phase !== 'transit') continue
        transits++
        expect(linked(graph, grain.node, grain.to)).toBe(grain.edge)
      }
    }
    expect(transits).toBeGreaterThan(0)
  })

  it('positions stay finite and near the map', () => {
    const { flow } = setup(chain)
    run(flow, 20)
    for (let g = 0; g < flow.count; g++) {
      if (flow.light[g] === 0) continue
      const [x, y, z] = flow.positions.subarray(g * 3, g * 3 + 3)
      for (const v of [x, y, z]) expect(Number.isFinite(v)).toBe(true)
      expect(x).toBeGreaterThan(-100)
      expect(x).toBeLessThan(460)
      expect(Math.abs(z)).toBeLessThan(100)
    }
  })

  it('heat is high on a star and low mid-river', () => {
    const { flow } = setup(chain)
    run(flow, 10)
    for (let g = 0; g < flow.count; g++) {
      const h = flow.heat[g]
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(1)
    }
    const hot = [...flow.heat.subarray(0, flow.count)].filter((h) => h > 0.5).length
    const cold = [...flow.heat.subarray(0, flow.count)].filter((h) => h < 0.1).length
    expect(hot).toBeGreaterThan(0)
    expect(cold).toBeGreaterThan(0)
  })

  it('cores gather more dust than plain stars', () => {
    // A star: a core in the middle with six leaves, the same again with a plain
    // centre, far apart.
    const { graph, flow } = setup((g) => {
      for (const [cx, core] of [[0, true], [2000, false]]) {
        const hub = g.addNode({ x: cx, y: 0, z: 0 })
        if (core) g.setCore(hub.id, true)
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2
          const leaf = g.addNode({ x: cx + 100 * Math.cos(a), y: 100 * Math.sin(a), z: 0 })
          g.addEdge(hub.id, leaf.id)
        }
      }
    })
    run(flow, 30)
    const core = [...graph.nodes.values()].find((n) => n.is_core)
    const plain = [...graph.nodes.values()].find((n) => n.x === 2000)
    let atCore = 0
    let atPlain = 0
    for (let g = 0; g < flow.count; g++) {
      const grain = flow.grain(g)
      if (grain.phase !== 'orbit' || flow.light[g] === 0) continue
      if (grain.node === core.id) atCore++
      if (grain.node === plain.id) atPlain++
    }
    expect(atCore).toBeGreaterThan(atPlain * 1.5)
  })

  it('an unlinked star keeps its grains orbiting', () => {
    const { flow, graph } = setup(chain)
    const lone = [...graph.nodes.values()].find((n) => n.y === 900).id
    run(flow, 15)
    let orbiting = 0
    for (let g = 0; g < flow.count; g++) {
      const grain = flow.grain(g)
      if (grain.node !== lone) continue
      expect(grain.phase).not.toBe('transit')
      if (grain.phase === 'orbit') orbiting++
    }
    expect(orbiting).toBeGreaterThan(0)
  })

  it('after a delete no grain is on the removed node or its links, and dust carries on', () => {
    const { graph, flow } = setup(chain)
    run(flow, 10)
    const victim = [...graph.nodes.keys()][1]
    graph.removeNode(victim)
    flow.step(1 / 30)
    // Grains that were on it are frozen and fading, not following anything.
    for (let g = 0; g < flow.count; g++) {
      const grain = flow.grain(g)
      if (grain.dying === 2) continue
      if (grain.phase === 'dead') continue
      expect(grain.node).not.toBe(victim)
      expect(grain.to).not.toBe(victim)
      if (grain.edge) expect(graph.getEdge(grain.edge)).not.toBeNull()
    }
    run(flow, 3)
    for (let g = 0; g < flow.count; g++) {
      const grain = flow.grain(g)
      if (grain.phase === 'dead') continue
      expect(grain.node).not.toBe(victim)
      expect(grain.to).not.toBe(victim)
    }
    const lit = [...flow.light.subarray(0, flow.count)].filter((l) => l > 0).length
    expect(lit).toBeGreaterThan(50)
  })

  it('an empty map has no dust, and a cleared one drains', () => {
    const graph = createGraph()
    const flow = createRiverFlow(graph, { radiusOf: () => RADIUS })
    flow.step(1 / 30)
    expect(flow.count).toBe(0)
    const a = graph.addNode({ x: 0, y: 0, z: 0 })
    run(flow, 2)
    expect(flow.count).toBeGreaterThan(0)
    graph.removeNode(a.id)
    run(flow, 3)
    expect(flow.count).toBe(0)
  })

  it('a shock pushes nearby grains outward, and the push dies away', () => {
    const { flow } = setup((g) => g.addNode({ x: 0, y: 0, z: 0 }))
    run(flow, 3)
    const before = []
    for (let g = 0; g < flow.count; g++) before.push(Math.hypot(...flow.positions.subarray(g * 3, g * 3 + 3)))
    const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length
    const shock = { x: 0, y: 0, z: 0, radius: 15, width: 10, strength: 400 }
    run(flow, 0.3, 1 / 30, [shock])
    const pushed = []
    for (let g = 0; g < flow.count; g++) pushed.push(Math.hypot(...flow.positions.subarray(g * 3, g * 3 + 3)))
    expect(mean(pushed)).toBeGreaterThan(mean(before) + 5)
    run(flow, 5)
    const after = []
    for (let g = 0; g < flow.count; g++) after.push(Math.hypot(...flow.positions.subarray(g * 3, g * 3 + 3)))
    expect(mean(after)).toBeLessThan(mean(before) + 2)
  })

  it('is the same every run for the same seed', () => {
    const a = setup(chain).flow
    const b = setup(chain).flow
    run(a, 5)
    run(b, 5)
    expect([...a.positions.subarray(0, 300)]).toEqual([...b.positions.subarray(0, 300)])
  })
})

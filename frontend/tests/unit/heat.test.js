// heat.js: connection counts through nexuses, and the 0..1 scale.
import { describe, it, expect } from 'vitest'
import { createGraph } from '../../src/graph.js'
import { reach, heatFor, hotCount, HOT_FLOOR } from '../../src/heat.js'

function star(graph, label) {
  return graph.addNode({ x: 0, y: 0, z: 0, label }).id
}

describe('reach', () => {
  // A, B, C, D share nexus N; D also links straight to E; N2 is a nexus hanging
  // off N (a chain of nexuses) with F on it.
  const g = createGraph()
  const [a, b, c, d, e, f] = ['A', 'B', 'C', 'D', 'E', 'F'].map((l) => star(g, l))
  const n = star(g, 'N')
  const n2 = star(g, 'N2')
  g.setNexus(n, true)
  g.setNexus(n2, true)
  for (const id of [a, b, c, d, n2]) g.addEdge(id, n)
  g.addEdge(n2, f)
  g.addEdge(d, e)

  const names = (ids) => [...ids].map((id) => g.getNode(id).label).sort()

  it('a star reaches every star on its nexus, and across a nexus chain', () =>
    expect(names(g.connectionsOf(a))).toEqual(['B', 'C', 'D', 'F']))
  it('direct links count as well', () => expect(names(g.connectionsOf(d))).toEqual(['A', 'B', 'C', 'E', 'F']))
  it('a nexus counts the stars it joins, never nexuses', () =>
    expect(names(g.connectionsOf(n))).toEqual(['A', 'B', 'C', 'D', 'F']))
  it('never includes itself', () => expect(g.connectionsOf(a).has(a)).toBe(false))
  it('an unknown id reaches nothing', () => expect(g.connectionsOf('zz').size).toBe(0))
  it('matches the pure walk', () => expect(reach(e, g.nodes, g.neighbours)).toEqual(new Set([d])))

  it('heat is higher for the busier star', () => expect(g.heatOf(d)).toBeGreaterThan(g.heatOf(e)))
  it('heat cache follows edits', () => {
    const before = g.heatOf(e)
    g.addEdge(e, a)
    expect(g.heatOf(e)).toBeGreaterThan(before)
  })
})

describe('scale', () => {
  it('nothing connected, or one link, is cold', () => {
    expect(heatFor(0, HOT_FLOOR)).toBe(0)
    expect(heatFor(1, HOT_FLOOR)).toBe(0)
  })
  it('the hot count is fully hot, and beyond clamps', () => {
    expect(heatFor(HOT_FLOOR, HOT_FLOOR)).toBe(1)
    expect(heatFor(50, HOT_FLOOR)).toBe(1)
  })
  it('a map of one- and two-link nodes stays cool', () => {
    const hot = hotCount([1, 2, 1, 2, 2, 1])
    expect(hot).toBe(HOT_FLOOR)
    expect(heatFor(2, hot)).toBeLessThan(0.55)
  })
  it('a map of big hubs scales to its own 95th percentile', () => {
    const counts = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(hotCount(counts)).toBe(96)
  })
  it('one new hub does not change the scale of a big map much', () => {
    const counts = Array.from({ length: 100 }, () => 3)
    expect(hotCount([...counts, 200])).toBe(HOT_FLOOR)
  })
})

describe('focusOf', () => {
  // A — N(nexus) — B, N — C; A — D directly; D — E (two hops, not kept);
  // B — C directly (a link between two focused stars, but not A's).
  const g = createGraph()
  const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map((l) => star(g, l))
  const n = star(g, 'N')
  g.setNexus(n, true)
  const an = g.addEdge(a, n).id
  const nb = g.addEdge(n, b).id
  const nc = g.addEdge(n, c).id
  const ad = g.addEdge(a, d).id
  const de = g.addEdge(d, e).id
  const bc = g.addEdge(b, c).id
  const focus = g.focusOf(a)

  it('keeps the star, its neighbours, and the stars across a nexus', () =>
    expect(focus.nodes).toEqual(new Set([a, n, b, c, d])))
  it("keeps its own links and the nexus's, not its neighbours' other links", () => {
    expect(focus.edges).toEqual(new Set([an, nb, nc, ad]))
    expect(focus.edges.has(de) || focus.edges.has(bc)).toBe(false)
  })
  it('an unknown id keeps nothing', () => expect(g.focusOf('zz').nodes.size).toBe(0))
})

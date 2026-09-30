import { describe, expect, it } from 'vitest'
import { computeOrbit } from '../../src/orbit.js'
import { orbitFocus, shortestPath } from '../../src/paths.js'

/** A tiny graph with graph.js's shape: nodes, edges and neighbours(). */
function graphOf(ids, pairs) {
  const nodes = new Map(ids.map((id, i) => [id, { id, x: i * 10, y: 5, z: -3, cluster_color_id: 0 }]))
  const edges = new Map(pairs.map(([from, to], i) => [`e${i}`, { id: `e${i}`, from, to }]))
  const neighbours = function* (id) {
    for (const edge of edges.values()) {
      if (edge.from === id) yield edge.to
      else if (edge.to === id) yield edge.from
    }
  }
  return { nodes, edges, neighbours }
}

// a - b - c - d, a - e, e - c (a second way round), f on its own.
const g = graphOf(
  ['a', 'b', 'c', 'd', 'e', 'f'],
  [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['a', 'e'],
    ['e', 'c'],
  ],
)
const collideOf = () => 13

describe('computeOrbit', () => {
  it('keeps the centre where it is and puts each ring further out, flat in the given plane', () => {
    const right = [1, 0, 0]
    const up = [0, 0, 1]
    const positions = computeOrbit(g.nodes, g.neighbours, 'a', { collideOf, right, up })
    expect(positions.size).toBe(6)
    const a = g.nodes.get('a')
    expect(positions.get('a')).toEqual([a.x, a.y, a.z])
    const r = (id) => Math.hypot(...positions.get(id).map((v, k) => v - [a.x, a.y, a.z][k]))
    expect(r('b')).toBeCloseTo(r('e'), 6)
    expect(r('c')).toBeGreaterThan(r('b'))
    expect(r('d')).toBeGreaterThan(r('c'))
    expect(r('f')).toBeGreaterThan(r('d')) // never reached: the outer ring
    // Flat: nothing moves off the plane through the centre.
    for (const p of positions.values()) expect(p[1]).toBeCloseTo(a.y, 6)
  })

  it('spaces a ring of many leaves so none sit on top of each other', () => {
    const leaves = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const star = graphOf(
      ['hub', ...leaves],
      leaves.map((id) => ['hub', id]),
    )
    const positions = computeOrbit(star.nodes, star.neighbours, 'hub', { collideOf })
    const points = leaves.map((id) => positions.get(id))
    let nearest = Infinity
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++)
        nearest = Math.min(nearest, Math.hypot(...points[i].map((v, k) => v - points[j][k])))
    expect(nearest).toBeGreaterThan(2 * 13)
  })
})

describe('paths', () => {
  it('finds the fewest-links path, with its edges in order', () => {
    const path = shortestPath(g, 'b', 'd')
    expect(path.nodes).toEqual(['b', 'c', 'd'])
    expect(path.edges).toEqual(['e1', 'e2'])
    expect(shortestPath(g, 'a', 'f')).toBeNull()
    expect(shortestPath(g, 'a', 'a')).toEqual({ nodes: ['a'], edges: [] })
  })

  it('orbit focus is the breadth-first tree and the first two rings', () => {
    const focus = orbitFocus(g, 'a')
    // One tree link per reached star: b, e, c (through b, found first), d.
    expect(focus.edges.size).toBe(4)
    expect(focus.edges.has('e4')).toBe(false) // e - c is not on the tree
    expect([...focus.nodes].sort()).toEqual(['a', 'b', 'c', 'e'])
  })
})

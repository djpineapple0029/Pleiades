import { describe, expect, it } from 'vitest'
import { computeBackbone } from '../../src/backbone.js'
import { computeTreeLayout } from '../../src/treeLayout.js'
import { computeArcs, LANE_POINTS } from '../../src/lanes.js'

function mapOf(ids, pairs, cores = []) {
  const nodes = new Map(
    ids.map((id, i) => [
      id,
      { id, x: i * 7, y: (i * 13) % 5, z: 0, is_core: cores.includes(id), cluster_color_id: 1 },
    ]),
  )
  const edges = new Map(pairs.map(([from, to], i) => [`e${i}`, { id: `e${i}`, from, to }]))
  return { nodes, edges }
}

// Two cores A and B; a-b-c hang off A, d off B; c-d links the two trees;
// x-y is a pair no core reaches; z is on its own.
const map = mapOf(
  ['A', 'a', 'b', 'c', 'B', 'd', 'x', 'y', 'z'],
  [
    ['A', 'a'],
    ['a', 'b'],
    ['b', 'c'],
    ['B', 'd'],
    ['c', 'd'],
    ['x', 'y'],
    ['A', 'b'],
  ],
  ['A', 'B'],
)

describe('computeBackbone', () => {
  it('hangs every star off its nearest core, and the rest off roots of their own', () => {
    const { parent, root, roots, branch, cross } = computeBackbone(map.nodes, map.edges)
    expect(roots.slice(0, 2).sort()).toEqual(['A', 'B'])
    expect(root.get('c')).toBe('A') // through b, two links from A
    expect(root.get('d')).toBe('B')
    expect(parent.get('b')).toBe('A') // A-b is a link: one step, not two through a
    expect(root.get('y')).toBe(root.get('x'))
    expect(roots).toContain('z')
    // Every link is exactly one of the two kinds; one parent link per non-root star.
    expect(branch.size + cross.size).toBe(map.edges.size)
    expect(branch.size).toBe(map.nodes.size - roots.length)
    expect(cross.has('e4')).toBe(true) // c-d joins two trees
    expect(cross.has('e1')).toBe(true) // a-b: b already hangs off A directly
  })
})

describe('computeTreeLayout', () => {
  for (const shape of ['disc', 'cone'])
    it(`${shape}: every star placed and finite, the disc flat`, () => {
      const { positions } = computeTreeLayout(map.nodes, map.edges, { collideOf: () => 13, shape })
      expect(positions.size).toBe(map.nodes.size)
      for (const p of positions.values()) expect(p.every(Number.isFinite)).toBe(true)
      if (shape === 'disc') {
        const ys = [...positions.values()].map((p) => p[1])
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6)
      }
    })
})

describe('computeArcs', () => {
  it('one curve per cross-link, from star to star, bowed off the straight line', () => {
    const { cross } = computeBackbone(map.nodes, map.edges)
    const routes = computeArcs(map.nodes, map.edges, cross)
    expect(routes.size).toBe(cross.size)
    for (const [id, route] of routes) {
      const edge = map.edges.get(id)
      const a = map.nodes.get(edge.from)
      const b = map.nodes.get(edge.to)
      expect(route.length).toBe(LANE_POINTS * 3)
      expect([...route.slice(0, 3)]).toEqual([a.x, a.y, a.z].map(Math.fround))
      expect([...route.slice(-3)]).toEqual([b.x, b.y, b.z].map(Math.fround))
      const m = Math.floor(LANE_POINTS / 2) * 3
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2]
      expect(Math.hypot(route[m] - mid[0], route[m + 1] - mid[1], route[m + 2] - mid[2])).toBeGreaterThan(0)
    }
  })
})

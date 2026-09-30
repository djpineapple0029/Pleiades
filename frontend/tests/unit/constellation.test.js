import { describe, expect, it } from 'vitest'
import { computeConstellation } from '../../src/constellation.js'
import { computeLanes, LANE_POINTS } from '../../src/lanes.js'
import { seededRandom } from '../../src/random.js'

const COLLIDE = 13

/** `groups` communities of `size` stars, densely linked inside, a few links between. */
function clusteredMap(groups, size, crossLinks = 2) {
  const random = seededRandom(7)
  const nodes = new Map()
  const edges = new Map()
  let edgeId = 0
  const link = (a, b) => edges.set(`e${edgeId}`, { id: `e${edgeId++}`, from: a, to: b })
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < size; i++) {
      const id = `g${g}n${i}`
      // Everyone starts tangled on top of each other.
      nodes.set(id, { id, x: random() * 20, y: random() * 20, z: random() * 20, cluster_color_id: g + 1 })
      if (i > 0) link(id, `g${g}n${Math.floor(random() * i)}`)
      if (i > 2) link(id, `g${g}n${Math.floor(random() * i)}`)
    }
  }
  for (let g = 1; g < groups; g++)
    for (let k = 0; k < crossLinks; k++) link(`g${g}n${k}`, `g${g - 1}n${size - 1 - k}`)
  return { nodes, edges }
}

const layout = (map, options = {}) =>
  computeConstellation(map.nodes, map.edges, { collideOf: () => COLLIDE, baseCollide: COLLIDE, ...options })

describe('computeConstellation', () => {
  for (const arrangement of ['free', 'shell', 'disc'])
    for (const inner of ['force', 'rings', 'subgroups'])
      it(`${arrangement}/${inner}: every star placed, finite, no two groups' balls overlapping`, () => {
        const map = clusteredMap(5, 24)
        const { positions, groups } = layout(map, { arrangement, inner })
        expect(positions.size).toBe(map.nodes.size)
        for (const p of positions.values()) expect(p.every(Number.isFinite)).toBe(true)
        for (let i = 0; i < groups.length; i++)
          for (let j = i + 1; j < groups.length; j++) {
            const a = groups[i]
            const b = groups[j]
            const d = Math.hypot(...a.centre.map((v, k) => v - b.centre[k]))
            expect(d).toBeGreaterThan(a.radius + b.radius)
          }
      })

  it('stars of a group sit inside its ball', () => {
    const map = clusteredMap(4, 15)
    const { positions, groups } = layout(map)
    for (const group of groups)
      for (const id of group.ids) {
        const p = positions.get(id)
        expect(Math.hypot(...p.map((v, k) => v - group.centre[k]))).toBeLessThanOrEqual(group.radius + 1e-6)
      }
  })

  it('is deterministic, and ignores where the stars were except for the centre', () => {
    const a = clusteredMap(3, 12)
    const b = clusteredMap(3, 12)
    for (const node of b.nodes.values()) {
      node.x = 500 - node.x
      node.y *= -1
    }
    const first = layout(a).positions
    const again = layout(a).positions
    for (const [id, p] of first) expect(again.get(id)).toEqual(p)
    // Same shape from a different start, just moved to the other map's centre.
    const moved = layout(b).positions
    const shift = (map) => [0, 1, 2].map((k) => [...map.values()].reduce((s, p) => s + p[k], 0) / map.size)
    const [ca, cb] = [shift(first), shift(moved)]
    for (const [id, p] of first) {
      const q = moved.get(id)
      for (let k = 0; k < 3; k++) expect(q[k] - cb[k]).toBeCloseTo(p[k] - ca[k], 6)
    }
  })

  it('puts a bridge star between its two groups', () => {
    const map = clusteredMap(2, 10, 0)
    // n5 of group 1 links three times into group 2 as well as into its own.
    for (let k = 0; k < 3; k++) map.edges.set(`b${k}`, { id: `b${k}`, from: 'g0n5', to: `g1n${k}` })
    const { positions, groups, bridges } = layout(map)
    expect(bridges.map((b) => b.id)).toContain('g0n5')
    const [a, b] = groups
    const p = positions.get('g0n5')
    const dA = Math.hypot(...p.map((v, k) => v - a.centre[k]))
    const dB = Math.hypot(...p.map((v, k) => v - b.centre[k]))
    expect(dA).toBeGreaterThan(a.radius)
    expect(dB).toBeGreaterThan(b.radius)
  })

  it('copes with one group, no groups, and no links', () => {
    const one = clusteredMap(1, 8)
    expect(layout(one).positions.size).toBe(8)
    const loose = { nodes: new Map(), edges: new Map() }
    for (let i = 0; i < 5; i++)
      loose.nodes.set(`n${i}`, { id: `n${i}`, x: 0, y: 0, z: 0, cluster_color_id: 0 })
    const { positions } = layout(loose)
    expect(positions.size).toBe(5)
    for (const p of positions.values()) expect(p.every(Number.isFinite)).toBe(true)
  })
})

describe('computeLanes', () => {
  it('routes only links between two groups, from one star to the other', () => {
    const map = clusteredMap(3, 12)
    const { positions } = layout(map)
    for (const [id, p] of positions) Object.assign(map.nodes.get(id), { x: p[0], y: p[1], z: p[2] })
    const routes = computeLanes(map.nodes, map.edges)
    expect(routes.size).toBeGreaterThan(0)
    for (const [id, route] of routes) {
      const edge = map.edges.get(id)
      const from = map.nodes.get(edge.from)
      const to = map.nodes.get(edge.to)
      expect(from.cluster_color_id).not.toBe(to.cluster_color_id)
      expect(route.length).toBe(LANE_POINTS * 3)
      expect([...route.slice(0, 3)]).toEqual([from.x, from.y, from.z].map(Math.fround))
      expect([...route.slice(-3)]).toEqual([to.x, to.y, to.z].map(Math.fround))
      expect(route.every(Number.isFinite)).toBe(true)
    }
  })
})

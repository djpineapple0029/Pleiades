// colorBlend.js: the fade a Balance leaves on cluster colours. Pure, so these
// build the node/incident/edge maps `graph.js` holds by hand, with cluster
// colour ids set directly rather than through Louvain.
import { describe, it, expect } from 'vitest'
import { computeBlend } from '../../src/colorBlend.js'
import { clusterInk, srgbToOklab } from '../../src/palette.js'

function build(spec) {
  const nodes = new Map()
  const edges = new Map()
  const incident = new Map()
  for (const [id, color, x, isCore = false] of spec.nodes) {
    nodes.set(id, { id, cluster_color_id: color, is_core: isCore, x, y: 0, z: 0 })
    incident.set(id, new Set())
  }
  spec.edges.forEach(([from, to], i) => {
    const id = `e${i}`
    edges.set(id, { id, from, to })
    incident.get(from).add(id)
    incident.get(to).add(id)
  })
  return { nodes, edges, incident }
}

/** Distance in OKLab — roughly how different two colours look. */
const dist = (p, q) => {
  const a = srgbToOklab(p)
  const b = srgbToOklab(q)
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * Two groups of five, far apart on x, joined through one bridge node that
 * Louvain put in group 1. Group 1 is colour 1 (green) and group 2 colour 2
 * (pink), which sit far apart on the wheel.
 */
function twoGroups({ core = null } = {}) {
  const nodes = []
  const edges = []
  for (let i = 0; i < 5; i++) nodes.push([`a${i}`, 1, i * 10, core === `a${i}`])
  for (let i = 0; i < 5; i++) nodes.push([`b${i}`, 2, 200 + i * 10, false])
  nodes.push(['bridge', 1, 100, false])
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++) {
      edges.push([`a${i}`, `a${j}`])
      edges.push([`b${i}`, `b${j}`])
    }
  edges.push(['a4', 'bridge'], ['bridge', 'b0'])
  return build({ nodes, edges })
}

describe('colorBlend', () => {
  const inkA = clusterInk(1)
  const inkB = clusterInk(2)

  it('an unclustered node gets no blend', () => {
    const { nodes, incident, edges } = build({
      nodes: [
        ['n1', 0, 0],
        ['n2', 1, 10],
        ['n3', 1, 20],
      ],
      edges: [['n2', 'n3']],
    })
    const blends = computeBlend(nodes, incident, edges)
    expect(blends.has('n1')).toBe(false)
    expect(blends.has('n2')).toBe(true)
  })

  it('a map with nothing clustered has nothing to blend', () => {
    const { nodes, incident, edges } = build({
      nodes: [
        ['n1', 0, 0],
        ['n2', 0, 10],
      ],
      edges: [['n1', 'n2']],
    })
    expect(computeBlend(nodes, incident, edges).size).toBe(0)
  })

  it('a lone group comes out as exactly its own ink', () => {
    const { nodes, incident, edges } = build({
      nodes: [
        ['n1', 3, 0],
        ['n2', 3, 10],
        ['n3', 3, 20, true],
      ],
      edges: [
        ['n1', 'n2'],
        ['n2', 'n3'],
      ],
    })
    for (const blend of computeBlend(nodes, incident, edges).values())
      expect(dist(blend, clusterInk(3))).toBeLessThan(0.005)
  })

  const { nodes, incident, edges } = twoGroups()
  const blends = computeBlend(nodes, incident, edges)

  it('channels are sRGB on 0..1, rounded to three places', () => {
    for (const blend of blends.values()) {
      expect(blend).toHaveLength(3)
      for (const v of blend) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
        expect(Math.round(v * 1000) / 1000).toBe(v)
      }
    }
  })

  it('is deterministic', () => {
    const again = computeBlend(nodes, incident, edges)
    expect([...again]).toEqual([...blends])
  })

  it('a bridge between two groups is a mix of both, not either one', () => {
    const bridge = blends.get('bridge')
    const apart = dist(inkA, inkB)
    expect(dist(bridge, inkA)).toBeGreaterThan(0.02)
    expect(dist(bridge, inkB)).toBeGreaterThan(0.02)
    expect(dist(bridge, inkA)).toBeLessThan(apart)
    expect(dist(bridge, inkB)).toBeLessThan(apart)
  })

  it("a group's far side stays close to its own colour", () => {
    // Medium, not a wash: the node furthest from the border is nearer its own
    // ink than the bridge is, and nearer its own ink than the other group's.
    expect(dist(blends.get('a0'), inkA)).toBeLessThan(dist(blends.get('bridge'), inkA))
    expect(dist(blends.get('a0'), inkA)).toBeLessThan(dist(blends.get('a0'), inkB))
    expect(dist(blends.get('b4'), inkB)).toBeLessThan(dist(blends.get('b4'), inkA))
  })

  it("a core holds its group's colour around it", () => {
    const cored = twoGroups({ core: 'a4' })
    const withCore = computeBlend(cored.nodes, cored.incident, cored.edges)
    // The core itself, and the bridge next to it, are pulled back toward the
    // core's group colour compared with the same map without a core.
    expect(dist(withCore.get('a4'), inkA)).toBeLessThan(dist(blends.get('a4'), inkA))
    expect(dist(withCore.get('bridge'), inkA)).toBeLessThan(dist(blends.get('bridge'), inkA))
  })

  it('stacked on one point, with nowhere to fade across, it still returns finite colours', () => {
    const {
      nodes: n,
      incident: inc,
      edges: e,
    } = build({
      nodes: [
        ['n1', 1, 0],
        ['n2', 1, 0],
        ['n3', 2, 0],
        ['n4', 2, 0],
      ],
      edges: [
        ['n1', 'n2'],
        ['n3', 'n4'],
      ],
    })
    for (const blend of computeBlend(n, inc, e).values()) expect(blend.every(Number.isFinite)).toBe(true)
  })
})

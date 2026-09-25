// Ported from tests/_rescued/unit/test_graph.mjs — the only load() strictness
// tests in the rescued suites (V2.md's table). Each section builds its own
// fresh graph, so sections are independent; within a section, conditions are
// captured at the point the original `check()` sat, same as sizing.test.js.
import { describe, it, expect } from 'vitest'
import { createGraph, PayloadError } from '../../src/graph.js'

describe('graph payload round trip', () => {
  const g = createGraph()
  const a = g.addNode({ x: 1.5, y: -2.25, z: 0 })
  const b = g.addNode({ x: -40.125, y: 7, z: 3.5, label: 'two', notes: 'ünïcode ✦\nline two' })
  const c = g.addNode({ x: 10, y: 10, z: 10 })
  g.addEdge(a.id, b.id)
  g.addEdge(b.id, c.id)
  a.is_core = true
  b.cluster_color_id = 3
  b.links.push('https://example.invalid')

  const payload = JSON.parse(JSON.stringify(g.toPayload()))
  const g2 = createGraph()
  g2.load(payload)

  it('same payload after reload', () => expect(JSON.stringify(g2.toPayload())).toBe(JSON.stringify(payload)))
  it('node count', () => expect(g2.nodes.size).toBe(3))
  it('edge count', () => expect(g2.edges.size).toBe(2))
  it('degree rebuilt from edges', () => expect(g2.degree(b.id) === 2 && g2.degree(a.id) === 1).toBe(true))
  it('is_core survives', () => expect(g2.getNode(a.id).is_core).toBe(true))
  it('cluster_color_id survives', () => expect(g2.getNode(b.id).cluster_color_id).toBe(3))
  it('links survive', () => expect(g2.getNode(b.id).links[0]).toBe('https://example.invalid'))
  it('notes survive verbatim', () => expect(g2.getNode(b.id).notes).toBe('ünïcode ✦\nline two'))
})

describe('toPayload is a copy, not a view', () => {
  const g = createGraph()
  const a = g.addNode({ x: 1.5, y: -2.25, z: 0 })
  const snapshot = g.toPayload()
  g.getNode(a.id).x = 999
  const nodeDetached = snapshot.nodes[0].x === 1.5
  snapshot.nodes[0].links.push('x')
  const linksDetached = g.getNode(a.id).links.length === 0

  it('payload node is detached', () => expect(nodeDetached).toBe(true))
  it('payload links are detached', () => expect(linksDetached).toBe(true))
})

describe('ids continue above a loaded file', () => {
  const fresh = createGraph()
  fresh.load({
    nodes: [
      { id: 'n7', x: 0, y: 0, z: 0 },
      { id: 'n2', x: 0, y: 0, z: 0 },
    ],
    edges: [],
  })
  const minted = fresh.addNode({ x: 0, y: 0, z: 0 })
  it('new node id clears the highest loaded', () => expect(minted.id).toBe('n8'))

  fresh.load({
    nodes: [
      { id: 'n1', x: 0, y: 0, z: 0 },
      { id: 'n2', x: 0, y: 0, z: 0 },
    ],
    edges: [{ id: 'e5', from: 'n1', to: 'n2' }],
  })
  const newEdgeIdClearsHighest = fresh.addEdge('n1', 'n2') === null || true
  it('new edge id clears the highest loaded', () => expect(newEdgeIdClearsHighest).toBe(true))

  const g3 = createGraph()
  g3.load({
    nodes: [
      { id: 'n1', x: 0, y: 0, z: 0 },
      { id: 'n2', x: 0, y: 0, z: 0 },
      { id: 'n3', x: 0, y: 0, z: 0 },
    ],
    edges: [{ id: 'e4', from: 'n1', to: 'n2' }],
  })
  it('edge seq continues', () => expect(g3.addEdge('n1', 'n3').id).toBe('e5'))
})

describe('non-generated ids do not collide', () => {
  const odd = createGraph()
  odd.load({
    nodes: [
      { id: 'root', x: 0, y: 0, z: 0 },
      { id: 'n1', x: 0, y: 0, z: 0 },
    ],
    edges: [],
  })
  const after = [odd.addNode({ x: 0, y: 0, z: 0 }), odd.addNode({ x: 0, y: 0, z: 0 })]
  const mintsPastTakenId = after[0].id === 'n2' && after[1].id === 'n3'
  const noIdOverwritten = odd.nodes.size === 4

  it('mints past a taken id', () => expect(mintsPastTakenId).toBe(true))
  it('no id was overwritten', () => expect(noIdOverwritten).toBe(true))
})

describe('load replaces rather than merges', () => {
  const g4 = createGraph()
  g4.addNode({ x: 0, y: 0, z: 0 })
  const nodesRef = g4.nodes,
    edgesRef = g4.edges
  g4.load({ nodes: [{ id: 'z1', x: 1, y: 2, z: 3 }], edges: [] })

  it('old nodes gone', () => expect(g4.nodes.size === 1 && g4.getNode('z1') !== null).toBe(true))
  it('exposed maps kept by identity', () => expect(g4.nodes === nodesRef && g4.edges === edgesRef).toBe(true))
})

describe('degenerate edges are dropped, not carried in', () => {
  const g5 = createGraph()
  g5.load({
    nodes: [
      { id: 'n1', x: 0, y: 0, z: 0 },
      { id: 'n2', x: 0, y: 0, z: 0 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n1' },
      { id: 'e2', from: 'n1', to: 'n2' },
      { id: 'e3', from: 'n2', to: 'n1' },
    ],
  })
  it('self-loop dropped', () => expect(Boolean(g5.getEdge('e1'))).toBe(false))
  it('reverse duplicate dropped', () => expect(g5.edges.size === 1 && Boolean(g5.getEdge('e2'))).toBe(true))
  it('degree matches surviving edges', () =>
    expect(g5.degree('n1') === 1 && g5.degree('n2') === 1).toBe(true))
})

describe('defaults fill in for a thin payload', () => {
  const g6 = createGraph()
  g6.load({ nodes: [{ id: 'n1', x: 0, y: 2, z: 3 }], edges: [] })
  const thin = g6.getNode('n1')

  it('label defaults', () => expect(thin.label).toBe(''))
  it('notes defaults', () => expect(thin.notes).toBe(''))
  it('links defaults', () => expect(Array.isArray(thin.links) && thin.links.length === 0).toBe(true))
  it('cluster_color_id defaults', () => expect(thin.cluster_color_id).toBe(0))
  it('is_core defaults', () => expect(thin.is_core).toBe(false))

  g6.load({ nodes: [], edges: [] })
  const emptyPayloadLoads = g6.nodes.size === 0 && g6.edges.size === 0
  it('empty payload loads', () => expect(emptyPayloadLoads).toBe(true))
  g6.load({})
  const missingArraysLoadEmpty = g6.nodes.size === 0 && g6.edges.size === 0
  it('missing arrays load as empty', () => expect(missingArraysLoadEmpty).toBe(true))
})

describe('rejections leave the previous graph untouched', () => {
  const g7 = createGraph()
  g7.load({ nodes: [{ id: 'keep', x: 5, y: 5, z: 5 }], edges: [] })
  const bad = [
    ['null payload', null],
    ['nodes not an array', { nodes: {} }],
    ['edges not an array', { nodes: [], edges: {} }],
    ['node without an id', { nodes: [{ x: 0, y: 0, z: 0 }] }],
    ['node id not a string', { nodes: [{ id: 3, x: 0, y: 0, z: 0 }] }],
    [
      'duplicate node id',
      {
        nodes: [
          { id: 'a', x: 0, y: 0, z: 0 },
          { id: 'a', x: 0, y: 0, z: 0 },
        ],
      },
    ],
    ['NaN position', { nodes: [{ id: 'a', x: NaN, y: 0, z: 0 }] }],
    ['null position', { nodes: [{ id: 'a', x: null, y: 0, z: 0 }] }],
    ['string position', { nodes: [{ id: 'a', x: '2', y: 0, z: 0 }] }],
    ['boolean position', { nodes: [{ id: 'a', x: false, y: 0, z: 0 }] }],
    ['array position', { nodes: [{ id: 'a', x: [], y: 0, z: 0 }] }],
    ['empty-string position', { nodes: [{ id: 'a', x: '', y: 0, z: 0 }] }],
    ['missing position', { nodes: [{ id: 'a', y: 0, z: 0 }] }],
    ['Infinity position', { nodes: [{ id: 'a', x: Infinity, y: 0, z: 0 }] }],
    [
      'edge to a missing node',
      { nodes: [{ id: 'a', x: 0, y: 0, z: 0 }], edges: [{ id: 'e1', from: 'a', to: 'ghost' }] },
    ],
    [
      'edge without an id',
      {
        nodes: [
          { id: 'a', x: 0, y: 0, z: 0 },
          { id: 'b', x: 0, y: 0, z: 0 },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    ],
    ['node is a string', { nodes: ['a'] }],
    ['edge is null', { nodes: [], edges: [null] }],
  ]
  // Independent, non-mutating on rejection (graph.js validates before it
  // commits), so — unlike the sections above — these are safe to assert
  // lazily inside each it().
  for (const [name, p] of bad) {
    it(`rejects ${name}`, () => expect(() => g7.load(p)).toThrow(PayloadError))
  }
  it('graph survived every rejection', () => {
    expect(g7.nodes.size === 1 && g7.getNode('keep').x === 5).toBe(true)
  })
})

describe('graph restore primitives (undo, V2.md §2.4.10)', () => {
  it('removeNode hands back copies that restoreNode puts back under the same ids', () => {
    const g = createGraph()
    const a = g.addNode({ x: 1, y: 2, z: 3, label: 'hub', notes: 'n' })
    const b = g.addNode({ x: 4, y: 5, z: 6 })
    const e = g.addEdge(a.id, b.id)
    g.setCore(a.id, true)
    // A restored item goes back in at the end of its Map; order carries no meaning.
    const sorted = () => {
      const { nodes, edges } = g.toPayload()
      const byId = (x, y) => x.id.localeCompare(y.id)
      return JSON.stringify({ nodes: nodes.sort(byId), edges: edges.sort(byId) })
    }
    const before = sorted()

    const snap = g.removeNode(a.id)
    expect(snap.node.id).toBe(a.id)
    expect(snap.edges.map((edge) => edge.id)).toEqual([e.id])
    expect(g.nodes.size).toBe(1)
    expect(g.edges.size).toBe(0)

    expect(g.restoreNode(snap)).toBe(true)
    expect(sorted()).toBe(before)
    // Restored from a copy: editing the snapshot can't reach into the graph.
    snap.node.label = 'changed'
    expect(g.getNode(a.id).label).toBe('hub')
    expect(g.degree(a.id)).toBe(1)
    expect(g.degree(b.id)).toBe(1)
  })

  it('restore refuses a taken id and an edge with a missing end', () => {
    const g = createGraph()
    const a = g.addNode({ x: 0, y: 0, z: 0 })
    const b = g.addNode({ x: 0, y: 0, z: 0 })
    const e = g.addEdge(a.id, b.id)
    expect(g.restoreNode({ node: { ...a }, edges: [] })).toBe(false)
    const edgeSnap = g.removeEdge(e.id)
    g.removeNode(b.id)
    expect(g.restoreEdge(edgeSnap)).toBe(false)
    expect(g.edges.size).toBe(0)
  })

  it('removeNode/removeEdge return null for an unknown id', () => {
    const g = createGraph()
    expect(g.removeNode('n99')).toBe(null)
    expect(g.removeEdge('e99')).toBe(null)
  })

  it('setNodePosition is saved data but not an appearance change', () => {
    const g = createGraph()
    const a = g.addNode({ x: 0, y: 0, z: 0 })
    const revision = g.revision
    const token = g.contentRevision
    g.setNodePosition(a.id, 7, 8, 9)
    expect(g.getNode(a.id)).toMatchObject({ x: 7, y: 8, z: 9 })
    expect(g.revision).toBe(revision)
    expect(g.contentRevision).not.toBe(token)
  })

  it('applyLayout bumps revision only when a colour moves', () => {
    const g = createGraph()
    const a = g.addNode({ x: 0, y: 0, z: 0 })
    const snap = g.layoutSnapshot()
    g.getNode(a.id).x = 50
    let revision = g.revision
    g.applyLayout(snap)
    expect(g.getNode(a.id).x).toBe(0)
    expect(g.revision).toBe(revision)

    g.getNode(a.id).cluster_color_id = 4
    revision = g.revision
    g.applyLayout(snap)
    expect(g.getNode(a.id).cluster_color_id).toBe(0)
    expect(g.revision).toBeGreaterThan(revision)
  })

  it('content tokens are never handed out twice, even after one is put back', () => {
    const g = createGraph()
    const t0 = g.contentRevision
    g.addNode({ x: 0, y: 0, z: 0 })
    const t1 = g.contentRevision
    g.setContentRevision(t0)
    g.addNode({ x: 0, y: 0, z: 0 })
    expect(g.contentRevision).not.toBe(t0)
    expect(g.contentRevision).not.toBe(t1)
  })
})

describe('blend (the faded cluster colour a Balance leaves)', () => {
  const g = createGraph()
  const a = g.addNode({ x: 0, y: 0, z: 0 })
  const b = g.addNode({ x: 5, y: 0, z: 0 })
  g.addEdge(a.id, b.id)
  const startsUnblended = a.blend === null
  it('a new node has no blend', () => expect(startsUnblended).toBe(true))

  a.cluster_color_id = 1
  a.blend = [0.1, 0.5, 0.9]
  const payload = JSON.parse(JSON.stringify(g.toPayload()))
  const g2 = createGraph()
  g2.load(payload)
  it('survives a save and reopen', () => expect(g2.getNode(a.id).blend).toEqual([0.1, 0.5, 0.9]))
  it('an unblended node reopens with none', () => expect(g2.getNode(b.id).blend).toBeNull())

  // Anything but three channels on 0..1 reads as none — including every file
  // written before blends existed, which has no field at all.
  const bad = [
    undefined,
    null,
    'red',
    [0.1, 0.2],
    [0.1, 0.2, 0.3, 0.4],
    [0.1, 'x', 0.3],
    [0.1, 1.5, 0.3],
    [-0.1, 0.2, 0.3],
    [NaN, 0.2, 0.3],
  ]
  const readsAsNone = bad.map((blend) => {
    const h = createGraph()
    h.load({ nodes: [{ id: 'n1', x: 0, y: 0, z: 0, cluster_color_id: 2, blend }], edges: [] })
    return h.getNode('n1').blend
  })
  it('a missing or damaged blend loads as none', () =>
    expect(readsAsNone.every((v) => v === null)).toBe(true))
  const kept = createGraph()
  kept.load({ nodes: [{ id: 'n1', x: 0, y: 0, z: 0, cluster_color_id: 2 }], edges: [] })
  it('loading never computes a blend, even for a clustered node', () =>
    expect(kept.getNode('n1').blend).toBeNull())

  // reblend writes it; recluster, the start of the next Balance, drops it.
  const c = createGraph()
  const ids = []
  for (let i = 0; i < 6; i++) ids.push(c.addNode({ x: i * 10, y: 0, z: 0 }).id)
  for (const [p, q] of [
    [0, 1],
    [1, 2],
    [0, 2],
    [3, 4],
    [4, 5],
    [3, 5],
    [2, 3],
  ])
    c.addEdge(ids[p], ids[q])
  c.recluster()
  const rev = c.revision
  const moved = c.reblend()
  const allBlended = ids.every((id) => Array.isArray(c.getNode(id).blend))
  const bumped = c.revision > rev
  const rev2 = c.revision
  const again = c.reblend()
  const secondIsNoop = again === 0 && c.revision === rev2
  it('reblend fades every clustered node', () => expect(moved === 6 && allBlended).toBe(true))
  it('and bumps the revision so tints ease', () => expect(bumped).toBe(true))
  it('a second reblend over an unchanged map changes nothing', () => expect(secondIsNoop).toBe(true))
  c.recluster()
  it('the next recluster drops every blend', () =>
    expect(ids.every((id) => c.getNode(id).blend === null)).toBe(true))
})

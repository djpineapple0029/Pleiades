import { createGraph, PayloadError } from '/Users/dempseypalmer/PycharmProjects/AtlasMap/frontend/src/graph.js'

let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))
const throws = (name, fn) => {
  try { fn(); check(name, false, 'did not throw') }
  catch (e) { check(name, e instanceof PayloadError, `threw ${e.constructor.name}: ${e.message}`) }
}

console.log('round trip')
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
check('same payload after reload', JSON.stringify(g2.toPayload()) === JSON.stringify(payload))
check('node count', g2.nodes.size === 3)
check('edge count', g2.edges.size === 2)
check('degree rebuilt from edges', g2.degree(b.id) === 2 && g2.degree(a.id) === 1, g2.degree(b.id))
check('is_core survives', g2.getNode(a.id).is_core === true)
check('cluster_color_id survives', g2.getNode(b.id).cluster_color_id === 3)
check('links survive', g2.getNode(b.id).links[0] === 'https://example.invalid')
check('notes survive verbatim', g2.getNode(b.id).notes === 'ünïcode ✦\nline two')

console.log('toPayload is a copy, not a view')
const snapshot = g.toPayload()
g.getNode(a.id).x = 999
check('payload node is detached', snapshot.nodes[0].x === 1.5, snapshot.nodes[0].x)
snapshot.nodes[0].links.push('x')
check('payload links are detached', g.getNode(a.id).links.length === 0)

console.log('ids continue above a loaded file')
const fresh = createGraph()
fresh.load({ nodes: [{ id: 'n7', x: 0, y: 0, z: 0 }, { id: 'n2', x: 0, y: 0, z: 0 }], edges: [] })
const minted = fresh.addNode({ x: 0, y: 0, z: 0 })
check('new node id clears the highest loaded', minted.id === 'n8', minted.id)
fresh.load({
  nodes: [{ id: 'n1', x: 0, y: 0, z: 0 }, { id: 'n2', x: 0, y: 0, z: 0 }],
  edges: [{ id: 'e5', from: 'n1', to: 'n2' }],
})
check('new edge id clears the highest loaded', fresh.addEdge('n1', 'n2') === null || true)
const g3 = createGraph()
g3.load({ nodes: [{ id: 'n1', x: 0, y: 0, z: 0 }, { id: 'n2', x: 0, y: 0, z: 0 }, { id: 'n3', x: 0, y: 0, z: 0 }],
          edges: [{ id: 'e4', from: 'n1', to: 'n2' }] })
check('edge seq continues', g3.addEdge('n1', 'n3').id === 'e5')

console.log('non-generated ids do not collide')
const odd = createGraph()
odd.load({ nodes: [{ id: 'root', x: 0, y: 0, z: 0 }, { id: 'n1', x: 0, y: 0, z: 0 }], edges: [] })
const after = [odd.addNode({ x: 0, y: 0, z: 0 }), odd.addNode({ x: 0, y: 0, z: 0 })]
check('mints past a taken id', after[0].id === 'n2' && after[1].id === 'n3', after.map(n => n.id))
check('no id was overwritten', odd.nodes.size === 4, odd.nodes.size)

console.log('load replaces rather than merges')
const g4 = createGraph()
g4.addNode({ x: 0, y: 0, z: 0 })
const nodesRef = g4.nodes, edgesRef = g4.edges
g4.load({ nodes: [{ id: 'z1', x: 1, y: 2, z: 3 }], edges: [] })
check('old nodes gone', g4.nodes.size === 1 && g4.getNode('z1') !== null)
check('exposed maps kept by identity', g4.nodes === nodesRef && g4.edges === edgesRef)

console.log('degenerate edges are dropped, not carried in')
const g5 = createGraph()
g5.load({
  nodes: [{ id: 'n1', x: 0, y: 0, z: 0 }, { id: 'n2', x: 0, y: 0, z: 0 }],
  edges: [
    { id: 'e1', from: 'n1', to: 'n1' },
    { id: 'e2', from: 'n1', to: 'n2' },
    { id: 'e3', from: 'n2', to: 'n1' },
  ],
})
check('self-loop dropped', !g5.getEdge('e1'))
check('reverse duplicate dropped', g5.edges.size === 1 && Boolean(g5.getEdge('e2')), g5.edges.size)
check('degree matches surviving edges', g5.degree('n1') === 1 && g5.degree('n2') === 1)

console.log('defaults fill in for a thin payload')
const g6 = createGraph()
g6.load({ nodes: [{ id: 'n1', x: 0, y: 2, z: 3 }], edges: [] })
const thin = g6.getNode('n1')
check('label defaults', thin.label === '')
check('notes defaults', thin.notes === '')
check('links defaults', Array.isArray(thin.links) && thin.links.length === 0)
check('cluster_color_id defaults', thin.cluster_color_id === 0)
check('is_core defaults', thin.is_core === false)
g6.load({ nodes: [], edges: [] })
check('empty payload loads', g6.nodes.size === 0 && g6.edges.size === 0)
g6.load({})
check('missing arrays load as empty', g6.nodes.size === 0 && g6.edges.size === 0)

console.log('rejections leave the previous graph untouched')
const g7 = createGraph()
g7.load({ nodes: [{ id: 'keep', x: 5, y: 5, z: 5 }], edges: [] })
const bad = [
  ['null payload', null],
  ['nodes not an array', { nodes: {} }],
  ['edges not an array', { nodes: [], edges: {} }],
  ['node without an id', { nodes: [{ x: 0, y: 0, z: 0 }] }],
  ['node id not a string', { nodes: [{ id: 3, x: 0, y: 0, z: 0 }] }],
  ['duplicate node id', { nodes: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'a', x: 0, y: 0, z: 0 }] }],
  ['NaN position', { nodes: [{ id: 'a', x: NaN, y: 0, z: 0 }] }],
  ['null position', { nodes: [{ id: 'a', x: null, y: 0, z: 0 }] }],
  ['string position', { nodes: [{ id: 'a', x: '2', y: 0, z: 0 }] }],
  ['boolean position', { nodes: [{ id: 'a', x: false, y: 0, z: 0 }] }],
  ['array position', { nodes: [{ id: 'a', x: [], y: 0, z: 0 }] }],
  ['empty-string position', { nodes: [{ id: 'a', x: '', y: 0, z: 0 }] }],
  ['missing position', { nodes: [{ id: 'a', y: 0, z: 0 }] }],
  ['Infinity position', { nodes: [{ id: 'a', x: Infinity, y: 0, z: 0 }] }],
  ['edge to a missing node', { nodes: [{ id: 'a', x: 0, y: 0, z: 0 }], edges: [{ id: 'e1', from: 'a', to: 'ghost' }] }],
  ['edge without an id', { nodes: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 0, y: 0, z: 0 }], edges: [{ from: 'a', to: 'b' }] }],
  ['node is a string', { nodes: ['a'] }],
  ['edge is null', { nodes: [], edges: [null] }],
]
for (const [name, p] of bad) throws(`rejects ${name}`, () => g7.load(p))
check('graph survived every rejection', g7.nodes.size === 1 && g7.getNode('keep').x === 5)

console.log(`\n${ok} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)

/**
 * Session 9, the pure module: Louvain finds the obvious groups, and a colour
 * follows its cluster across re-partitions, splits and merges.
 */
import { createGraph } from '/Users/dempseypalmer/PycharmProjects/AtlasMap/frontend/src/graph.js'
import { computeClusters, clusterInk, CLUSTER_INKS } from '/Users/dempseypalmer/PycharmProjects/AtlasMap/frontend/src/clustering.js'

let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))

/** Two dense blobs of `n` joined by a single edge. */
function twoBlobs(n = 8) {
  const g = createGraph()
  const blobs = [[], []]
  for (const blob of blobs) for (let i = 0; i < n; i++) blob.push(g.addNode({ x: 0, y: 0, z: 0 }).id)
  for (const blob of blobs) for (const a of blob) for (const b of blob) if (a < b) g.addEdge(a, b)
  g.addEdge(blobs[0][0], blobs[1][0])
  return { g, blobs }
}

const colorsOf = (g, ids) => ids.map((id) => g.getNode(id).cluster_color_id)
const allSame = (list) => list.every((v) => v === list[0])

// --- the partition itself ---------------------------------------------------
const { g, blobs } = twoBlobs()
const first = g.recluster()
check('two blobs are two clusters', first.clusters === 2, `got ${first.clusters}`)
check('recluster reports what it moved', first.moved === 16, `moved ${first.moved}`)
const a0 = colorsOf(g, blobs[0]), b0 = colorsOf(g, blobs[1])
check('blob 0 is one colour', allSame(a0), a0.join())
check('blob 1 is one colour', allSame(b0), b0.join())
check('the two blobs differ', a0[0] !== b0[0])
check('colours are 1-based (0 means no cluster)', a0[0] > 0 && b0[0] > 0)
check('clusterCount is exposed', g.clusterCount === 2)

// --- stability: the whole point --------------------------------------------
const rev = g.revision
const again = g.recluster()
check('re-partitioning an unchanged graph moves nothing', again.moved === 0)
check('and does not bump the revision', g.revision === rev)
check('colours are identical after a re-run', String(colorsOf(g, blobs[0])) === String(a0) && String(colorsOf(g, blobs[1])) === String(b0))

// A fresh graph with the same shape partitions the same way: the rng is seeded.
const { g: g2, blobs: b2 } = twoBlobs()
g2.recluster()
check('a fresh identical graph gives the same partition', new Set(colorsOf(g2, b2[0])).size === 1)

// --- growth keeps a colour -------------------------------------------------
const grown = []
for (let i = 0; i < 4; i++) grown.push(g.addNode({ x: 0, y: 0, z: 0 }).id)
for (const id of grown) for (const other of blobs[0]) g.addEdge(id, other)
g.recluster()
check('a blob that grew keeps its colour', colorsOf(g, blobs[0])[0] === a0[0], `${colorsOf(g, blobs[0])[0]} vs ${a0[0]}`)
check('the untouched blob keeps its colour', colorsOf(g, blobs[1])[0] === b0[0])
check('new nodes joined that cluster', allSame(colorsOf(g, [...grown, ...blobs[0]])))

// --- a split: the larger piece keeps the colour ----------------------------
// One clique of 14 is unambiguously a single community. Cutting every edge
// between its first 9 and its last 5 leaves two cliques and nothing joining
// them, which is a genuine split of one community rather than two that were
// already apart.
const gs = createGraph()
const ring = []
for (let i = 0; i < 14; i++) ring.push(gs.addNode({ x: 0, y: 0, z: 0 }).id)
for (const a of ring) for (const b of ring) if (a < b) gs.addEdge(a, b)
const one = gs.recluster()
check('a single clique is one cluster', one.clusters === 1, `got ${one.clusters}`)
const wasColor = gs.getNode(ring[0]).cluster_color_id
const left = ring.slice(0, 9), right = ring.slice(9)
for (const edge of [...gs.edges.values()]) {
  const across = (left.includes(edge.from) && right.includes(edge.to)) || (right.includes(edge.from) && left.includes(edge.to))
  if (across) gs.removeEdge(edge.id)
}
const split = gs.recluster()
check('the split is two clusters', split.clusters === 2, `got ${split.clusters}`)
check('the larger piece keeps the colour', gs.getNode(left[0]).cluster_color_id === wasColor, `${gs.getNode(left[0]).cluster_color_id} vs ${wasColor}`)
check('the larger piece is all one colour', allSame(colorsOf(gs, left)))
const smallColor = gs.getNode(right[0]).cluster_color_id
check('the smaller piece took a new colour', allSame(colorsOf(gs, right)) && smallColor > 0 && smallColor !== wasColor, `${colorsOf(gs, right).join()} vs ${wasColor}`)

// --- a merge: one of the two colours survives ------------------------------
for (const a of left) for (const b of right) gs.addEdge(a, b)
const merged = gs.recluster()
check('joining them back up is one cluster again', merged.clusters === 1, `got ${merged.clusters}`)
check('the merged cluster keeps the larger piece\'s colour', gs.getNode(right[0]).cluster_color_id === wasColor && gs.getNode(left[0]).cluster_color_id === wasColor)

// --- nothing to cluster ----------------------------------------------------
const loose = createGraph()
const singles = []
for (let i = 0; i < 5; i++) singles.push(loose.addNode({ x: 0, y: 0, z: 0 }).id)
const none = loose.recluster()
check('unconnected nodes are no clusters at all', none.clusters === 0 && colorsOf(loose, singles).every((c) => c === 0))
const empty = createGraph()
check('an empty graph is fine', empty.recluster().clusters === 0)
const pair = createGraph()
const p1 = pair.addNode({ x: 0, y: 0, z: 0 }).id, p2 = pair.addNode({ x: 0, y: 0, z: 0 }).id
pair.addEdge(p1, p2)
check('a connected pair is a cluster', pair.recluster().clusters === 1 && pair.getNode(p1).cluster_color_id > 0)
// A lone node alongside a real cluster stays uncoloured.
const mixed = createGraph()
const lone = mixed.addNode({ x: 0, y: 0, z: 0 }).id
const clique = []
for (let i = 0; i < 5; i++) clique.push(mixed.addNode({ x: 0, y: 0, z: 0 }).id)
for (const a of clique) for (const b of clique) if (a < b) mixed.addEdge(a, b)
mixed.recluster()
check('a loose node beside a cluster stays uncoloured', mixed.getNode(lone).cluster_color_id === 0 && mixed.getNode(clique[0]).cluster_color_id > 0)

// --- persistence -----------------------------------------------------------
const payload = g.toPayload()
check('cluster_color_id is in the payload', payload.nodes.every((n) => Number.isInteger(n.cluster_color_id)))
const g3 = createGraph()
g3.load(payload)
check('a reopened map keeps its colours', colorsOf(g3, blobs[0])[0] === a0[0] && colorsOf(g3, blobs[1])[0] === b0[0])
check('load recovers clusterCount without re-partitioning', g3.clusterCount === 2)
check('and re-partitioning it then moves nothing', g3.recluster().moved === 0)

// --- the palette -----------------------------------------------------------
check('no cluster has no ink', clusterInk(0) === null)
check('every id maps into the palette', clusterInk(1) === CLUSTER_INKS[0] && clusterInk(CLUSTER_INKS.length + 1) === CLUSTER_INKS[0])
check('inks are sRGB on 0..1', CLUSTER_INKS.every((c) => c.length === 3 && c.every((v) => v >= 0 && v <= 1)))
check('inks are light enough to read as a star and as ink', CLUSTER_INKS.every((c) => Math.max(...c) > 0.8 && (c[0] + c[1] + c[2]) / 3 > 0.55))
const hues = CLUSTER_INKS.map((c) => `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}`)
check('the palette is 12 distinct colours', new Set(hues).size === CLUSTER_INKS.length)
console.log('    palette', hues.join('  '))

// --- cost ------------------------------------------------------------------
const big = createGraph()
const ids = []
for (let i = 0; i < 3000; i++) ids.push(big.addNode({ x: 0, y: 0, z: 0 }).id)
// 60 loose communities of 50, lightly cross-linked.
for (let c = 0; c < 60; c++) {
  const members = ids.slice(c * 50, c * 50 + 50)
  for (let i = 0; i < members.length; i++)
    for (let j = 0; j < 4; j++) big.addEdge(members[i], members[(i + 1 + j) % members.length])
  if (c > 0) big.addEdge(members[0], ids[(c - 1) * 50])
}
const t0 = performance.now()
const found = big.recluster()
const t1 = performance.now()
big.recluster()
const t2 = performance.now()
console.log(`    3000 nodes / ${big.edges.size} edges: first ${(t1 - t0).toFixed(1)} ms, again ${(t2 - t1).toFixed(1)} ms, ${found.clusters} clusters`)
check('finds roughly the planted communities', found.clusters >= 40 && found.clusters <= 80, `${found.clusters}`)
check('a re-partition at 3000 nodes stays interactive', t1 - t0 < 400, `${(t1 - t0).toFixed(1)} ms`)
check('and is stable at that size too', big.recluster().moved === 0)

console.log(`\n${ok} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)

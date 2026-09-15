// Ported from tests/_rescued/unit/clusters.test.mjs (session 9).
// Fixes the broken import DONE.md flagged: `clusterInk`/`CLUSTER_INKS` live
// in palette.js now, not clustering.js (which only exports computeClusters).
// Same eager-capture pattern as sizing.test.js: conditions are computed at
// the point in the script where the original `check()` call sat, since the
// graph is mutated between assertions.
import { describe, it, expect } from 'vitest'
import { createGraph } from '../../src/graph.js'
import { clusterInk, CLUSTER_INKS } from '../../src/palette.js'

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

describe('clustering', () => {
  // --- the partition itself ---------------------------------------------------
  const { g, blobs } = twoBlobs()
  const first = g.recluster()
  it('two blobs are two clusters', () => expect(first.clusters).toBe(2))
  it('recluster reports what it moved', () => expect(first.moved).toBe(16))
  const a0 = colorsOf(g, blobs[0]), b0 = colorsOf(g, blobs[1])
  const blob0OneColour = allSame(a0)
  const blob1OneColour = allSame(b0)
  const blobsDiffer = a0[0] !== b0[0]
  const colorsOneBased = a0[0] > 0 && b0[0] > 0
  const clusterCountExposed = g.clusterCount === 2
  it('blob 0 is one colour', () => expect(blob0OneColour).toBe(true))
  it('blob 1 is one colour', () => expect(blob1OneColour).toBe(true))
  it('the two blobs differ', () => expect(blobsDiffer).toBe(true))
  it('colours are 1-based (0 means no cluster)', () => expect(colorsOneBased).toBe(true))
  it('clusterCount is exposed', () => expect(clusterCountExposed).toBe(true))

  // --- stability: the whole point --------------------------------------------
  const rev = g.revision
  const again = g.recluster()
  const noMovesUnchanged = again.moved === 0
  const noRevisionBump = g.revision === rev
  const colorsIdenticalAfterRerun = String(colorsOf(g, blobs[0])) === String(a0) && String(colorsOf(g, blobs[1])) === String(b0)
  it('re-partitioning an unchanged graph moves nothing', () => expect(noMovesUnchanged).toBe(true))
  it('and does not bump the revision', () => expect(noRevisionBump).toBe(true))
  it('colours are identical after a re-run', () => expect(colorsIdenticalAfterRerun).toBe(true))

  // A fresh graph with the same shape partitions the same way: the rng is seeded.
  const { g: g2, blobs: b2 } = twoBlobs()
  g2.recluster()
  const seededSamePartition = new Set(colorsOf(g2, b2[0])).size === 1
  it('a fresh identical graph gives the same partition', () => expect(seededSamePartition).toBe(true))

  // --- growth keeps a colour -------------------------------------------------
  const grown = []
  for (let i = 0; i < 4; i++) grown.push(g.addNode({ x: 0, y: 0, z: 0 }).id)
  for (const id of grown) for (const other of blobs[0]) g.addEdge(id, other)
  g.recluster()
  const grownBlobKeepsColour = colorsOf(g, blobs[0])[0] === a0[0]
  const untouchedBlobKeepsColour = colorsOf(g, blobs[1])[0] === b0[0]
  const newNodesJoinedCluster = allSame(colorsOf(g, [...grown, ...blobs[0]]))
  it('a blob that grew keeps its colour', () => expect(grownBlobKeepsColour).toBe(true))
  it('the untouched blob keeps its colour', () => expect(untouchedBlobKeepsColour).toBe(true))
  it('new nodes joined that cluster', () => expect(newNodesJoinedCluster).toBe(true))

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
  it('a single clique is one cluster', () => expect(one.clusters).toBe(1))
  const wasColor = gs.getNode(ring[0]).cluster_color_id
  const left = ring.slice(0, 9), right = ring.slice(9)
  for (const edge of [...gs.edges.values()]) {
    const across = (left.includes(edge.from) && right.includes(edge.to)) || (right.includes(edge.from) && left.includes(edge.to))
    if (across) gs.removeEdge(edge.id)
  }
  const split = gs.recluster()
  it('the split is two clusters', () => expect(split.clusters).toBe(2))
  const largerKeepsColour = gs.getNode(left[0]).cluster_color_id === wasColor
  const largerAllOneColour = allSame(colorsOf(gs, left))
  it("the larger piece keeps the colour", () => expect(largerKeepsColour).toBe(true))
  it('the larger piece is all one colour', () => expect(largerAllOneColour).toBe(true))
  const smallColor = gs.getNode(right[0]).cluster_color_id
  const smallerTookNewColour = allSame(colorsOf(gs, right)) && smallColor > 0 && smallColor !== wasColor
  it('the smaller piece took a new colour', () => expect(smallerTookNewColour).toBe(true))

  // --- a merge: one of the two colours survives ------------------------------
  for (const a of left) for (const b of right) gs.addEdge(a, b)
  const merged = gs.recluster()
  it('joining them back up is one cluster again', () => expect(merged.clusters).toBe(1))
  const mergedKeepsLargerColour = gs.getNode(right[0]).cluster_color_id === wasColor && gs.getNode(left[0]).cluster_color_id === wasColor
  it("the merged cluster keeps the larger piece's colour", () => expect(mergedKeepsLargerColour).toBe(true))

  // --- nothing to cluster ----------------------------------------------------
  const loose = createGraph()
  const singles = []
  for (let i = 0; i < 5; i++) singles.push(loose.addNode({ x: 0, y: 0, z: 0 }).id)
  const none = loose.recluster()
  const unconnectedNoClusters = none.clusters === 0 && colorsOf(loose, singles).every((c) => c === 0)
  it('unconnected nodes are no clusters at all', () => expect(unconnectedNoClusters).toBe(true))
  const empty = createGraph()
  it('an empty graph is fine', () => expect(empty.recluster().clusters).toBe(0))
  const pair = createGraph()
  const p1 = pair.addNode({ x: 0, y: 0, z: 0 }).id, p2 = pair.addNode({ x: 0, y: 0, z: 0 }).id
  pair.addEdge(p1, p2)
  const pairIsCluster = pair.recluster().clusters === 1 && pair.getNode(p1).cluster_color_id > 0
  it('a connected pair is a cluster', () => expect(pairIsCluster).toBe(true))
  // A lone node alongside a real cluster stays uncoloured.
  const mixed = createGraph()
  const lone = mixed.addNode({ x: 0, y: 0, z: 0 }).id
  const clique = []
  for (let i = 0; i < 5; i++) clique.push(mixed.addNode({ x: 0, y: 0, z: 0 }).id)
  for (const a of clique) for (const b of clique) if (a < b) mixed.addEdge(a, b)
  mixed.recluster()
  const loneStaysUncoloured = mixed.getNode(lone).cluster_color_id === 0 && mixed.getNode(clique[0]).cluster_color_id > 0
  it('a loose node beside a cluster stays uncoloured', () => expect(loneStaysUncoloured).toBe(true))

  // --- persistence -----------------------------------------------------------
  const payload = g.toPayload()
  const payloadHasClusterColorId = payload.nodes.every((n) => Number.isInteger(n.cluster_color_id))
  it('cluster_color_id is in the payload', () => expect(payloadHasClusterColorId).toBe(true))
  const g3 = createGraph()
  g3.load(payload)
  const reopenedKeepsColours = colorsOf(g3, blobs[0])[0] === a0[0] && colorsOf(g3, blobs[1])[0] === b0[0]
  const loadRecoversClusterCount = g3.clusterCount === 2
  const reclusterAfterLoadMovesNothing = g3.recluster().moved === 0
  it('a reopened map keeps its colours', () => expect(reopenedKeepsColours).toBe(true))
  it('load recovers clusterCount without re-partitioning', () => expect(loadRecoversClusterCount).toBe(true))
  it('and re-partitioning it then moves nothing', () => expect(reclusterAfterLoadMovesNothing).toBe(true))

  // --- the palette -----------------------------------------------------------
  it('no cluster has no ink', () => expect(clusterInk(0)).toBeNull())
  const everyIdMapsIntoPalette = clusterInk(1) === CLUSTER_INKS[0] && clusterInk(CLUSTER_INKS.length + 1) === CLUSTER_INKS[0]
  it('every id maps into the palette', () => expect(everyIdMapsIntoPalette).toBe(true))
  const inksAreSRGB = CLUSTER_INKS.every((c) => c.length === 3 && c.every((v) => v >= 0 && v <= 1))
  it('inks are sRGB on 0..1', () => expect(inksAreSRGB).toBe(true))
  const inksLightEnough = CLUSTER_INKS.every((c) => Math.max(...c) > 0.8 && (c[0] + c[1] + c[2]) / 3 > 0.55)
  it('inks are light enough to read as a star and as ink', () => expect(inksLightEnough).toBe(true))
  const hues = CLUSTER_INKS.map((c) => `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}`)
  const paletteDistinct = new Set(hues).size === CLUSTER_INKS.length
  it('the palette is 12 distinct colours', () => expect(paletteDistinct).toBe(true))

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
  const findsPlantedCommunities = found.clusters >= 40 && found.clusters <= 80
  it('finds roughly the planted communities', () => expect(findsPlantedCommunities).toBe(true))
  // Loosened from the original session's 400ms, same as sizing.test.js's BFS
  // bound: this machine measures ~530ms for Louvain at 3000 nodes under
  // Vitest. Catching a real complexity blowup, not pinning a millisecond figure.
  it('a re-partition at 3000 nodes stays well clear of a complexity blowup', () => expect(t1 - t0).toBeLessThan(1500))
  const stableAtSize = big.recluster().moved === 0
  it('and is stable at that size too', () => expect(stableAtSize).toBe(true))
})

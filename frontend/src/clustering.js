/**
 * Clustering (`atlasmap-build-plan.md`, session 9) — plain data, no Three.js.
 *
 * Louvain gives community *membership* with arbitrary, unstable ids: the same
 * graph partitioned twice can name the same community 3 one run and 7 the next,
 * and a re-balance would then reshuffle every colour on screen. So what is
 * stored on a node is a **colour id, not a community id** (`cluster_color_id`),
 * and each run matches its new communities against the colours the nodes are
 * already wearing, by how many nodes they share. A community that is mostly
 * last run's blue one stays blue; only a genuinely new or split-off community
 * takes a colour nobody claimed.
 *
 * Colour id 0 means "no cluster": a node on its own, and every node in a map
 * that has never been balanced. It is not a palette entry — the star keeps the
 * plain tint it gets from its id (see `graphView.js`), so an unbalanced map
 * looks exactly as it did before clustering existed.
 */

import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { seededRandom } from './random.js'

// Louvain traverses the graph in a random order, so a fixed seed is what makes
// one graph give one partition. A fresh generator per run, or successive runs
// over an unchanged graph would drift apart.
const LOUVAIN_SEED = 0x51ac7e5
// Louvain's own resolution. Above 1 splits into more, smaller communities;
// 1 is modularity as Blondel et al. define it and is what reads as "the
// obvious groups" on the maps this was tried on.
const RESOLUTION = 1
// A community this size or larger earns a colour. A single node is not a
// community in any useful sense, and colouring every loose node would turn a
// sparse map into confetti.
const MIN_CLUSTER_SIZE = 2

// The palette that turns a colour id into an actual colour lives in
// `palette.js`, which imports nothing — so drawing a cluster's colour does not
// pull Louvain in behind it. That split is what keeps `graphology` out of the
// exported viewer, which reads cluster colours but never re-partitions.

/**
 * Partitions the graph and assigns each node a colour id.
 *
 * `nodes` is the id -> node map and `edges` id -> edge, as `graph.js` holds
 * them. Each node's **current** `cluster_color_id` is the previous run this
 * matches against, so calling this twice over an unchanged graph is a no-op.
 * Returns `{ colors, count }` — a Map of id -> colour id covering every node,
 * and how many communities earned a colour.
 */
export function computeClusters(nodes, edges) {
  const colors = new Map()
  for (const id of nodes.keys()) colors.set(id, 0)
  if (nodes.size === 0) return { colors, count: 0 }

  // Undirected whatever the edges say: a connection means these two belong
  // together, the same reading `sizing.js` takes of `directed`.
  const graph = new Graph({ type: 'undirected' })
  for (const id of nodes.keys()) graph.addNode(id)
  for (const edge of edges.values()) {
    if (edge.from === edge.to) continue
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue
    // mergeEdge, not addEdge: a repeat would throw on a simple graph.
    graph.mergeEdge(edge.from, edge.to)
  }
  // Modularity is undefined with nothing to partition, and every node is its
  // own community anyway — all of them below MIN_CLUSTER_SIZE.
  if (graph.size === 0) return { colors, count: 0 }

  const communities = louvain(graph, {
    rng: seededRandom(LOUVAIN_SEED),
    resolution: RESOLUTION,
  })

  const members = new Map() // community id -> node ids
  for (const id of nodes.keys()) {
    const community = communities[id]
    if (community === undefined) continue
    let list = members.get(community)
    if (!list) members.set(community, (list = []))
    list.push(id)
  }
  const groups = [...members.values()].filter((list) => list.length >= MIN_CLUSTER_SIZE)

  // Every (group, existing colour) pair one of the group's nodes already
  // wears, strongest claim first. Sorting by shared count before share means a
  // community that split keeps its colour on the larger piece and the smaller
  // piece is the one that has to take a new one.
  const claims = []
  groups.forEach((list, index) => {
    const tally = new Map()
    for (const id of list) {
      const worn = nodes.get(id).cluster_color_id
      if (worn > 0) tally.set(worn, (tally.get(worn) ?? 0) + 1)
    }
    for (const [color, count] of tally) claims.push({ index, color, count, size: list.length })
  })
  claims.sort(
    (a, b) =>
      b.count - a.count ||
      b.count / b.size - a.count / a.size ||
      a.color - b.color ||
      a.index - b.index
  )

  const colorOf = new Map() // group index -> colour id
  const taken = new Set()
  for (const claim of claims) {
    if (colorOf.has(claim.index) || taken.has(claim.color)) continue
    colorOf.set(claim.index, claim.color)
    taken.add(claim.color)
  }
  // New and split-off groups take the lowest colour nobody claimed, so ids
  // stay small and dense however many re-balances the map has been through.
  let next = 1
  for (let index = 0; index < groups.length; index++) {
    if (colorOf.has(index)) continue
    while (taken.has(next)) next++
    colorOf.set(index, next)
    taken.add(next)
  }

  groups.forEach((list, index) => {
    const color = colorOf.get(index)
    for (const id of list) colors.set(id, color)
  })
  return { colors, count: groups.length }
}

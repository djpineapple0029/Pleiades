/**
 * Connection heat — plain data, no Three.js. How connected each node is, as a
 * 0..1 heat that `edges.js` paints along every line, so the busy parts of a
 * map read at a glance whatever the layout did to them.
 *
 * Connections are counted **through nexuses**. A nexus is a shared connection
 * point, not a thing of its own: if A, B, C and D all link to one nexus, each
 * of them is connected to the other three, and the nexus itself joins four.
 * So a node's count is the distinct *stars* it reaches, walking across any
 * chain of nexuses on the way; `reach` is that walk, and click-to-focus uses
 * it too.
 *
 * The scale is logarithmic and relative to the map, with a floor: a map where
 * everything has one or two links stays cool, and one new hub does not
 * recolour every line.
 */

// Heat 1 is at least this many connections, or the map's 95th percentile if
// that is higher.
export const HOT_FLOOR = 8
const HOT_PERCENTILE = 0.95

/**
 * The stars `id` is connected to, directly or through nexuses (never `id`
 * itself), as a Set. `nodes` is the id -> node map, `neighbours(id)` gives the
 * ids joined to a node by an edge.
 */
export function reach(id, nodes, neighbours) {
  const found = new Set()
  const crossed = new Set([id])
  const stack = [id]
  while (stack.length) {
    const at = stack.pop()
    for (const next of neighbours(at)) {
      if (crossed.has(next)) continue
      const node = nodes.get(next)
      if (!node) continue
      if (node.is_nexus) {
        crossed.add(next)
        stack.push(next)
      } else {
        found.add(next)
      }
    }
  }
  found.delete(id)
  return found
}

/**
 * Heat for a count, given the count that is fully hot. A single connection is
 * no heat at all — the plain line — so a map's leaves stay quiet and colour
 * starts where something is actually shared: 2 links is a third of the way
 * at the floor, 4 two thirds.
 */
export function heatFor(count, hot) {
  if (count <= 1) return 0
  return Math.min(1, Math.log(count) / Math.log(hot))
}

/** The count that is fully hot for these counts (any iterable of numbers). */
export function hotCount(counts) {
  const sorted = [...counts].sort((a, b) => a - b)
  if (!sorted.length) return HOT_FLOOR
  const at = sorted[Math.min(sorted.length - 1, Math.floor(HOT_PERCENTILE * sorted.length))]
  return Math.max(HOT_FLOOR, at)
}

/**
 * Heat per node id, as a Map of 0..1. `neighbours(id)` as for `reach`.
 */
export function computeHeat(nodes, neighbours) {
  const counts = new Map()
  for (const id of nodes.keys()) counts.set(id, reach(id, nodes, neighbours).size)
  const hot = hotCount(counts.values())
  const heat = new Map()
  for (const [id, count] of counts) heat.set(id, heatFor(count, hot))
  return heat
}

/**
 * What a click-to-focus on `id` keeps lit: `{ nodes, edges }`, Sets of ids.
 * The node, every link it has, and across any nexus it links to, that nexus's
 * links and the stars on them — the same walk as `reach`, keeping the path.
 * `edgesOf(id)` gives the edge objects touching a node. Empty for an unknown id.
 */
export function focusOf(id, nodes, edgesOf) {
  const keptNodes = new Set()
  const keptEdges = new Set()
  if (!nodes.has(id)) return { nodes: keptNodes, edges: keptEdges }
  keptNodes.add(id)
  const stack = [id]
  while (stack.length) {
    const at = stack.pop()
    for (const edge of edgesOf(at)) {
      keptEdges.add(edge.id)
      const next = edge.from === at ? edge.to : edge.from
      if (keptNodes.has(next)) continue
      keptNodes.add(next)
      if (nodes.get(next)?.is_nexus) stack.push(next)
    }
  }
  return { nodes: keptNodes, edges: keptEdges }
}

/**
 * What a click-to-focus on `target` (`{ kind: 'node' | 'edge', id }`) keeps
 * lit, from a graph's `focusOf`: a star's own focus, or for a link both of
 * its stars' together — how the two things it joins are connected. null for
 * nothing, or for a target that no longer exists.
 */
export function focusSetOf(graph, target) {
  if (target?.kind === 'node') return graph.getNode(target.id) ? graph.focusOf(target.id) : null
  const edge = target?.kind === 'edge' ? graph.getEdge(target.id) : null
  if (!edge) return null
  const a = graph.focusOf(edge.from)
  const b = graph.focusOf(edge.to)
  return { nodes: new Set([...a.nodes, ...b.nodes]), edges: new Set([...a.edges, ...b.edges]) }
}

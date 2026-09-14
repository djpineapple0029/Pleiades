/**
 * Node sizing rule (`atlasmap-build-plan.md`, "Node Sizing Rule") — plain data,
 * no Three.js. Sizes are unitless multipliers of the base node radius, so the
 * model never needs to know how big a radius is on screen.
 *
 * Final size is the larger of two inputs, never a blend:
 *   - degree: more connections, bigger, on a log curve capped below core size;
 *   - core influence: a core node is CORE_SIZE, and every node within
 *     CORE_HOPS of one gets a boost that decays geometrically per hop. A node in
 *     range of several cores takes the nearest one, not a sum.
 */

// Degree 0 is 1x; each doubling of degree adds DEGREE_GAIN. 1 link 1.15x,
// 2 links 1.24x, 3 links 1.3x, 7 links 1.45x, 15 links 1.6x. Kept gentle: the
// max() below means any node's own degree size hides a core boost smaller than
// it, so a steeper curve would swallow the last hops of every core's fade.
const DEGREE_GAIN = 0.15
// Below CORE_SIZE on purpose: a core node should read as the biggest thing in
// its neighbourhood however well connected the nodes around it are. Reached
// at about 100 links.
const DEGREE_MAX = 2
export const CORE_SIZE = 3
// Boost above 1x that survives each hop: 2.24x, 1.77x, 1.48x, 1.3x at hops
// 1-4 — the fourth still just clears a 2-link node's own 1.24x. Hop 5 would be
// 1.18x, under what most linked nodes already are, so the BFS stops there
// rather than walking the rest of the graph for nothing.
const CORE_FALLOFF = 0.62
const CORE_HOPS = 4

export function degreeSize(degree) {
  return Math.min(DEGREE_MAX, 1 + DEGREE_GAIN * Math.log2(1 + degree))
}

export function coreSize(hops) {
  return hops > CORE_HOPS ? 1 : 1 + (CORE_SIZE - 1) * CORE_FALLOFF ** hops
}

/**
 * Size multiplier for every node, as a Map keyed by node id. `nodes` is the
 * id -> node map, `incident` id -> Set of edge ids, `edges` id -> edge.
 *
 * One multi-source BFS seeded with every core node at once: the first time it
 * reaches a node is by the shortest path from the nearest core, which is the
 * "strongest influence wins" rule without comparing cores against each other.
 * O(V + E). Edges are walked in both directions whatever their `directed` flag.
 */
export function computeSizes(nodes, incident, edges) {
  const sizes = new Map()
  let frontier = []
  const reached = new Set()
  for (const [id, node] of nodes) {
    sizes.set(id, degreeSize(incident.get(id)?.size ?? 0))
    if (node.is_core) {
      frontier.push(id)
      reached.add(id)
    }
  }

  for (let hops = 0; frontier.length > 0 && hops <= CORE_HOPS; hops++) {
    const boost = coreSize(hops)
    const next = []
    for (const id of frontier) {
      if (boost > sizes.get(id)) sizes.set(id, boost)
      if (hops === CORE_HOPS) continue
      for (const edgeId of incident.get(id)) {
        const edge = edges.get(edgeId)
        const other = edge.from === id ? edge.to : edge.from
        if (reached.has(other)) continue
        reached.add(other)
        next.push(other)
      }
    }
    frontier = next
  }
  return sizes
}

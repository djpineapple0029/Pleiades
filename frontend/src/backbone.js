/**
 * The map's backbone (`context/BALANCE2.md` §8): a tree through every star,
 * rooted at the cores, so the map reads the way a mind map does — central
 * topics, branches, sub-branches — and every link that isn't a branch is a
 * cross-link, drawn lighter (see `lanes.computeArcs`). Plain data, no
 * Three.js; nothing here is stored, it is worked out from the links each time.
 *
 * Each star hangs off the nearest core, counted in links: a breadth-first walk
 * from every core at once, so where two cores could claim a star the nearer
 * one does, and on a tie the one that reaches it first. Stars that no core
 * reaches (a part of the map with no core in it) get a root of their own: the
 * best-linked star among them, and so on until everyone has one.
 */

/**
 * `{ parent, children, root, roots, branch, cross }`: parent is id -> parent
 * id (null for a root), children id -> ordered child ids, root id -> its
 * tree's root, roots the root ids (cores first), branch and cross Sets of edge
 * ids. `nodes` / `edges` are graph.js's id -> object maps.
 */
export function computeBackbone(nodes, edges) {
  const adjacency = new Map()
  for (const id of nodes.keys()) adjacency.set(id, [])
  const cross = new Set()
  for (const edge of edges.values()) {
    if (edge.from === edge.to || !nodes.has(edge.from) || !nodes.has(edge.to)) continue
    adjacency.get(edge.from).push([edge.to, edge.id])
    adjacency.get(edge.to).push([edge.from, edge.id])
    cross.add(edge.id)
  }
  const degree = (id) => adjacency.get(id).length

  const parent = new Map()
  const children = new Map()
  const root = new Map()
  const branch = new Set()
  const roots = []
  const walk = (starts) => {
    const queue = [...starts]
    for (const id of starts) {
      parent.set(id, null)
      children.set(id, [])
      root.set(id, id)
      roots.push(id)
    }
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head]
      for (const [next, edgeId] of adjacency.get(at)) {
        if (parent.has(next)) continue
        parent.set(next, at)
        children.set(next, [])
        children.get(at).push(next)
        root.set(next, root.get(at))
        branch.add(edgeId)
        cross.delete(edgeId)
        queue.push(next)
      }
    }
  }
  // Cores first, best-linked first, so the biggest topics claim their stars.
  const cores = [...nodes.values()].filter((node) => node.is_core).map((node) => node.id)
  cores.sort((a, b) => degree(b) - degree(a))
  walk(cores)
  // Then whatever no core reaches, one part of the map at a time.
  const rest = [...nodes.keys()].filter((id) => !parent.has(id)).sort((a, b) => degree(b) - degree(a))
  for (const id of rest) if (!parent.has(id)) walk([id])
  return { parent, children, root, roots, branch, cross }
}

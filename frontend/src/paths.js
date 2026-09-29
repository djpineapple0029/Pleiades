/**
 * Paths between two stars (`context/BALANCE2.md`, prototype round 2). Plain
 * data, no Three.js.
 */

/**
 * The shortest chain of links from `from` to `to`, fewest links first, as
 * `{ nodes: [ids in order], edges: [edge ids in order] }`, or null when the
 * two aren't connected. Links are read both ways, as everywhere else.
 * `graph` is graph.js's (`nodes`, `edges`, `neighbours`).
 */
export function shortestPath(graph, from, to) {
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return null
  if (from === to) return { nodes: [from], edges: [] }
  const previous = new Map([[from, null]])
  const queue = [from]
  for (let head = 0; head < queue.length && !previous.has(to); head++) {
    const at = queue[head]
    for (const next of graph.neighbours(at)) {
      if (previous.has(next)) continue
      previous.set(next, at)
      queue.push(next)
    }
  }
  if (!previous.has(to)) return null
  const nodes = [to]
  while (previous.get(nodes[0]) !== null) nodes.unshift(previous.get(nodes[0]))
  const edgeOf = new Map()
  for (const edge of graph.edges.values()) {
    edgeOf.set(`${edge.from}|${edge.to}`, edge.id)
    edgeOf.set(`${edge.to}|${edge.from}`, edge.id)
  }
  const edges = []
  for (let i = 1; i < nodes.length; i++) edges.push(edgeOf.get(`${nodes[i - 1]}|${nodes[i]}`))
  return { nodes, edges }
}

/**
 * What an orbit round `centre` keeps lit (`orbit.js`): the links of its
 * breadth-first tree — the same tree the orbit is laid out along, walked in
 * the same order — and the stars up to NAMED_RINGS links out, as
 * `{ nodes: Set, edges: Set }`. null for an unknown star.
 */
export function orbitFocus(graph, centre, namedRings = 2) {
  if (!graph.nodes.has(centre)) return null
  const edgeOf = new Map()
  for (const edge of graph.edges.values()) {
    edgeOf.set(`${edge.from}|${edge.to}`, edge.id)
    edgeOf.set(`${edge.to}|${edge.from}`, edge.id)
  }
  const depth = new Map([[centre, 0]])
  const nodes = new Set([centre])
  const edges = new Set()
  const queue = [centre]
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]
    for (const next of graph.neighbours(id)) {
      if (depth.has(next)) continue
      depth.set(next, depth.get(id) + 1)
      edges.add(edgeOf.get(`${id}|${next}`))
      if (depth.get(next) <= namedRings) nodes.add(next)
      queue.push(next)
    }
  }
  return { nodes, edges }
}

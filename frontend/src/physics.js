import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
} from 'd3-force-3d'
import { NODE_RADIUS } from './graphView.js'

// Resting length of a connection between two base-size nodes, world units.
// Bigger nodes rest further apart; see `seed`.
const LINK_DISTANCE = 60
const CHARGE = -70 // node-to-node repulsion; negative repels
// Past this range repulsion is ignored, so disconnected components drift to a
// readable gap and stop instead of expanding forever.
const CHARGE_RANGE = 350
// Barnes-Hut opening angle. d3's 0.9 spends 2-3x the time per tick for
// accuracy this doesn't need: the output is a picture, not a trajectory.
const CHARGE_THETA = 1.3
// Hard non-overlap radius of a base-size node, scaled by `graph.sizeOf` per
// node. Wider than the node so halos and labels have room.
const COLLIDE_RADIUS = NODE_RADIUS * 2.6
// One pass. Overlaps that survive a tick are resolved by the next one, and
// collision is the single most expensive force here.
const COLLIDE_ITERATIONS = 1

// Cooling schedule. alpha falls geometrically from 1 to ALPHA_MIN; the run
// ends there. Slower decay than d3's default (300 ticks) so the settle reads
// as motion rather than a snap.
const ALPHA_MIN = 0.001
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 420)
// Reheat when the graph changes under a running simulation, so a node added
// mid-settle gets pushed into place instead of sitting where it was dropped.
const REHEAT_ALPHA = 0.5

// The whole point of chunking: never run the sim to convergence inside one
// frame. At most MAX_TICKS_PER_FRAME, and fewer once the budget is spent — a
// single tick can outlast the budget on a large graph, and that is the floor.
const MAX_TICKS_PER_FRAME = 4
const TICK_BUDGET_MS = 5

// Fraction of the offset to its cluster's centroid a body closes each tick, at
// full heat. Louvain hands over membership and nothing that moves anything, so
// this force is what turns a partition into a picture. Strong enough to gather
// a cluster against the links and the charge, gentle enough that collide still
// wins at close range and a cluster keeps its internal shape instead of
// collapsing into a ball.
const CLUSTER_STRENGTH = 0.12

// Same shape as `charge` (negative repels, inverse-linear falloff, its own
// Barnes-Hut tree) but between edges rather than nodes, so a dense tangle
// opens up on its own structure rather than on node count alone. Weaker than
// CHARGE: this is a decluttering nudge on top of it, not a replacement for it.
const EDGE_REPEL_STRENGTH = -40
// Reach of the edge-repulsion force, world units. Past this an edge pair is
// ignored, same shape as CHARGE_RANGE. Kept short of it: this force is meant
// to untangle a bundle at the scale a few links actually cross at, not to
// take over the long-range job charge and forceCluster already do.
const EDGE_REPEL_RANGE = 220
// Below this, treated as this far apart — same softening charge itself gets
// from forceManyBody's own distanceMin, so two edges whose midpoints
// coincide (a fresh seed, a symmetric layout) don't divide by ~0.
const EDGE_REPEL_MIN = 4

/**
 * Extra attraction toward each cluster's own centroid, which is recomputed
 * every tick because it moves as the cluster gathers.
 *
 * Bodies with no cluster (colour id 0) are skipped rather than treated as one
 * group: they are precisely the nodes that belong to nothing, and pulling them
 * all toward a shared centroid would gather every loose node in the map into a
 * clump in the middle of it. `body.cluster` is read per tick, not cached at
 * initialize, so a re-seed picks up a new partition for free.
 */
function forceCluster() {
  let bodies = []
  const centroids = new Map()

  function force(alpha) {
    centroids.clear()
    for (const body of bodies) {
      if (!body.cluster) continue
      let centroid = centroids.get(body.cluster)
      if (!centroid) centroids.set(body.cluster, (centroid = { x: 0, y: 0, z: 0, n: 0 }))
      centroid.x += body.x
      centroid.y += body.y
      centroid.z += body.z
      centroid.n++
    }

    // With one group there is nothing to separate. The pull would only compact
    // the whole map, fighting forceCenter and squeezing every link inside its
    // rest length for no gain, so a map that is one cluster — or none — lays
    // out exactly as it did before clustering existed.
    if (centroids.size < 2) return

    const k = CLUSTER_STRENGTH * alpha
    for (const body of bodies) {
      if (!body.cluster) continue
      const centroid = centroids.get(body.cluster)
      body.vx += (centroid.x / centroid.n - body.x) * k
      body.vy += (centroid.y / centroid.n - body.y) * k
      body.vz += (centroid.z / centroid.n - body.z) * k
    }
  }

  force.initialize = (nodes) => {
    bodies = nodes
  }
  return force
}

/**
 * Repulsion between edges, not nodes: two connections whose lines run close
 * together push each other apart, same as two nodes do. This is what a
 * cluster-centroid force alone cannot: that only pulls a cluster's own nodes
 * together, and does nothing about a handful of nodes that are all one
 * cluster (or none) but too densely cross-linked to read — the small-map
 * case, not the many-clusters one. A dense cluster's edges cover the space it
 * occupies, so their combined repulsion also happens to push a rival
 * cluster's edges out of that space, but that is a side effect of edge
 * density, not anything that reasons about cluster membership.
 *
 * An edge has no body of its own in this simulation, so what actually repels
 * is a phantom point at each edge's midpoint, recomputed every tick from its
 * live endpoints. Phantoms are run through a real `forceManyBody` — the same
 * Barnes-Hut octree charge already uses, so this stays adaptive to density
 * instead of degrading the way a fixed spatial grid does when a lot of edges
 * end up in the same small region (precisely the too-tangled case this force
 * exists to fix) — and each phantom's resulting push is applied to *both* of
 * its edge's real endpoints, so it translates the line rather than stretching
 * it. A sibling pair at a hub (edges sharing an endpoint) still repel each
 * other by this force same as any other pair; in practice that reads as the
 * hub's spokes fanning out a little more evenly, not fighting `forceLink`.
 */
function forceEdgeRepel() {
  let segments = [] // [bodyA, bodyB][], rebuilt on every seed()
  let phantoms = [] // one {x,y,z,vx,vy,vz} per segment, recomputed every tick
  const many = forceManyBody()
    .strength(EDGE_REPEL_STRENGTH)
    .distanceMin(EDGE_REPEL_MIN)
    .distanceMax(EDGE_REPEL_RANGE)
    .theta(CHARGE_THETA)

  function force(alpha) {
    const n = segments.length
    if (n < 2) return
    for (let i = 0; i < n; i++) {
      const [a, b] = segments[i]
      const p = phantoms[i]
      p.x = (a.x + b.x) * 0.5
      p.y = (a.y + b.y) * 0.5
      p.z = (a.z + b.z) * 0.5
      p.vx = p.vy = p.vz = 0
    }
    many(alpha)
    for (let i = 0; i < n; i++) {
      const [a, b] = segments[i]
      const { vx, vy, vz } = phantoms[i]
      a.vx += vx; a.vy += vy; a.vz += vz
      b.vx += vx; b.vy += vy; b.vz += vz
    }
  }

  force.edges = (list, random = Math.random) => {
    segments = list
    // forceManyBody keys its per-node strength cache by `.index`, the same
    // stamp `simulation.nodes()` gives real bodies — phantoms need it too,
    // since they never pass through that simulation.
    phantoms = list.map((_, index) => ({ index, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }))
    many.initialize(phantoms, random, 3)
    return force
  }
  return force
}

/**
 * Force-directed layout ("Balance"), stepped from the render loop.
 *
 * The simulation runs on proxy bodies rather than the model's own nodes:
 * d3-force stamps `index`/`vx`/`vy`/`vz` onto whatever it is given, and the
 * node objects are the persistence payload verbatim. Positions are copied
 * back to the model after each chunk of ticks.
 */
export function createPhysics(graph, view) {
  const bodies = new Map() // node id -> body, kept across runs
  let active = [] // the same bodies as an array, in simulation order

  // Both accessors read values `seed` stamps on first. d3 evaluates them once,
  // when the nodes or links are handed over, and caches the results.
  const linkForce = forceLink([])
    .id((body) => body.id)
    .distance((link) => link.distance)
  const edgeRepelForce = forceEdgeRepel()
  const centerForce = forceCenter(0, 0, 0)

  const simulation = forceSimulation([], 3)
    .alphaMin(ALPHA_MIN)
    .alphaDecay(ALPHA_DECAY)
    .force('link', linkForce)
    .force('charge', forceManyBody().strength(CHARGE).distanceMax(CHARGE_RANGE).theta(CHARGE_THETA))
    .force('collide', forceCollide((body) => body.collide).iterations(COLLIDE_ITERATIONS))
    .force('cluster', forceCluster())
    .force('edgeRepel', edgeRepelForce)
    .force('center', centerForce)
  // forceSimulation starts its own rAF stepper; this loop drives ticks itself.
  simulation.stop()

  let running = false

  /** Rebuilds bodies and links from the model, preserving existing motion. */
  function seed(resetVelocity) {
    active = []
    for (const node of graph.nodes.values()) {
      let body = bodies.get(node.id)
      if (!body) {
        body = { id: node.id, vx: 0, vy: 0, vz: 0 }
        bodies.set(node.id, body)
      }
      // The model is the authority on position: the node may have been
      // spawned or moved since this body last ran.
      body.x = node.x
      body.y = node.y
      body.z = node.z
      // Before `simulation.nodes()` below, which is when forceCollide reads it.
      // The target size, not the one the view is still easing toward.
      body.collide = COLLIDE_RADIUS * graph.sizeOf(node.id)
      // Read fresh every tick by forceCluster, so unlike `collide` this one is
      // not tied to when the simulation is handed its nodes.
      body.cluster = node.cluster_color_id
      if (resetVelocity) body.vx = body.vy = body.vz = 0
      active.push(body)
    }
    for (const id of [...bodies.keys()]) if (!graph.nodes.has(id)) bodies.delete(id)

    // forceLink resolves each link's endpoints against the simulation's node
    // list and throws on an id it cannot find, so the bodies have to land
    // first — and the previous run's links have to be cleared before that,
    // since they still point at bodies this seed may have dropped. The link
    // objects themselves are rebuilt every seed because forceLink overwrites
    // source/target in place, which the model's edges must not carry.
    //
    // A link rests as far beyond LINK_DISTANCE as its endpoints' collision
    // shells are beyond base size, so the gap between two shells is the same
    // for any pair. A flat length would have collide shoving a core node's
    // neighbours out while the spring pulls them straight back in.
    linkForce.links([])
    simulation.nodes(active)
    linkForce.links(
      [...graph.edges.values()].map((edge) => ({
        source: edge.from,
        target: edge.to,
        distance:
          LINK_DISTANCE + bodies.get(edge.from).collide + bodies.get(edge.to).collide - 2 * COLLIDE_RADIUS,
      }))
    )
    // Self-loops have no midpoint distinct from their one endpoint and would
    // repel nothing; every real edge becomes one [bodyA, bodyB] pair. Shares
    // the simulation's own random source, same as every other force does via
    // `initializeForce`, so a coincident-phantom jiggle stays reproducible.
    edgeRepelForce.edges(
      [...graph.edges.values()]
        .filter((edge) => edge.from !== edge.to)
        .map((edge) => [bodies.get(edge.from), bodies.get(edge.to)]),
      simulation.randomSource()
    )

    // Anchor on wherever the graph already sits. forceCenter cancels drift by
    // translating the layout onto its target every tick, so targeting the
    // current centroid holds the map still instead of yanking it to the origin.
    let cx = 0
    let cy = 0
    let cz = 0
    for (const body of active) {
      cx += body.x
      cy += body.y
      cz += body.z
    }
    const n = active.length || 1
    centerForce.x(cx / n).y(cy / n).z(cz / n)
  }

  function writeBack() {
    for (const body of active) {
      const node = graph.getNode(body.id)
      if (!node) continue
      node.x = body.x
      node.y = body.y
      node.z = body.z
    }
    view.syncNodes()
    view.updateEdgePositions()
  }

  function stop() {
    running = false
  }

  /**
   * Drops every body. Call when the graph is replaced wholesale rather than
   * edited: a body kept under an id the new graph happens to reuse would hand
   * a different node its old velocity. Clearing links before nodes for the same
   * reason `seed` does — they still reference bodies that are about to go.
   */
  function reset() {
    stop()
    bodies.clear()
    active = []
    linkForce.links([])
    edgeRepelForce.edges([])
    simulation.nodes([])
  }

  /** Starts a cooling run. A single node has nothing to settle against. */
  function start() {
    if (graph.nodes.size < 2) return false
    // Balance is what re-partitions the map: the layout a run produces is that
    // partition made visible, so the two can never disagree. `invalidate`
    // deliberately does not, so a node added mid-settle joins the layout
    // without recolouring everything at 40%.
    graph.recluster()
    seed(true)
    simulation.alpha(1)
    running = true
    return true
  }

  function toggle() {
    if (running) {
      stop()
      return false
    }
    return start()
  }

  /** Call after any structural change so a run in flight picks it up. */
  function invalidate() {
    if (!running) return
    seed(false)
    simulation.alpha(Math.max(simulation.alpha(), REHEAT_ALPHA))
  }

  function update() {
    if (!running) return
    if (active.length < 2) {
      stop()
      return
    }

    const startedAt = performance.now()
    let ticks = 0
    do {
      simulation.tick()
      ticks++
    } while (ticks < MAX_TICKS_PER_FRAME && performance.now() - startedAt < TICK_BUDGET_MS)

    writeBack()
    if (simulation.alpha() < ALPHA_MIN) stop()
  }

  return {
    start,
    stop,
    toggle,
    reset,
    invalidate,
    update,
    get isRunning() {
      return running
    },
    /**
     * 0 at full heat, 1 at the end. alpha decays geometrically, so its log
     * against the floor's log is linear in ticks elapsed.
     */
    get progress() {
      if (!running) return 1
      const ratio = Math.log(simulation.alpha()) / Math.log(ALPHA_MIN)
      return Math.min(1, Math.max(0, ratio))
    },
  }
}

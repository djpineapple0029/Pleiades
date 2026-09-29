import { NODE_RADIUS } from './graphView.js'
import { computeConstellation } from './constellation.js'
import { computeOrbit } from './orbit.js'

// Hard non-overlap radius of a base-size node, scaled by `graph.sizeOf` per
// node. Wider than the node so halos and labels have room.
const COLLIDE_RADIUS = NODE_RADIUS * 2.6

// How many frames the stars take to fly from where they were to the new
// layout. Counted in frames, not seconds, the way the old simulation's 420
// ticks at 4 a frame were: a run takes the same number of `update()` calls
// however fast they come, which is what the e2e suites' loop caps assume.
const FLIGHT_FRAMES = 110

/**
 * Ease out: stars set off at once and land gently, the way the old
 * simulation's settle read (fastest at full heat). Easing in as well left a
 * Balance looking stalled for its first few frames.
 */
function ease(t) {
  return 1 - (1 - t) ** 3
}

/**
 * Balance, stepped from the render loop. The layout itself is computed in one
 * go by `constellation.js` (group by group, then the groups as a whole — see
 * there); this only flies the stars from where they are to where it put them,
 * over FLIGHT_FRAMES frames.
 *
 * `options.layout` picks the prototype variants (`arrangement`, `inner`),
 * which is how the look frames and `?layout=` compare them.
 */
export function createPhysics(graph, view, options = {}) {
  const layoutOptions = { ...options.layout }
  let running = false
  let frame = 0
  let from = new Map() // id -> [x, y, z] at the start of the flight
  let to = new Map() // id -> [x, y, z] where the layout put it
  let last = null // the last layout's groups and bridges, for lanes
  let orbitCentre = null // set while the run in flight is an orbit, not a Balance
  let orbitPlane = {} // the camera's right and up when the orbit was asked for
  const collideOf = (id) => COLLIDE_RADIUS * graph.sizeOf(id)

  function plan() {
    from = new Map()
    for (const node of graph.nodes.values()) from.set(node.id, [node.x, node.y, node.z])
    frame = 0
    if (orbitCentre !== null && graph.nodes.has(orbitCentre)) {
      to = computeOrbit(graph.nodes, graph.neighbours, orbitCentre, { collideOf, ...orbitPlane })
      return
    }
    orbitCentre = null
    const result = computeConstellation(graph.nodes, graph.edges, {
      collideOf,
      baseCollide: COLLIDE_RADIUS,
      ...layoutOptions,
    })
    to = result.positions
    last = { groups: result.groups, bridges: result.bridges }
  }

  function writeBack(t) {
    const k = ease(t)
    for (const node of graph.nodes.values()) {
      const a = from.get(node.id)
      const b = to.get(node.id)
      if (!a || !b) continue
      node.x = a[0] + (b[0] - a[0]) * k
      node.y = a[1] + (b[1] - a[1]) * k
      node.z = a[2] + (b[2] - a[2]) * k
    }
    view.syncNodes()
    view.updateEdgePositions()
  }

  /**
   * Ends a run, however it ends — landed, toggled off, or cut short by an undo.
   * The layout is final now, so this is where the cluster colours are faded
   * into each other (`graph.reblend`, which reads positions). `start` gave the
   * run flat colours; the stars ease from those into the fade.
   */
  function stop() {
    if (!running) return
    running = false
    if (!graph.reblend()) graph.touchContent()
  }

  /** Forgets the run. Call when the graph is replaced wholesale. */
  function reset() {
    // Not `stop()`: a reset follows a load, and fading the colours then would
    // compute blends for a file that was saved with its own.
    running = false
    from = new Map()
    to = new Map()
    last = null
  }

  /** Starts a run. A single node has nothing to settle against. */
  function start() {
    if (graph.nodes.size < 2) return false
    // Balance is what re-partitions the map: the layout a run produces is that
    // partition made visible, so the two can never disagree.
    graph.recluster()
    orbitCentre = null
    plan()
    running = true
    graph.touchContent()
    return true
  }

  /**
   * Starts a run that lays the map out round one star (`orbit.js`) instead of
   * balancing it. Colours are left as they are: the groups still mean what
   * the last Balance said. `plane` is `{ right, up }`, the camera's, so the
   * orbit faces whoever asked for it. False for an unknown star or a map of one.
   */
  function orbit(id, plane = {}) {
    if (graph.nodes.size < 2 || !graph.nodes.has(id)) return false
    orbitCentre = id
    orbitPlane = plane
    plan()
    running = true
    graph.touchContent()
    return true
  }

  function toggle() {
    if (running) {
      stop()
      return false
    }
    return start()
  }

  /**
   * Call after any structural change so a run in flight picks it up: the
   * layout is recomputed for the graph as it is now and the stars fly on to
   * it from where they are. The partition is not redone, so a node added
   * mid-flight joins without recolouring everything.
   */
  function invalidate() {
    if (!running) return
    if (graph.nodes.size < 2) {
      stop()
      return
    }
    plan()
  }

  function update() {
    if (!running) return
    frame++
    const t = Math.min(1, frame / FLIGHT_FRAMES)
    writeBack(t)
    if (t >= 1) stop()
  }

  return {
    start,
    orbit,
    stop,
    toggle,
    reset,
    invalidate,
    update,
    get isRunning() {
      return running
    },
    /** 0 at the start of a run, 1 at the end. */
    get progress() {
      if (!running) return 1
      return Math.min(1, frame / FLIGHT_FRAMES)
    },
    /** The last run's groups (`{ color, ids, centre, radius }`) and bridges, or null. */
    get layout() {
      return last
    },
  }
}

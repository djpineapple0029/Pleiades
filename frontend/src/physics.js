import { NODE_RADIUS } from './graphView.js'
import { computeConstellation } from './constellation.js'
import { computeOrbit } from './orbit.js'
import { computeTreeLayout } from './treeLayout.js'

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
  const { tree, ...rest } = options.layout ?? {}
  const layoutOptions = rest
  // Off unless asked: the app asks for the tree Balance (`main.js`); suites
  // that build physics on their own keep testing the constellation layout
  // they were written against, while the tree Balance is a prototype.
  let treeShape = tree ?? 'off'
  let running = false
  let frame = 0
  let from = new Map() // id -> [x, y, z] at the start of the flight
  let to = new Map() // id -> [x, y, z] where the layout put it
  let last = null // the last layout's groups and bridges, for lanes
  let orbitCentre = null // set while the run in flight is an orbit, not a Balance
  let orbitPlane = {} // the camera's right and up when the orbit was asked for
  // Set while the flight in progress is someone else's layout (`flyTo`): no
  // re-plan, no recluster, no reblend — their Balance already chose all that.
  let external = false
  // Told once a local run ends, with the layout it left (commands.js writes
  // it to the map's doc then). Never for someone else's flight.
  let onSettled = null
  const collideOf = (id) => COLLIDE_RADIUS * graph.sizeOf(id)

  function plan() {
    external = false
    from = new Map()
    for (const node of graph.nodes.values()) from.set(node.id, [node.x, node.y, node.z])
    frame = 0
    if (orbitCentre !== null && graph.nodes.has(orbitCentre)) {
      to = computeOrbit(graph.nodes, graph.neighbours, orbitCentre, { collideOf, ...orbitPlane })
      return
    }
    orbitCentre = null
    // The tree Balance (`treeLayout.js`) unless `tree: 'off'` asks for the
    // constellation layout of round 1.
    if (treeShape !== 'off') {
      to = computeTreeLayout(graph.nodes, graph.edges, { collideOf, shape: treeShape }).positions
      last = null
      return
    }
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
    if (external) {
      // Cut short: land where they put it, so the graph matches the doc.
      writeBack(1)
      running = false
      external = false
      return
    }
    running = false
    if (!graph.reblend()) graph.touchContent()
    onSettled?.(graph.layoutSnapshot())
  }

  /**
   * Flies the stars to positions someone else's edit chose (a remote Balance
   * or move, through `docBridge.js`). Ids not in `targets` stay put — or, if
   * another such flight is already under way, carry on to where it was
   * taking them. A local run in flight is abandoned without settling: theirs
   * won (docBridge.js puts what that run changed back the way the doc has it).
   */
  function flyTo(targets) {
    const carried = running && external ? to : null
    running = false
    from = new Map()
    for (const node of graph.nodes.values()) from.set(node.id, [node.x, node.y, node.z])
    to = new Map(from)
    if (carried) for (const [id, target] of carried) if (from.has(id)) to.set(id, target)
    for (const [id, target] of targets) if (from.has(id)) to.set(id, target)
    frame = 0
    external = true
    running = true
  }

  /** Forgets the run. Call when the graph is replaced wholesale. */
  function reset() {
    // Not `stop()`: a reset follows a load, and fading the colours then would
    // compute blends for a file that was saved with its own.
    running = false
    external = false
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
    if (external) {
      // Someone else's flight: drop stars that are gone, hold new ones still.
      for (const id of [...to.keys()]) if (!graph.nodes.has(id)) to.delete(id)
      for (const node of graph.nodes.values()) {
        if (to.has(node.id)) continue
        from.set(node.id, [node.x, node.y, node.z])
        to.set(node.id, [node.x, node.y, node.z])
      }
      return
    }
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
    flyTo,
    get isRunning() {
      return running
    },
    /** True while the run in flight is this tab's own (a Balance or orbit), not someone else's flight. */
    get isLocalRun() {
      return running && !external
    },
    get onSettled() {
      return onSettled
    },
    set onSettled(callback) {
      onSettled = callback
    },
    /** The tree Balance's shape: 'disc', 'cone' or 'off'. Takes effect on the next run. */
    get treeShape() {
      return treeShape
    },
    set treeShape(shape) {
      treeShape = shape
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

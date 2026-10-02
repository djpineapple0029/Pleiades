import * as THREE from 'three'
import { NODE_RADIUS } from './graphView.js'
import { createStatus } from './status.js'
import { bindTextarea, trimText } from './room/notesBinding.js'
import { createCommands } from './commands.js'
import { rankNodes } from './search.js'
import { focusSetOf } from './heat.js'
import { orbitFocus, shortestPath } from './paths.js'
import { FLY_DURATION } from './flyTo.js'
import { createKeymap } from './keymap.js'
import { LOOKS } from './looks.js'
import { nodeName } from './ids.js'

const SPAWN_DISTANCE = 90 // world units ahead of the camera for a new node
const DOUBLE_CLICK_MS = 320
// Holding a submenu wedge (More…/Back) this long without releasing swaps the
// ring automatically. A quick arm-then-release still swaps instantly via the
// existing key dispatch below — this is only for staying on the wedge.
const SUBMENU_DWELL_MS = 850
// Search shows this many rows; the rest still light up in the scene.
const SEARCH_ROWS = 8
// Poses kept for Backspace to fly back through.
const MAX_JUMPS = 20

// Clockwise from the top. The type wedge takes the bottom-left: the side
// wedges are too narrow for a long label, and Edit and Delete keep the sides
// they had in the three-wedge menu. Five wedges, not six, on purpose: with six
// a flick straight right lands on the border between Edit and Move.
const NODE_MENU = [
  { key: 'connect', label: 'Connect' },
  { key: 'edit', label: 'Edit' },
  { key: 'move', label: 'Move' },
  { key: 'type', label: 'Type…' },
  { key: 'delete', label: 'Delete' },
]

// What a star is: plain, a core, or a nexus (a small shared connection point
// several stars link through). One sub-ring, the way More… is one for the
// map, naming the types themselves — short enough for any wedge — with the
// current one ticked. Picking one makes the star that type.
const typeOf = (node) => (node.is_core ? 'core' : node.is_nexus ? 'nexus' : 'star')
const TYPE_MENU = (node) =>
  [
    { key: 'star', label: 'Star' },
    { key: 'core', label: 'Core' },
    { key: 'nexus', label: 'Nexus' },
  ]
    .map((item) => (item.key === typeOf(node) ? { ...item, label: `${item.label} ✓` } : item))
    .concat({ key: 'back', label: 'Back' })

// Four wedges so Edit stays up and Delete down, as they were with two. Add
// nexus splits the link with a nexus at its middle, for more stars to share;
// Focus lights both of its stars' connections.
const EDGE_MENU = [
  { key: 'edit', label: 'Edit' },
  { key: 'split', label: 'Add nexus' },
  { key: 'delete', label: 'Delete' },
  { key: 'focus', label: 'Focus' },
]

// Right-click on empty space: no node/edge under the crosshair.
const MAP_MENU = [
  { key: 'new', label: 'New' },
  { key: 'open', label: 'Open' },
  { key: 'save', label: 'Save' },
  { key: 'export', label: 'Export' },
  { key: 'balance', label: 'Balance' },
  { key: 'more', label: 'More…' },
]

// A map kept on the server saves itself, so New and Open give way to the way
// back to the map list; saving a copy as a file moves to the More ring.
const SERVER_MAP_MENU = [
  { key: 'maps', label: 'My maps' },
  { key: 'save', label: 'Save' },
  { key: 'export', label: 'Export' },
  { key: 'balance', label: 'Balance' },
  { key: 'more', label: 'More…' },
]

// Overview up, Back down (a server map's "Save to file" pushes them to thirds).
// Looks are not here on purpose: they change only from their own key (V), so
// the right-button menus stay about the map.
const MORE_MENU = (onServer) => [
  { key: 'overview', label: 'Overview' },
  ...(onServer ? [{ key: 'save-file', label: 'Save to file' }] : []),
  { key: 'back', label: 'Back' },
]

const hex = (color) => `#${color.toString(16).padStart(6, '0')}`
const rgb = ([r, g, b]) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`

// A look as a row of the export panel's dropdown: its sky colour and star
// colours make the swatch.
const lookOption = (look) => ({
  value: look.id,
  label: look.name,
  detail: look.blurb,
  swatch: { ground: hex(look.palette.clear), dots: look.palette.tints.map(rgb) },
})

// The looks (`looks.js`), clockwise from the top, the current one ticked.
// Held open by the look key (V) and picked on its release.
const LOOK_MENU = (current) =>
  LOOKS.map((look) => ({ key: look.id, label: look.id === current?.id ? `${look.name} ✓` : look.name }))

// Sentinels for `menuTarget` when the menu isn't over a node or edge. Distinct
// object identities, never compared to `null` (which means "menu closed").
const MAP_TARGET = { kind: 'map', ring: 'top' }
const MAP_TARGET_MORE = { kind: 'map', ring: 'more' }
const LOOK_TARGET = { kind: 'look' }
const SHAPE_TARGET = { kind: 'shape' }

// The layout shapes (physics.js `treeShape`), clockwise from the top. Off is
// the constellation layout, which has no tree.
const SHAPES = [
  { id: 'cone', name: 'cone', label: 'Cone' },
  { id: 'disc', name: 'flat', label: 'Flat' },
  { id: 'off', name: 'off (no tree)', label: 'Off' },
]

// The shape ring, the current one ticked. Held open by the tree_shape key (T)
// and picked on its release, like the look ring.
const SHAPE_MENU = (current) =>
  SHAPES.map((shape) => ({ key: shape.id, label: shape.id === current ? `${shape.label} ✓` : shape.label }))

function sameTarget(a, b) {
  if (a === b) return true
  return Boolean(a && b) && a.kind === b.kind && a.id === b.id
}

/**
 * Everything the crosshair can do: spawn, target, menu, connect, edit, delete.
 *
 * Pointer lock stays held for the radial menu (raw mouse deltas) and for
 * renaming in place (`titleEdit.js`: keystrokes into a hidden field); both
 * suspend flight input while open and hand it back afterwards. Panels that
 * want a real cursor — notes editing, save/open prompts — release it through
 * `lock` (`pointerLock.js`) and get it back automatically when they close.
 * Tab into the overview is the one deliberate mode switch that leaves it off.
 *
 * Every change to the map goes through `commands.js`, which does the view and
 * physics syncing and records it on the undo stack — this module decides
 * *when* an edit happens, never how the rest of the app catches up with it.
 *
 * Saving and opening live here too rather than in `files.js`, because both need
 * the password panel, and the panel is a modal surface — only this module knows
 * whether one is already up, and only this module can suspend flight for it.
 *
 * With a `room` (a map opened from the account's list, live through its room:
 * room/roomClient.js), the map saves itself as it changes, the HUD says when
 * the connection is down (read-only until it's back) or saving is failing,
 * and the map menu leads back to the list (`leaveToMaps`).
 */
export function createInteraction({
  camera,
  controls,
  lock,
  flight,
  graph,
  view,
  physics,
  mapDoc,
  undo,
  files,
  overview,
  renderSettings,
  supernova,
  menu,
  editor,
  titleEdit,
  sidebar,
  search,
  flyTo,
  hud,
  speedEl,
  keymap = createKeymap(),
  room = null,
  leaveToMaps = () => {},
}) {
  const raycaster = new THREE.Raycaster()
  const crosshair = new THREE.Vector2(0, 0) // dead centre of the viewport
  const forward = new THREE.Vector3()
  const point = new THREE.Vector3()
  const status = createStatus(hud)
  // Every edit goes through here, which is what makes it undoable. In a room,
  // only while it says we may edit and the connection is up; an edit refused
  // for that says why, once a moment, instead of silently doing nothing.
  // The star or link a label or notes editor is open on, so a delete by
  // someone else can close it (closeAbout).
  let editingAbout = null
  // The notes textarea while it's open: read-only whenever the room is
  // (offline, or a viewer now), like every other edit (decision 21).
  let notesArea = null
  const canTypeNotes = () => !room || room.canEdit
  let refusedAt = -Infinity
  function canEdit() {
    if (!room || room.canEdit) return true
    const now = performance.now()
    if (now - refusedAt > 2000) {
      refusedAt = now
      status.notice(room.state === 'read_only' ? 'view only' : 'reconnecting… · changes are paused')
    }
    return false
  }
  const commands = createCommands({ graph, view, physics, mapDoc, undo, canEdit })
  // What the HUD keeps saying about the room until it changes: reconnecting,
  // or saving failing on the server. Null when there's nothing to say.
  let roomProblem = null

  let mode = 'idle' // idle | connecting | menu | editing | moving | searching | flying
  let hover = null // { kind, id } under the crosshair
  let sourceId = null // connection origin while mode is 'connecting'
  let moveId = null // node being relocated while mode is 'moving'
  let moveDistance = 0 // camera-to-node distance captured when the move started
  const lastGhostPoint = new THREE.Vector3()
  let menuTarget = null
  let heldKey = null // the action ('look' or 'tree_shape') whose held key has a ring open
  let dwellKey = null // submenu wedge ('more', 'type' or 'back') currently being held
  let dwellSince = 0
  let lastLeftDown = 0
  let lastSpeedText = null
  let busy = false // a file flow is somewhere between its first prompt and its result
  // True only across a `files.open()` await: closes the gap where `endModal()`
  // has already returned `mode` to 'idle' (the moment a password is submitted)
  // but the decrypt-and-swap it triggered hasn't resolved yet. `isModal` below
  // stays true through it, so a click can't re-lock and edit the old graph
  // right before it's replaced.
  let loading = false
  let sidebarKey = null // what the notes sidebar last showed: `${id}:${contentRevision}`
  // Click-to-focus: `{ kind, id }` of the star (or link) whose connections
  // alone stay lit, or null. Re-walked whenever the graph's revision moves, so
  // a link made or cut shows at once.
  let focusTarget = null
  let focusRevision = -1
  // Camera poses from before each search jump, newest last, for Backspace.
  const jumps = []
  const swatch = new THREE.Color()
  const starPosition = new THREE.Vector3()

  function aheadOfCamera(target) {
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
    return target.copy(camera.position).addScaledVector(forward, SPAWN_DISTANCE)
  }

  function clearHover() {
    hover = null
    view.setHover(null)
  }

  function describe(target) {
    if (!target) return null
    if (target.kind === 'node') {
      const node = graph.getNode(target.id)
      if (!node) return null
      if (node.is_nexus) return `nexus ${nodeName(node)} · joins ${graph.connectionsOf(node.id).size}`
      return `node ${nodeName(node)} · ${graph.degree(node.id)} links${node.is_core ? ' · core' : ''}`
    }
    const edge = graph.getEdge(target.id)
    if (!edge) return null
    const ends = `${nodeName(graph.getNode(edge.from))} — ${nodeName(graph.getNode(edge.to))}`
    return edge.label ? `edge ${edge.label} · ${ends}` : `edge ${ends}`
  }

  /** What the HUD shows: how to drive or leave the current mode or focus,
   *  a server map's save problem, and Balance's progress. Blank otherwise —
   *  names are on the stars themselves, and counts help nobody fly. */
  function hudLine() {
    if (mode === 'searching') return '↑↓ to choose · Enter to fly there · Esc to close'
    if (mode === 'connecting') {
      // Instruction first, so it survives an ellipsis on a narrow window.
      const key = keymap.label('connect')
      const how = key ? `click or ${key} on a star to link it` : 'click a star to link it'
      return `${how} · right-click cancels · from ${nodeName(graph.getNode(sourceId))}`
    }
    if (mode === 'moving')
      return `click to place · right-click cancels · moving ${nodeName(graph.getNode(moveId))}`
    if (mode === 'flying') return ''

    let text = ''
    if (overview.isActive) {
      // The overview hides the overlay, so the HUD is the only thing left
      // saying how to get out of it.
      const back = keymap.label('overview')
      text = back ? `${back} to fly` : ''
    } else if (focusTarget) {
      text = focusHint()
    } else if (roomProblem) {
      text = roomProblem
    }
    if (physics.isRunning) {
      const count = graph.clusterCount
      const clusters = count ? ` · ${count} cluster${count === 1 ? '' : 's'}` : ''
      text = [text, `balancing ${Math.round(physics.progress * 100)}%${clusters}`].filter(Boolean).join(' · ')
    }
    return text
  }

  /** How to leave the focus, and what it's on when that isn't obvious. */
  function focusHint() {
    const clear = 'click empty space to clear'
    if (focusTarget.kind === 'orbit') return `${keymap.label('undo')} goes back · ${clear}`
    if (focusTarget.kind === 'path') {
      const names = focusTarget.path.nodes.map((id) => nodeName(graph.getNode(id)))
      return `${names.join(' → ')} · ${clear}`
    }
    return `focused · ${clear}`
  }

  /** The full readout behind the HUD (`data-trace`, see `status.js`): where
   *  the crosshair is, or what's happening. */
  function traceLine() {
    if (mode === 'searching') return 'find a star · ↑↓ choose · Enter fly there · Esc close'
    if (mode === 'flying') {
      const node = hover?.kind === 'node' && graph.getNode(hover.id)
      return node ? `flying to ${nodeName(node)}` : 'flying back'
    }
    if (mode === 'connecting') {
      const source = graph.getNode(sourceId)
      // Instruction first, so it survives an ellipsis on a narrow window.
      return `left-click a node to link · right-click to cancel · from ${nodeName(source)}`
    }
    if (mode === 'moving') {
      const node = graph.getNode(moveId)
      return `moving ${nodeName(node)} · left-click to place · right-click to cancel`
    }

    let text
    if (overview.isActive) {
      // The overview hides the overlay, so the HUD is the only thing left
      // saying how to get out of it.
      const back = keymap.label('overview')
      text = `overview · ${graph.nodes.size} nodes · ${graph.edges.size} edges${back ? ` · ${back} to fly` : ''}`
    } else {
      // Unlocked there is no crosshair to describe, but the fallback still
      // says what's open, behind the overlay.
      const described = controls.isLocked && describe(hover)
      const focused = focusLine()
      if (described) {
        text = described
      } else if (focused) {
        text = focused
      } else if (room) {
        text = `${room.map?.name ?? 'map'} · ${roomStatusText()} · ${graph.nodes.size} nodes · ${graph.edges.size} edges`
      } else {
        const dirty = files.isDirty ? ' · unsaved' : ''
        text = `${files.filename}${dirty} · ${graph.nodes.size} nodes · ${graph.edges.size} edges`
      }
    }
    if (physics.isRunning) {
      const count = graph.clusterCount
      const clusters = count ? ` · ${count} cluster${count === 1 ? '' : 's'}` : ''
      text += ` · balancing ${Math.round(physics.progress * 100)}%${clusters}`
    }
    return text
  }

  function updateHud() {
    status.setState(hudLine(), traceLine())
    status.tick()
  }

  function updateSpeedReadout() {
    const speedText = `${flight.getSpeed().toFixed(2)}x`
    if (speedText === lastSpeedText) return
    lastSpeedText = speedText
    speedEl.textContent = speedText
  }

  /**
   * Focuses a star or a link (`{ kind, id }`): only its connections stay lit
   * and named. null, or a target that no longer exists, clears the focus.
   */
  function setFocus(target) {
    focusRevision = graph.revision
    let lit = null
    if (target?.kind === 'orbit') {
      // Only the tree the orbit is laid out along stays bright; every other
      // link crosses the rings and is what made the first try unreadable.
      lit = orbitFocus(graph, target.id)
    } else if (target?.kind === 'path') {
      // Re-walked from its two ends, so an edit along the way finds the new way round.
      const path = shortestPath(graph, target.from, target.to)
      if (path) {
        target.path = path
        lit = { nodes: new Set(path.nodes), edges: new Set(path.edges) }
      }
    } else lit = target && focusSetOf(graph, target)
    focusTarget = lit ? target : null
    view.setFocus(lit || null)
  }

  // The first star of a path (P on a star, then P on another), or null.
  let pathStart = null

  /** P on a star: the first marks where the path starts, the second shows it. */
  function pathKey() {
    const id = hover?.kind === 'node' ? hover.id : null
    if (!id) {
      pathStart = null
      view.setSource(null)
      status.info('path cancelled')
      return
    }
    if (!pathStart || pathStart === id || !graph.getNode(pathStart)) {
      pathStart = id
      view.setSource(id)
      status.notice(
        `path from ${nodeName(graph.getNode(id))} · aim at another star and press ${keymap.label('path')}`,
      )
      return
    }
    const from = pathStart
    pathStart = null
    view.setSource(null)
    setFocus({ kind: 'path', from, to: id })
    if (!focusTarget)
      status.notice(`no path between ${nodeName(graph.getNode(from))} and ${nodeName(graph.getNode(id))}`)
  }

  function focusLine() {
    if (!focusTarget) return null
    const clear = 'click empty space to clear'
    if (focusTarget.kind === 'edge') return `focus ${describe(focusTarget)} · ${clear}`
    if (focusTarget.kind === 'orbit') {
      const node = graph.getNode(focusTarget.id)
      return `orbit ${nodeName(node)} · rings are links away · ${keymap.label('undo')}: back · ${clear} for every link`
    }
    if (focusTarget.kind === 'path') {
      const names = focusTarget.path.nodes.map((id) => nodeName(graph.getNode(id)))
      const steps = names.length - 1
      return `path ${names.join(' → ')} · ${steps} link${steps === 1 ? '' : 's'} · ${clear}`
    }
    const node = graph.getNode(focusTarget.id)
    const count = graph.connectionsOf(node.id).size
    return `focus ${nodeName(node)} · ${count} connection${count === 1 ? '' : 's'} · ${clear}`
  }

  /** A click on the star or link under the crosshair focuses it; on it again, or on empty space, clears. */
  function clickFocus() {
    if (!hover) setFocus(null)
    else setFocus(sameTarget(hover, focusTarget) ? null : hover)
  }

  function update() {
    updateSpeedReadout()
    // A delete, a new link, a nexus flag: re-walk (or drop) the focus.
    if (focusTarget && graph.revision !== focusRevision) setFocus(focusTarget)

    if (mode === 'idle' || mode === 'connecting' || mode === 'moving') {
      if (!controls.isLocked) {
        if (hover) clearHover()
      } else {
        raycaster.setFromCamera(crosshair, camera)
        const target = view.raycast(raycaster)
        if (!sameTarget(target, hover)) {
          hover = target
          view.setHover(target)
        }
      }
    }

    if (mode === 'connecting') {
      const end = hover?.kind === 'node' && hover.id !== sourceId ? graph.getNode(hover.id) : null
      if (end) point.set(end.x, end.y, end.z)
      else aheadOfCamera(point)
      view.setPending(sourceId, point)
    }

    if (mode === 'moving') {
      const node = graph.getNode(moveId)
      if (node) {
        const anchor = hover?.kind === 'node' && hover.id !== moveId ? graph.getNode(hover.id) : null
        forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
        if (anchor) {
          // Snap-to-touch, mirroring spawnNode's anchor logic: place just off
          // the hovered node's surface, toward the camera.
          const offset = view.radiusOf(anchor.id) + view.radiusOf(moveId)
          point.set(anchor.x, anchor.y, anchor.z).addScaledVector(forward, -offset)
        } else {
          // Plane-tracking at the distance captured in startMove: pitch/yaw
          // swings the node around the camera at constant radius; flying
          // forward/back reels it in or pushes it out.
          point.copy(camera.position).addScaledVector(forward, moveDistance)
        }
        view.setGhost(moveId, point)
        lastGhostPoint.copy(point)
      }
    }

    const submenuKey = mode === 'menu' ? submenuKeyOf(menuTarget) : null
    if (submenuKey) {
      // Held on the ring's submenu wedge without releasing: charge, then
      // auto-swap. A quick arm-then-release still swaps instantly through
      // the ordinary key dispatch in closeMenu — this only covers staying.
      if (menu.armed === submenuKey) {
        if (dwellKey !== submenuKey) {
          dwellKey = submenuKey
          dwellSince = performance.now()
          menu.charge(true)
        } else if (performance.now() - dwellSince >= SUBMENU_DWELL_MS) {
          dwellKey = null
          menu.charge(false)
          swapRing(menuTarget)
        }
      } else if (dwellKey !== null) {
        dwellKey = null
        menu.charge(false)
      }
    } else if (dwellKey !== null) {
      dwellKey = null
      menu.charge(false)
    }

    updateSidebar()
    updateHud()
  }

  /** Strictly the star under the crosshair, only while flying. */
  function updateSidebar() {
    if (!sidebar.isVisible || sidebar.isEditing || mode === 'editing') return
    const node = controls.isLocked && hover?.kind === 'node' ? graph.getNode(hover.id) : null
    const key = node ? `${node.id}:${graph.contentRevision}` : ''
    if (key === sidebarKey) return
    sidebarKey = key
    sidebar.show(node && { name: nodeName(node), notes: node.notes })
  }

  function spawnNode() {
    // Normally a short way ahead of the camera. But if a node is under the
    // crosshair, stack the new one right on it — nudged back toward the camera
    // by a couple of radii so it stays in front and stays pickable — which is
    // what "place on top of that sphere" should do.
    const anchor = hover?.kind === 'node' ? graph.getNode(hover.id) : null
    if (anchor) {
      forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
      // A new node is unlinked, so base size: the two spheres just touch.
      const offset = view.radiusOf(anchor.id) + NODE_RADIUS
      point.set(anchor.x, anchor.y, anchor.z).addScaledVector(forward, -offset)
    } else {
      aheadOfCamera(point)
    }
    commands.spawn(point)
  }

  function startConnect(nodeId) {
    mode = 'connecting'
    sourceId = nodeId
    view.setSource(nodeId)
  }

  function cancelConnect() {
    mode = 'idle'
    sourceId = null
    view.setSource(null)
    view.setPending(null)
  }

  /** The connect key: on a star it starts a link, on a second star it makes
   *  it. Pressed anywhere else mid-link, it cancels, like the path key. */
  function connectKey() {
    const id = hover?.kind === 'node' ? hover.id : null
    if (mode === 'idle') {
      if (id) startConnect(id)
      return
    }
    if (id && id !== sourceId) confirmConnect()
    else cancelConnect()
  }

  function confirmConnect() {
    // Anything but another node leaves the connection pending — only
    // right-click and Esc cancel it.
    if (hover?.kind !== 'node' || hover.id === sourceId) return
    commands.connect(sourceId, hover.id)
    cancelConnect()
  }

  // Flight stays enabled throughout, exactly like connecting: re-aiming by
  // looking or flying is the only way to steer the ghost with no free cursor.
  function startMove(nodeId) {
    mode = 'moving'
    moveId = nodeId
    const node = graph.getNode(nodeId)
    moveDistance = camera.position.distanceTo(new THREE.Vector3(node.x, node.y, node.z))
    lastGhostPoint.set(node.x, node.y, node.z) // ghost starts exactly at the node — no jump
  }

  function cancelMove() {
    mode = 'idle'
    moveId = null
    view.clearGhost()
  }

  function commitMove() {
    commands.move(moveId, lastGhostPoint)
    moveId = null
    view.clearGhost()
    mode = 'idle'
  }

  function deleteNode(nodeId) {
    if (sourceId === nodeId) cancelConnect()
    if (moveId === nodeId) cancelMove()
    // Read before the delete: after it the node, its size and tint are gone.
    // With motion off the star just goes, with no burst at all.
    const node = graph.getNode(nodeId)
    if (node && !renderSettings?.reducedMotion && renderSettings?.supernova !== false) {
      supernova?.burst({ position: node, radius: view.radiusOf(nodeId), tint: view.tintOf(nodeId) })
    }
    commands.deleteNode(nodeId)
    clearHover()
  }

  // Both modal surfaces need the keyboard and the mouse to themselves.
  function beginModal() {
    flight.setEnabled(false)
    controls.enabled = false
  }

  function endModal() {
    mode = 'idle'
    flight.setEnabled(true)
    controls.enabled = true
  }

  /**
   * Enter on a targeted star or connection: the label itself becomes the text
   * field, and pointer lock is kept throughout. Mouse-look is frozen so the
   * label stays put, and the target stays pinned as hovered so its label is
   * drawn whatever its range. Esc (or any lock loss) discards the text.
   */
  async function editTitle(target) {
    const item = target.kind === 'node' ? graph.getNode(target.id) : graph.getEdge(target.id)
    if (!item) return
    mode = 'editing'
    beginModal()
    hover = target
    view.setHover(target)
    editingAbout = { kind: target.kind, id: target.id }
    const value = await titleEdit.start(item.label, (text) => view.setLabelDraft(target, text))
    editingAbout = null
    view.setLabelDraft(null)
    endModal()
    if (value === null) return
    if (target.kind === 'node') {
      const node = graph.getNode(target.id)
      if (node) commands.setNodeText(node.id, value, node.notes)
    } else if (graph.getEdge(target.id)) {
      commands.setEdgeLabel(target.id, value)
    }
  }

  /**
   * Ctrl/Cmd+Enter on a targeted star: full notes editing in the sidebar, with a
   * real cursor, live — typing goes straight into the star's shared text
   * (decision 8), so losing the lock or the connection never loses it. Done
   * keeps it as one undo step; Esc takes this session's typing back out.
   * Pointer lock comes back by itself either way — the app released it, so
   * re-locking needs no click.
   */
  async function editNotes(node) {
    const session = commands.editNotes(node.id)
    if (!session) return // read-only: canEdit has said why
    await lock.release('panel')
    mode = 'editing'
    beginModal()
    editingAbout = { kind: 'node', id: node.id }
    let binding = null
    try {
      const kept = await sidebar.edit(nodeName(node), (textarea) => {
        binding = bindTextarea(textarea, session.text, { origin: mapDoc.LOCAL })
        notesArea = textarea
        notesArea.readOnly = !canTypeNotes()
      })
      binding?.destroy()
      binding = null
      endModal()
      if (kept) {
        // A local map's notes are trimmed on Done, as Save always did. Not
        // in a room: the ends may be someone else's typing.
        if (!room) trimText(session.text, mapDoc.LOCAL)
        session.end()
      } else session.discard()
    } finally {
      binding?.destroy()
      if (notesArea) notesArea.readOnly = false
      notesArea = null
      editingAbout = null
      if (mode === 'editing') endModal()
      sidebarKey = null // view mode redraws from scratch
      lock.resume()
    }
  }

  /** Opens the editor panel as a modal and hands back what it collected. */
  async function prompt(title, fields, note, commitLabel) {
    await lock.release('panel')
    mode = 'editing'
    beginModal()
    try {
      return await editor.open(title, fields, note, commitLabel)
    } finally {
      endModal()
      lock.resume()
    }
  }

  /**
   * `Ctrl/Cmd+S`. The first save asks for a name and a password, and confirms
   * the password: a typo in it produces a file nobody can ever open again. A
   * blank password saves an unencrypted file — no confirmation step, that's a
   * deliberate choice by whoever's typing, not something to nag about.
   * Afterwards the session holds both (even a deliberately blank password
   * counts) and this is a single keystroke, until `Shift` asks again.
   */
  async function saveMap({ reprompt }) {
    // A server map saves itself; Save asks its room to do it now, and Save
    // As is still a file.
    if (room && !reprompt) return saveRoomNow()
    if (busy) {
      status.notice('a file operation is still in progress')
      return { ok: false }
    }
    busy = true
    let note = null
    // Carried across retries: a mistyped confirmation should not also cost the
    // user the name they typed into a different field.
    let name = files.filename
    // Held across the whole loop, so a mismatch re-prompt doesn't flash the
    // lock back on between two panels.
    let prompting = !files.hasCredentials || reprompt
    if (prompting) await lock.release('panel')
    const endPrompting = () => {
      if (prompting) lock.resume()
      prompting = false
    }
    try {
      while (!files.hasCredentials || reprompt) {
        const values = await prompt(
          room ? 'save a copy to a file' : files.hasCredentials ? 'save as' : 'save map',
          [
            { key: 'filename', label: 'File name', value: name },
            { key: 'password', label: 'Password (optional)', type: 'password' },
            { key: 'confirm', label: 'Confirm password', type: 'password' },
          ],
          note,
          'Save',
        )
        if (!values) return { ok: false }
        name = values.filename
        if (!values.password) {
          files.setCredentials('', values.filename)
          break
        }
        if (values.password !== values.confirm) {
          note = 'Passwords do not match.'
          continue
        }
        files.setCredentials(values.password, values.filename)
        break
      }

      // Before the save, not after: the download it starts can pull focus to
      // the browser's download UI, and Chrome won't re-lock once it has.
      endPrompting()
      status.busy(`saving ${files.filename}`)
      const result = await files.save()
      // "saved" would claim more than is true the instant this resolves — the
      // browser hasn't necessarily finished writing the download yet.
      if (result.ok) status.success(`downloaded ${files.filename}`)
      else status.error(`save failed: ${result.error}`)
      return result
    } finally {
      busy = false
      endPrompting()
    }
  }

  /** Ctrl/Cmd+S on a server map: the room saves at once rather than in a moment. */
  async function saveRoomNow() {
    status.busy('saving')
    const ok = await room.flush()
    if (ok) status.success('saved')
    else
      status.error(room.state === 'live' ? 'not saved · the server is having trouble' : 'not saved · offline')
    return { ok }
  }

  /** The map menu's "My maps": saved first, so the list shows what was just done. */
  async function backToMaps() {
    if (busy) return
    busy = true
    status.busy('saving')
    try {
      await room.flush()
    } finally {
      busy = false
    }
    leaveToMaps()
  }

  /** The trace line's word for the room's connection. */
  function roomStatusText() {
    if (room.state === 'live') return 'live'
    if (room.state === 'read_only') return 'view only'
    if (room.state === 'offline') return 'reconnecting'
    if (room.state === 'closed') return 'closed'
    return 'connecting'
  }

  /** The room's connection changed (roomClient.js `onState`; main.js also
   *  passes the state the map opened in). */
  let lastRoomState = null
  function roomState(state) {
    const before = lastRoomState
    lastRoomState = state
    if (notesArea) notesArea.readOnly = !canTypeNotes()
    if (state === 'offline') {
      roomProblem = 'reconnecting… · changes are paused'
    } else if (roomProblem?.startsWith('reconnecting')) {
      roomProblem = null
      status.notice(state === 'read_only' ? 'reconnected · view only' : 'reconnected')
    } else if (state === 'read_only' && before !== 'read_only') {
      status.notice('view only')
    }
  }

  /** A message from the room (roomClient.js `onControl`) once the map is open. */
  function roomMessage(message) {
    if (message.type === 'error' && message.code === 'not_saved') {
      roomProblem = 'not saved · server problem (retrying)'
    } else if (message.type === 'saved' && roomProblem?.startsWith('not saved')) {
      roomProblem = null
      status.notice('saved again')
    } else if (message.type === 'error' && message.code === 'bad_update') {
      roomProblem = 'the server refused an edit from this tab · reload'
    }
  }

  /** Says, and keeps saying, why this map can't be used any more. */
  function roomEnded(text) {
    roomProblem = text
  }

  /** A modal panel of keyed choices; the chosen key, or null for Esc. */
  async function askChoice(title, note, choices) {
    await lock.release('panel')
    try {
      mode = 'editing'
      beginModal()
      const choice = await editor.confirm(title, note, choices)
      endModal()
      return choice
    } finally {
      if (mode === 'editing') endModal()
      lock.resume()
    }
  }

  /** Everyone else in the room who can edit (decision 12: viewers don't count). */
  function otherEditors() {
    if (!room) return []
    const me = room.you?.conn
    const names = new Set()
    for (const person of room.roster) {
      if (person.conn !== me && (person.role === 'editor' || person.role === 'owner')) names.add(person.name)
    }
    return [...names]
  }

  const listNames = (names) =>
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

  /**
   * True to go ahead with a layout that moves every star for everyone in the
   * map (decision 12): asks first while other editors are in it.
   */
  async function rearrangeForEveryone(what) {
    const others = otherEditors()
    if (!others.length) return true
    const choice = await askChoice(
      `${listNames(others)} ${others.length === 1 ? 'is' : 'are'} editing. Rearrange the map for everyone?`,
      `${what} moves every star, for everyone in this map. Undo takes it back.`,
      [{ key: 'r', label: 'R: rearrange' }],
    )
    return choice === 'r'
  }

  /** Balance (B, the map menu, a shape from T). Stopping a run is instant. */
  async function balance() {
    if (physics.isLocalRun) return commands.toggleBalance()
    if (!(await rearrangeForEveryone('Balance'))) return null
    return commands.toggleBalance()
  }

  /** Orbit (O on a star): a whole-map layout like Balance, so it asks the same. */
  async function orbit(id, plane) {
    if (!(await rearrangeForEveryone('Orbit'))) return
    if (graph.getNode(id) && commands.orbitAround(id, plane)) setFocus({ kind: 'orbit', id })
  }

  /**
   * Someone else deleted this star or link (docBridge.js `onRemoved`):
   * anything open about it closes (decision 10), and the HUD says what went.
   */
  function closeAbout({ kind, id, label, at }) {
    // Their delete plays like a local one (decision 11): the star still has
    // its drawn size and tint here, the view hasn't caught up yet.
    if (kind === 'node' && at && !renderSettings?.reducedMotion && renderSettings?.supernova !== false) {
      supernova?.burst({ position: at, radius: view.radiusOf(id), tint: view.tintOf(id) })
    }
    if (menuTarget && menuTarget.kind === kind && menuTarget.id === id) {
      menu.close()
      menuTarget = null
      endModal()
    }
    if (editingAbout && editingAbout.kind === kind && editingAbout.id === id) {
      if (titleEdit.isActive) titleEdit.cancel()
      if (sidebar.isEditing) sidebar.cancel()
      if (editor.isOpen) editor.cancel()
    }
    if (kind === 'node') {
      if (sourceId === id) cancelConnect()
      if (moveId === id) cancelMove()
      if (pathStart === id) pathStart = null
    }
    if (hover?.kind === kind && hover.id === id) clearHover()
    if (focusTarget?.kind === kind && focusTarget.id === id) setFocus(null)
    if (kind === 'node') status.notice(`${label || 'a star'} was deleted`)
  }

  /**
   * `Ctrl/Cmd+O`. Pointer lock goes first and stays gone: the file dialog is a
   * native window, so the browser would drop the lock to show it anyway, and
   * releasing it deliberately means the state machine lands somewhere clean
   * instead of being unwound mid-flow. It comes back by itself once the flow
   * settles, however it ends.
   */
  async function openMap() {
    if (room) {
      status.notice('this map saves to your account; open files in the app without an account')
      return
    }
    if (busy) {
      status.notice('a file operation is still in progress')
      return
    }
    // Not awaited: the picker needs this keypress's user activation, and the
    // file dialog would drop the lock anyway.
    lock.release('file')
    try {
      await openPicked()
    } finally {
      lock.resume()
    }
  }

  async function openPicked() {
    const file = await files.pickFile()
    if (!file) return

    // Ask before pickFile settles, not before: a cancelled picker should
    // never nag about a map it isn't going to touch.
    if (!(await confirmDirty('Opening replaces this map.'))) return

    // Taken only now that a file is actually going to be opened — a pick
    // that never settles leaks a promise but blocks nothing.
    busy = true
    try {
      // A file saved with no password needs no prompt at all — and reading
      // the header costs nothing, so there's no reason to ask first.
      const probed = await files.probe(file)
      if (probed && !probed.needsPassword) {
        loading = true
        status.busy(`opening ${file.name}`)
        const result = await files.open(file, '')
        loading = false
        if (result.ok) {
          commands.clear()
          forgetJumps()
          status.success(`opened ${file.name} · ${graph.nodes.size} nodes · ${graph.edges.size} edges`)
          overview.refit()
          return
        }
        status.error(`open failed: ${result.error}`)
        return
      }

      let note = null
      for (;;) {
        const values = await prompt(
          `open ${file.name}`,
          [{ key: 'password', label: 'Password', type: 'password' }],
          note,
          'Open',
        )
        if (!values) return

        // `endModal()` above already returned `mode` to 'idle' the instant
        // the password was submitted — `loading` is what keeps `isModal`
        // true for the decrypt-and-swap that's about to run, so a click
        // can't re-lock and edit the old graph moments before it's replaced.
        loading = true
        status.busy(`opening ${file.name}`)
        const result = await files.open(file, values.password)
        loading = false
        if (result.ok) {
          commands.clear()
          forgetJumps()
          status.success(`opened ${file.name} · ${graph.nodes.size} nodes · ${graph.edges.size} edges`)
          // A no-op unless the overview is up, where the orbit would otherwise
          // still be circling the previous map's centre.
          overview.refit()
          return
        }
        // A wrong password is the one failure worth another go at the panel;
        // a corrupt file or a dead server will not read any differently.
        if (!result.wrongPassword) {
          status.error(`open failed: ${result.error}`)
          return
        }
        note = result.error
      }
    } finally {
      busy = false
      loading = false
    }
  }

  /**
   * `Ctrl/Cmd+E`. Writes a standalone view-only `.html` of the map as it stands.
   * No password is asked for and none is used: the export is a plaintext file
   * meant to be handed to someone, which is why `files.exportHtml` leaves notes
   * out of it. Nothing about the current session changes — this is not a save,
   * and it does not adopt a filename or credentials. Asks first which look the
   * file opens in, starting on the one showing now; Enter takes that.
   */
  async function exportMap() {
    if (busy) {
      status.notice('a file operation is still in progress')
      return
    }
    busy = true
    try {
      const values = await prompt(
        `export ${files.exportFilename}`,
        [
          {
            key: 'look',
            label: 'Opens in',
            type: 'select',
            value: renderSettings.looks.current?.id,
            options: LOOKS.map(lookOption),
          },
        ],
        null,
        'Export',
      )
      if (!values) return
      status.busy('exporting')
      const result = await files.exportHtml({ look: values.look })
      if (result.ok) status.success(`exported ${result.filename}`)
      else status.error(`export failed: ${result.error}`)
    } finally {
      busy = false
    }
  }

  /**
   * Ctrl/Cmd+Z and its redo chords. Works flying, in the overview and
   * unlocked; never under a menu or panel (the caller's guard), so native
   * undo inside a text field is left alone. A connect or move in progress is
   * dropped first — it may hang off the very node the step removes.
   */
  function stepHistory(direction) {
    if (loading) {
      status.notice('a file is being opened')
      return
    }
    if (mode === 'connecting') cancelConnect()
    else if (mode === 'moving') cancelMove()
    const label = direction === 'undo' ? commands.undo() : commands.redo()
    // The step may have removed whatever was under the crosshair; the next
    // frame's raycast picks up whatever is there now.
    clearHover()
    if (label) status.info(`${direction}: ${label}`)
    else status.notice(`nothing to ${direction}`)
  }

  /**
   * Guards Open and New map against silently discarding unsaved work.
   * Resolves `true` if it's safe to proceed — nothing was dirty, the user
   * chose to discard, or a save-first succeeded — or `false` if the caller
   * should stop: the user cancelled, or a save-first failed.
   */
  async function confirmDirty(note) {
    if (!files.isDirty) return true
    await lock.release('panel')
    try {
      mode = 'editing'
      beginModal()
      const choice = await editor.confirm(`unsaved changes in ${files.filename}`, note, [
        { key: 's', label: 'S: save first' },
        { key: 'd', label: 'D: discard' },
      ])
      endModal()
      if (choice === 'd') return true
      if (choice === 's') {
        const result = await saveMap({ reprompt: false })
        return Boolean(result?.ok)
      }
      return false // Esc, or the panel was torn down by a lock loss
    } finally {
      if (mode === 'editing') endModal()
      lock.resume()
    }
  }

  /** The map menu's New: replaces the graph, mirroring `files.applyPayload`'s
   *  own reset order, then forgets any password/filename this session had. */
  async function newMap() {
    if (!(await confirmDirty('Starting a new map replaces this map.'))) return
    physics.stop()
    // Dead under today's UI — a right-click already cancels connect/move
    // before the map menu can even open — kept as cheap insurance.
    if (mode === 'connecting') cancelConnect()
    else if (mode === 'moving') cancelMove()
    graph.load({ nodes: [], edges: [] })
    mapDoc.replace({ nodes: [], edges: [] })
    physics.reset()
    view.sync()
    commands.clear()
    forgetJumps()
    files.clearCredentials()
    files.reset()
    clearHover()
    overview.refit()
  }

  /** One search row per hit: the star's drawn colour, its name, its links. */
  function searchRow(hit) {
    const tint = view.tintOf(hit.id)
    // Linear, as the shader has it; getStyle hands back sRGB for CSS.
    const colour = tint ? swatch.setRGB(tint[0], tint[1], tint[2]).getStyle() : 'currentColor'
    const links = `${hit.degree} link${hit.degree === 1 ? '' : 's'}`
    return {
      id: hit.id,
      label: hit.label,
      mark: hit.mark,
      swatch: colour,
      meta: hit.isCore ? `core · ${links}` : graph.getNode(hit.id)?.is_nexus ? `nexus · ${links}` : links,
    }
  }

  function searchLookup(query) {
    const hits = rankNodes(graph.nodes.values(), query, graph.degree)
    // Every match lights up, not only the rows shown; no query dims nothing.
    view.setEmphasis(query.trim() ? hits.map((hit) => hit.id) : null)
    let note = null
    if (query.trim() && !hits.length) note = 'no star by that name'
    else if (hits.length > SEARCH_ROWS) note = `${hits.length} matches · showing the first ${SEARCH_ROWS}`
    return { rows: hits.slice(0, SEARCH_ROWS).map(searchRow), note }
  }

  /** The highlighted row's star gets the amber ring and its label, whatever its range. */
  function searchPreview(id) {
    hover = id ? { kind: 'node', id } : null
    view.setHover(hover)
  }

  function canSearch() {
    return (controls.isLocked && mode === 'idle') || (overview.isOrbiting && mode === 'idle')
  }

  /**
   * `/` or Ctrl/Cmd+F: find a star by name and fly to it. Pointer lock is
   * kept while flying; from the overview the flight also ends the overview.
   */
  async function openSearch() {
    if (graph.nodes.size === 0) {
      status.notice('no stars yet')
      return
    }
    const fromOverview = overview.isActive
    mode = 'searching'
    beginModal()
    const id = await search.start(searchLookup, searchPreview)
    // Torn down underneath (a lock loss): that path has already tidied up.
    if (mode !== 'searching') return
    const node = id && graph.getNode(id)
    if (!node) {
      view.setEmphasis(null)
      clearHover()
      endModal()
      return
    }
    jumps.push({ position: camera.position.clone(), quaternion: camera.quaternion.clone() })
    if (jumps.length > MAX_JUMPS) jumps.shift()
    // A keypress, so the lock may be asked for straight away. A refusal is
    // reported by main.js; the flight goes ahead regardless.
    if (fromOverview && overview.isActive) overview.toggle()
    mode = 'flying'
    searchPreview(id)
    const aim = () => {
      const star = graph.getNode(id)
      return star && { position: starPosition.set(star.x, star.y, star.z), radius: view.radiusOf(id) }
    }
    flyTo.toStar(aim, renderSettings.reducedMotion ? 0 : FLY_DURATION, () => {
      // The other matches stay lit until the flight lands.
      view.setEmphasis(null)
      endModal()
    })
  }

  /** Backspace: back to where the camera was before the last search jump. */
  function flyBack() {
    const pose = jumps.pop()
    if (!pose) {
      status.notice('nothing to fly back to')
      return
    }
    mode = 'flying'
    beginModal()
    clearHover()
    flyTo.toPose(pose.position, pose.quaternion, renderSettings.reducedMotion ? 0 : FLY_DURATION, endModal)
  }

  /** A roster bubble: fly to a camera pose (behind someone, looking where they look). */
  function flyToPose(position, quaternion) {
    if (mode !== 'idle' && mode !== 'flying') return
    jumps.push({ position: camera.position.clone(), quaternion: camera.quaternion.clone() })
    mode = 'flying'
    beginModal()
    clearHover()
    flyTo.toPose(position, quaternion, renderSettings.reducedMotion ? 0 : FLY_DURATION, endModal)
  }

  /** Poses and a focus from one map mean nothing in another. */
  function forgetJumps() {
    jumps.length = 0
    setFocus(null)
    pathStart = null
  }

  function openMenu(target, ring = 'top') {
    if (!describe(target)) return
    menuTarget = { kind: target.kind, id: target.id, ring }
    mode = 'menu'
    beginModal() // idempotent if already modal from the ring we're leaving
    if (target.kind === 'edge') menu.open(EDGE_MENU)
    else menu.open(ring === 'top' ? NODE_MENU : TYPE_MENU(graph.getNode(target.id)))
  }

  /** The wedge that swaps a ring for its other one, or null for a ring with none. */
  function submenuKeyOf(target) {
    if (target?.kind === 'map') return target.ring === 'top' ? 'more' : 'back'
    if (target?.kind === 'node') return target.ring === 'top' ? 'type' : 'back'
    return null
  }

  function swapRing(target) {
    if (target.kind === 'map') openMapMenu(target.ring === 'top' ? 'more' : 'top')
    else openMenu(target, target.ring === 'top' ? 'type' : 'top')
  }

  // `ring` re-opens the widget with a different item array rather than
  // teaching it to nest: `menu.close()` has already hidden/cleared the SVG by
  // the time "More…" is dispatched, so this is a clean re-open, not a stack.
  function openMapMenu(ring = 'top') {
    menuTarget = ring === 'top' ? MAP_TARGET : MAP_TARGET_MORE
    mode = 'menu'
    beginModal() // idempotent if already modal from the ring we're leaving — do not guard it
    const top = room ? SERVER_MAP_MENU : MAP_MENU
    menu.open(ring === 'top' ? top : MORE_MENU(Boolean(room)))
  }

  /**
   * A ring held open by a key (look: V, tree_shape: T) and picked on that
   * key's release rather than the right button's.
   */
  function openKeyMenu(action) {
    menuTarget = action === 'look' ? LOOK_TARGET : SHAPE_TARGET
    heldKey = action
    mode = 'menu'
    beginModal()
    menu.open(action === 'look' ? LOOK_MENU(renderSettings.looks.current) : SHAPE_MENU(physics.treeShape))
  }

  function closeMenu() {
    const key = menu.close()
    const target = menuTarget
    menuTarget = null
    endModal()
    heldKey = null
    if (!key || !target) return

    if (target.kind === 'look') {
      const look = LOOKS.find((item) => item.id === key)
      if (look && look !== renderSettings.looks.current) {
        renderSettings.looks.set(look.id)
        status.info(`look: ${look.name} · hold ${keymap.label('look')} to change`)
      }
      return
    }

    // The layout's shape (context/BALANCE2.md §8), balanced with it straight
    // away — one undo entry, like B. Picking the current shape re-balances.
    if (target.kind === 'shape') {
      const shape = SHAPES.find((item) => item.id === key)
      if (!shape) return
      physics.treeShape = shape.id
      if (physics.isRunning) physics.stop()
      balance()
      status.info(`layout: ${shape.name} · hold ${keymap.label('tree_shape')} to change`)
      return
    }

    if (target.kind === 'map') {
      if (target.ring === 'top') {
        if (key === 'more') return openMapMenu('more')
        if (key === 'maps') backToMaps()
        else if (key === 'new') newMap()
        else if (key === 'open') openMap()
        else if (key === 'save') saveMap({ reprompt: false })
        else if (key === 'export') exportMap()
        else if (key === 'balance') balance()
        return
      }
      if (key === 'back') return openMapMenu('top')
      if (key === 'overview') overview.toggle()
      else if (key === 'save-file') saveMap({ reprompt: true })
      return
    }

    if (target.kind === 'node') {
      const node = graph.getNode(target.id)
      if (!node) return
      if (key === 'type' || key === 'back') return swapRing(target)
      const hit = { kind: 'node', id: node.id }
      if (key === 'connect') startConnect(node.id)
      else if (key === 'edit') editTitle(hit)
      else if (key === 'move') startMove(node.id)
      else if (key === 'star' || key === 'core' || key === 'nexus') commands.setType(node.id, key)
      else if (key === 'delete') deleteNode(node.id)
      return
    }

    const edge = graph.getEdge(target.id)
    if (!edge) return
    if (key === 'edit') editTitle({ kind: 'edge', id: edge.id })
    else if (key === 'focus') setFocus({ kind: 'edge', id: edge.id })
    else if (key === 'split') {
      commands.splitEdge(edge.id)
      clearHover()
    } else if (key === 'delete') {
      commands.deleteEdge(edge.id)
      clearHover()
    }
  }

  function onMouseDown(event) {
    // A click mid-rename would pull focus out of the hidden text field.
    if (titleEdit.isActive) event.preventDefault()
    if (!controls.isLocked || mode === 'editing' || mode === 'searching' || mode === 'flying') return

    if (event.button === 2) {
      event.preventDefault()
      if (mode === 'menu') return
      if (mode === 'connecting') cancelConnect()
      else if (mode === 'moving') cancelMove()
      else if (hover) openMenu(hover)
      else openMapMenu()
      return
    }

    if (event.button !== 0 || mode === 'menu') return

    if (mode === 'moving') {
      commitMove()
      return
    }

    const now = performance.now()
    // Reset rather than carry forward, so a third click can't chain a spawn.
    const isDouble = now - lastLeftDown < DOUBLE_CLICK_MS
    lastLeftDown = isDouble ? 0 : now

    // Idle, a double-click always spawns — even with a node under the crosshair,
    // so you can stack a sphere on top of another. Mid-connection it only spawns
    // in open space (that is how a chain gets built: drop the far end, click to
    // link); a double-click onto a node there confirms the link instead.
    if (isDouble && (mode === 'idle' || !hover)) {
      // A new star belongs to no focus, and would only appear dimmed in one.
      if (mode === 'idle') setFocus(null)
      spawnNode()
    } else if (mode === 'connecting') confirmConnect()
    // A single click, idle: focus the star or link under the crosshair, or
    // clear the focus on it again or on empty space. The first click of a double-click
    // lands here too, which is harmless: the spawn still follows.
    else if (mode === 'idle' && !isDouble) clickFocus()
  }

  function onMouseUp(event) {
    // A ring held open by a key closes on that key's release instead.
    if (event.button === 2 && mode === 'menu' && !heldKey) {
      event.preventDefault()
      closeMenu()
    }
  }

  function onMouseMove(event) {
    if (mode === 'menu') menu.track(event.movementX, event.movementY)
  }

  function onKeyUp(event) {
    if (heldKey && mode === 'menu' && keymap.is(event, heldKey)) closeMenu()
  }

  function onKeyDown(event) {
    // While the editor is up it stops keydown from reaching this window
    // listener at all; this is the guard for the frame either side of that.
    // The search field stops its own keys too; a flight takes no input at all.
    if (mode === 'editing' || mode === 'searching' || mode === 'flying') return
    const is = (id) => keymap.is(event, id)

    // File chords and undo first, and always with preventDefault, so the
    // browser's own save-page and open-file dialogs never see the chord.
    if (mode !== 'menu') {
      // Save-as before save: with the defaults Mod+Shift+S is the same key
      // plus Shift, and exact Shift matching keeps them apart anyway.
      for (const [id, run] of [
        ['save_as', () => saveMap({ reprompt: true })],
        ['save', () => saveMap({ reprompt: false })],
        ['open', () => openMap()],
        ['export', () => exportMap()],
        ['undo', () => stepHistory('undo')],
        ['redo', () => stepHistory('redo')],
      ]) {
        if (is(id)) {
          event.preventDefault()
          if (!event.repeat) run()
          return
        }
      }
    }

    // Only taken from the browser when there's a map to search: over the
    // click-to-fly screen its own find bar (Ctrl/Cmd+F) is left alone.
    if (is('search') && canSearch()) {
      // Or a typed key (/) lands in the field that's about to take focus.
      event.preventDefault()
      if (!event.repeat) openSearch()
      return
    }

    // The one mode switch that releases pointer lock, so it is also the one
    // keypress that has to work while unlocked. `preventDefault` because Tab
    // would otherwise walk the browser's focus ring off the canvas.
    if (is('overview') && !event.repeat && mode !== 'menu') {
      event.preventDefault()
      overview.toggle()
      return
    }

    // Rename what's under the crosshair in place, or open its notes. Unlocked,
    // Enter belongs to `main.js` (it takes the lock back).
    if (!event.repeat && controls.isLocked && mode === 'idle' && hover) {
      if (is('edit_notes')) {
        event.preventDefault()
        if (hover.kind === 'node') {
          const node = graph.getNode(hover.id)
          if (node) editNotes(node)
        }
        return
      }
      if (is('rename')) {
        event.preventDefault()
        editTitle(hover)
        return
      }
    }

    if (is('jump_back') && !event.repeat && controls.isLocked && mode === 'idle') {
      event.preventDefault()
      flyBack()
      return
    }

    if (is('notes_sidebar') && !event.repeat && (controls.isLocked || overview.isActive) && mode !== 'menu') {
      sidebar.toggle()
      sidebarKey = null
    }

    if (is('orbit') && !event.repeat && controls.isLocked && mode === 'idle' && hover?.kind === 'node') {
      // Flat, facing the camera: its right and up are the orbit's plane.
      const e = camera.matrixWorld.elements
      const plane = { right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]] }
      orbit(hover.id, plane)
    }

    if (is('path') && !event.repeat && controls.isLocked && mode === 'idle') pathKey()

    if (is('connect') && !event.repeat && controls.isLocked && (mode === 'idle' || mode === 'connecting')) {
      connectKey()
    }

    // Hold to open the look ring or the layout-shape ring, move the mouse
    // onto one, let go.
    for (const action of ['look', 'tree_shape']) {
      if (is(action) && !event.repeat && (controls.isLocked || overview.isActive) && mode === 'idle') {
        event.preventDefault()
        openKeyMenu(action)
        return
      }
    }

    if (is('heat') && !event.repeat && (controls.isLocked || overview.isActive) && mode !== 'menu') {
      view.setHeat(!view.heatOn)
      status.info(`connection heat ${view.heatOn ? 'on' : 'off'}`)
    }

    if (event.key === 'Escape') {
      if (mode === 'connecting') cancelConnect()
      else if (mode === 'moving') cancelMove()
    }
    // Balance is a toggle: pressing it again abandons the run wherever it got
    // to, which is the only way to stop a layout that is going somewhere you
    // don't want. It works in the overview too, which is the natural place to
    // watch a layout settle from.
    if (is('balance') && !event.repeat && (controls.isLocked || overview.isActive) && mode !== 'menu') {
      balance()
    }
  }

  function onContextMenu(event) {
    event.preventDefault()
  }

  // Esc drops pointer lock whatever the mode was; land back in a clean state.
  function onUnlock() {
    if (menu.isOpen) menu.close()
    if (editor.isOpen) editor.cancel()
    if (titleEdit.isActive) titleEdit.cancel() // Esc discards a rename
    // Esc under lock closes the search (the browser drops the lock with it);
    // a flight stops where it has got to.
    if (search.isActive) search.cancel()
    if (flyTo.isActive) flyTo.cancel()
    if (mode === 'searching' || mode === 'flying') view.setEmphasis(null)
    menuTarget = null
    heldKey = null
    if (mode === 'connecting') cancelConnect()
    else if (mode === 'moving') cancelMove() // never commit on lock loss
    endModal()
    clearHover()
  }

  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('contextmenu', onContextMenu)
  controls.addEventListener('unlock', onUnlock)

  function dispose() {
    window.removeEventListener('mousedown', onMouseDown)
    window.removeEventListener('mouseup', onMouseUp)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('contextmenu', onContextMenu)
    controls.removeEventListener('unlock', onUnlock)
  }

  return {
    update,
    dispose,
    /** An error from outside the frame loop, sticky on the HUD. */
    reportError: (text) => status.error(`error: ${text}`),
    /** The HUD's messages alone, for when the frame loop has stopped and a
     *  save from the crash notice still has to say how it went. */
    tickStatus: () => status.tick(),
    roomState,
    roomMessage,
    roomEnded,
    closeAbout,
    flyToPose,
    /** What this tab is doing, for presence: 'fly', 'overview', 'menu' or 'editing'. */
    get presenceMode() {
      if (overview.isActive) return 'overview'
      if (mode === 'editing') return 'editing'
      if (mode === 'menu' || !controls.isLocked) return 'menu'
      return 'fly'
    },
    /** The star a label or notes editor is open on, or null. */
    get editingId() {
      return editingAbout?.kind === 'node' ? editingAbout.id : null
    },
    /** The edit commands (the dev-only test seam in main.js reaches them here). */
    commands,
    /** Test seam: the radial menu on a star, as a right-click on it would open it. */
    openMenuFor: (id) => openMenu({ kind: 'node', id }),
    /** Test seam: what the Balance key does, the warning included. */
    balance,
    /** Test seam: what the orbit key does on a star, the warning included. */
    orbitFor: (id) => {
      orbit(id, {})
    },
    /** Test seam: the notes editor on a star, as Ctrl/Cmd+Enter on it opens it. */
    editNotesFor: (id) => {
      const node = graph.getNode(id)
      if (node) editNotes(node)
    },
    /** True while a panel owns the keyboard, or a file is being decrypted and
     *  swapped in — nothing should steal focus back, or re-lock and edit the
     *  graph that's about to be replaced. */
    get isModal() {
      return mode === 'menu' || mode === 'editing' || mode === 'searching' || mode === 'flying' || loading
    },
  }
}

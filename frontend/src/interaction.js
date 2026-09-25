import * as THREE from 'three'
import { NODE_RADIUS } from './graphView.js'
import { createStatus } from './status.js'
import { createHistory } from './history.js'
import { createCommands } from './commands.js'

const SPAWN_DISTANCE = 90 // world units ahead of the camera for a new node
const DOUBLE_CLICK_MS = 320
// Holding a submenu wedge (More…/Back) this long without releasing swaps the
// ring automatically. A quick arm-then-release still swaps instantly via the
// existing key dispatch below — this is only for staying on the wedge.
const SUBMENU_DWELL_MS = 850

// Clockwise from the top. The core toggle takes the bottom wedge: the side
// wedges are too narrow for its label, and Edit and Delete keep the sides they
// had in the three-wedge menu.
const nodeMenu = (node) => [
  { key: 'connect', label: 'Connect' },
  { key: 'edit', label: 'Edit' },
  { key: 'move', label: 'Move' },
  { key: 'core', label: node.is_core ? 'Unmark core' : 'Mark core' },
  { key: 'delete', label: 'Delete' },
]

const EDGE_MENU = [
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
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

// "Motion: on/off" takes the top wedge, which has the most horizontal room;
// "Overview" is short enough to sit comfortably in the tighter side slot.
const MORE_MENU = (reducedMotion) => [
  { key: 'reduced-motion', label: reducedMotion ? 'Motion: off' : 'Motion: on' },
  { key: 'overview', label: 'Overview' },
  { key: 'back', label: 'Back' },
]

// Sentinels for `menuTarget` when the menu isn't over a node or edge. Distinct
// object identities, never compared to `null` (which means "menu closed").
const MAP_TARGET = { kind: 'map', ring: 'top' }
const MAP_TARGET_MORE = { kind: 'map', ring: 'more' }

const nodeName = (node) => node.label || node.id

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
 */
export function createInteraction({ camera, controls, lock, flight, graph, view, physics, files, overview, renderSettings, menu, editor, titleEdit, sidebar, hud, speedEl }) {
  const raycaster = new THREE.Raycaster()
  const crosshair = new THREE.Vector2(0, 0) // dead centre of the viewport
  const forward = new THREE.Vector3()
  const point = new THREE.Vector3()
  const status = createStatus(hud)
  // Every edit goes through here, which is what makes it undoable.
  const commands = createCommands({ graph, view, physics, history: createHistory() })

  let mode = 'idle' // idle | connecting | menu | editing | moving
  let hover = null // { kind, id } under the crosshair
  let sourceId = null // connection origin while mode is 'connecting'
  let moveId = null // node being relocated while mode is 'moving'
  let moveDistance = 0 // camera-to-node distance captured when the move started
  const lastGhostPoint = new THREE.Vector3()
  let menuTarget = null
  let dwellKey = null // submenu wedge ('more' or 'back') currently being held
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
      return node && `node ${nodeName(node)} · ${graph.degree(node.id)} links${node.is_core ? ' · core' : ''}`
    }
    const edge = graph.getEdge(target.id)
    if (!edge) return null
    const ends = `${nodeName(graph.getNode(edge.from))} — ${nodeName(graph.getNode(edge.to))}`
    return edge.label ? `edge ${edge.label} · ${ends}` : `edge ${ends}`
  }

  /** The persistent part of the HUD: where the crosshair is, or what's
   *  happening. `status.js` layers transient save/open/export messages over
   *  whatever this returns, rather than replacing it. */
  function stateLine() {
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
      text = `overview · ${graph.nodes.size} nodes · ${graph.edges.size} edges · Tab to fly`
    } else {
      // Unlocked there is no crosshair to describe, but the fallback still
      // says what's open, behind the overlay.
      const described = controls.isLocked && describe(hover)
      if (described) {
        text = described
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
    status.setState(stateLine())
    status.tick()
  }

  function updateSpeedReadout() {
    const speedText = `${flight.getSpeed().toFixed(2)}x`
    if (speedText === lastSpeedText) return
    lastSpeedText = speedText
    speedEl.textContent = speedText
  }

  function update() {
    updateSpeedReadout()

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

    if (mode === 'menu' && menuTarget?.kind === 'map') {
      // Held on the ring's submenu wedge without releasing: charge, then
      // auto-swap. A quick arm-then-release still swaps instantly through
      // the ordinary key dispatch in closeMenu — this only covers staying.
      const submenuKey = menuTarget.ring === 'top' ? 'more' : 'back'
      if (menu.armed === submenuKey) {
        if (dwellKey !== submenuKey) {
          dwellKey = submenuKey
          dwellSince = performance.now()
          menu.charge(true)
        } else if (performance.now() - dwellSince >= SUBMENU_DWELL_MS) {
          dwellKey = null
          menu.charge(false)
          openMapMenu(menuTarget.ring === 'top' ? 'more' : 'top')
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
    const value = await titleEdit.start(item.label, (text) => view.setLabelDraft(target, text))
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
   * Shift+Enter on a targeted star: full notes editing in the sidebar, with a
   * real cursor. Pointer lock comes back by itself on Save or Esc — the app
   * released it, so re-locking needs no click.
   */
  async function editNotes(node) {
    await lock.release('panel')
    mode = 'editing'
    beginModal()
    try {
      const notes = await sidebar.edit(nodeName(node), node.notes)
      endModal()
      const current = graph.getNode(node.id)
      if (notes !== null && current) commands.setNodeText(current.id, current.label, notes)
    } finally {
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
    if (busy) {
      status.info('a file operation is still in progress')
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
          files.hasCredentials ? 'save as' : 'save map',
          [
            { key: 'filename', label: 'File name', value: name },
            { key: 'password', label: 'Password (optional)', type: 'password' },
            { key: 'confirm', label: 'Confirm password', type: 'password' },
          ],
          note,
          'Save'
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

  /**
   * `Ctrl/Cmd+O`. Pointer lock goes first and stays gone: the file dialog is a
   * native window, so the browser would drop the lock to show it anyway, and
   * releasing it deliberately means the state machine lands somewhere clean
   * instead of being unwound mid-flow. It comes back by itself once the flow
   * settles, however it ends.
   */
  async function openMap() {
    if (busy) {
      status.info('a file operation is still in progress')
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
          'Open'
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
   * and it does not adopt a filename or credentials.
   */
  async function exportMap() {
    if (busy) {
      status.info('a file operation is still in progress')
      return
    }
    busy = true
    try {
      status.busy('exporting')
      const result = await files.exportHtml()
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
      status.info('a file is being opened')
      return
    }
    if (mode === 'connecting') cancelConnect()
    else if (mode === 'moving') cancelMove()
    const label = direction === 'undo' ? commands.undo() : commands.redo()
    // The step may have removed whatever was under the crosshair; the next
    // frame's raycast picks up whatever is there now.
    clearHover()
    status.info(label ? `${direction}: ${label}` : `nothing to ${direction}`)
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
    physics.reset()
    view.sync()
    commands.clear()
    files.clearCredentials()
    files.reset()
    clearHover()
    overview.refit()
  }

  function openMenu(target) {
    if (!describe(target)) return
    menuTarget = target
    mode = 'menu'
    beginModal()
    menu.open(target.kind === 'node' ? nodeMenu(graph.getNode(target.id)) : EDGE_MENU)
  }

  // `ring` re-opens the widget with a different item array rather than
  // teaching it to nest: `menu.close()` has already hidden/cleared the SVG by
  // the time "More…" is dispatched, so this is a clean re-open, not a stack.
  function openMapMenu(ring = 'top') {
    menuTarget = ring === 'top' ? MAP_TARGET : MAP_TARGET_MORE
    mode = 'menu'
    beginModal() // idempotent if already modal from the ring we're leaving — do not guard it
    menu.open(ring === 'top' ? MAP_MENU : MORE_MENU(renderSettings.reducedMotion))
  }

  function closeMenu() {
    const key = menu.close()
    const target = menuTarget
    menuTarget = null
    endModal()
    if (!key || !target) return

    if (target.kind === 'map') {
      if (target.ring === 'top') {
        if (key === 'more') return openMapMenu('more')
        if (key === 'new') newMap()
        else if (key === 'open') openMap()
        else if (key === 'save') saveMap({ reprompt: false })
        else if (key === 'export') exportMap()
        else if (key === 'balance') commands.toggleBalance()
        return
      }
      if (key === 'back') return openMapMenu('top')
      if (key === 'overview') overview.toggle()
      else if (key === 'reduced-motion') renderSettings.toggleReducedMotion()
      return
    }

    if (target.kind === 'node') {
      const node = graph.getNode(target.id)
      if (!node) return
      if (key === 'connect') startConnect(node.id)
      else if (key === 'edit') editTitle(target)
      else if (key === 'move') startMove(node.id)
      else if (key === 'core') commands.toggleCore(node.id)
      else if (key === 'delete') deleteNode(node.id)
      return
    }

    const edge = graph.getEdge(target.id)
    if (!edge) return
    if (key === 'edit') editTitle(target)
    else if (key === 'delete') {
      commands.deleteEdge(edge.id)
      clearHover()
    }
  }

  function onMouseDown(event) {
    // A click mid-rename would pull focus out of the hidden text field.
    if (titleEdit.isActive) event.preventDefault()
    if (!controls.isLocked || mode === 'editing') return

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
    if (isDouble && (mode === 'idle' || !hover)) spawnNode()
    else if (mode === 'connecting') confirmConnect()
  }

  function onMouseUp(event) {
    if (event.button === 2 && mode === 'menu') {
      event.preventDefault()
      closeMenu()
    }
  }

  function onMouseMove(event) {
    if (mode === 'menu') menu.track(event.movementX, event.movementY)
  }

  function onKeyDown(event) {
    // While the editor is up it stops keydown from reaching this window
    // listener at all; this is the guard for the frame either side of that.
    if (mode === 'editing') return

    // Save and open first, and always with preventDefault, so the browser's own
    // save-page and open-file dialogs never see the chord. `code`, not `key`:
    // with a modifier held, `key` reports something else on several layouts.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && mode !== 'menu') {
      if (event.code === 'KeyS') {
        event.preventDefault()
        if (!event.repeat) saveMap({ reprompt: event.shiftKey })
        return
      }
      if (event.code === 'KeyO') {
        event.preventDefault()
        if (!event.repeat) openMap()
        return
      }
      if (event.code === 'KeyE') {
        event.preventDefault()
        if (!event.repeat) exportMap()
        return
      }
      // `key`, unlike the chords above: undo should follow the letter printed
      // on the keyboard (Z sits elsewhere on AZERTY/QWERTZ). Ctrl+Y is the
      // Windows/Linux redo; Cmd+Y is left alone, it opens Chrome's History.
      const letter = event.key.toLowerCase()
      if (letter === 'z' || (letter === 'y' && event.ctrlKey && !event.metaKey)) {
        event.preventDefault()
        if (!event.repeat) stepHistory(letter === 'y' || event.shiftKey ? 'redo' : 'undo')
        return
      }
    }

    // The one mode switch that releases pointer lock, so it is also the one
    // keypress that has to work while unlocked. `preventDefault` because Tab
    // would otherwise walk the browser's focus ring off the canvas.
    if (event.code === 'Tab' && !event.repeat && mode !== 'menu') {
      event.preventDefault()
      overview.toggle()
      return
    }

    // Enter renames what's under the crosshair in place; Shift+Enter opens its
    // notes. Unlocked, Enter belongs to `main.js` (it takes the lock back).
    if (event.key === 'Enter' && !event.repeat && controls.isLocked && mode === 'idle' && hover) {
      event.preventDefault()
      if (!event.shiftKey) editTitle(hover)
      else if (hover.kind === 'node') {
        const node = graph.getNode(hover.id)
        if (node) editNotes(node)
      }
      return
    }

    if (event.code === 'KeyN' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && (controls.isLocked || overview.isActive) && mode !== 'menu') {
      sidebar.toggle()
      sidebarKey = null
    }

    if (event.key === 'Escape') {
      if (mode === 'connecting') cancelConnect()
      else if (mode === 'moving') cancelMove()
    }
    // Balance is a toggle: pressing it again abandons the run wherever it got
    // to, which is the only way to stop a layout that is going somewhere you
    // don't want. It works in the overview too, which is the natural place to
    // watch a layout settle from.
    if (event.code === 'KeyB' && !event.repeat && (controls.isLocked || overview.isActive) && mode !== 'menu') {
      commands.toggleBalance()
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
    menuTarget = null
    if (mode === 'connecting') cancelConnect()
    else if (mode === 'moving') cancelMove() // never commit on lock loss
    endModal()
    clearHover()
  }

  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('contextmenu', onContextMenu)
  controls.addEventListener('unlock', onUnlock)

  function dispose() {
    window.removeEventListener('mousedown', onMouseDown)
    window.removeEventListener('mouseup', onMouseUp)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('contextmenu', onContextMenu)
    controls.removeEventListener('unlock', onUnlock)
  }

  return {
    update,
    dispose,
    /** True while a panel owns the keyboard, or a file is being decrypted and
     *  swapped in — nothing should steal focus back, or re-lock and edit the
     *  graph that's about to be replaced. */
    get isModal() {
      return mode === 'menu' || mode === 'editing' || loading
    },
  }
}

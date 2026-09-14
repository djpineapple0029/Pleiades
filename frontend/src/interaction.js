import * as THREE from 'three'
import { NODE_RADIUS } from './graphView.js'

const SPAWN_DISTANCE = 90 // world units ahead of the camera for a new node
const DOUBLE_CLICK_MS = 320
// How long a save/open result holds the HUD before it goes back to reporting
// what the crosshair is on.
const STATUS_MS = 5000

// Clockwise from the top. The core toggle takes the bottom wedge: the side
// wedges are too narrow for its label, and Edit and Delete keep the sides they
// had in the three-wedge menu.
const nodeMenu = (node) => [
  { key: 'connect', label: 'Connect' },
  { key: 'edit', label: 'Edit' },
  { key: 'core', label: node.is_core ? 'Unmark core' : 'Mark core' },
  { key: 'delete', label: 'Delete' },
]

const EDGE_MENU = [
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
]

const nodeName = (node) => node.label || node.id

function sameTarget(a, b) {
  if (a === b) return true
  return Boolean(a && b) && a.kind === b.kind && a.id === b.id
}

/**
 * Everything the crosshair can do: spawn, target, menu, connect, edit, delete.
 *
 * Pointer lock is never released for any of it — the radial menu reads raw
 * mouse deltas and the editor takes keystrokes into a focused field — so both
 * of those suspend flight input while open and hand it back afterwards. The two
 * exceptions are opening a file and Tab into the overview, both of which are
 * deliberate mode switches rather than per-click actions.
 *
 * Every structural change also pokes `physics`, so a balance run in flight
 * settles the new shape rather than the one it started with.
 *
 * Saving and opening live here too rather than in `files.js`, because both need
 * the password panel, and the panel is a modal surface — only this module knows
 * whether one is already up, and only this module can suspend flight for it.
 */
export function createInteraction({ camera, controls, flight, graph, view, physics, files, overview, menu, editor, hud }) {
  const raycaster = new THREE.Raycaster()
  const crosshair = new THREE.Vector2(0, 0) // dead centre of the viewport
  const forward = new THREE.Vector3()
  const point = new THREE.Vector3()

  let mode = 'idle' // idle | connecting | menu | editing
  let hover = null // { kind, id } under the crosshair
  let sourceId = null // connection origin while mode is 'connecting'
  let menuTarget = null
  let lastLeftDown = 0
  let hudText = null
  let status = null // transient HUD line: the result of a save or an open
  let statusUntil = 0
  let lastSpeed = flight.getSpeed()
  let busy = false // a file flow is somewhere between its first prompt and its result

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

  function setStatus(text) {
    status = text
    statusUntil = performance.now() + STATUS_MS
  }

  function updateHud() {
    let text = ''
    if (status !== null && performance.now() < statusUntil) {
      // A save or open result owns the line for its few seconds. This runs every
      // frame, so it goes back to the graph state on its own once that is up.
      text = status
    } else {
      status = null
      if (mode === 'connecting') {
        const source = graph.getNode(sourceId)
        text = `connecting from ${nodeName(source)} · left-click a node to link · right-click to cancel`
      } else if (mode === 'idle') {
        const counts = `${graph.nodes.size} nodes · ${graph.edges.size} edges`
        // The overview hides the overlay, so the HUD is the only thing left
        // saying how to get out of it.
        if (overview.isActive) text = `overview · ${counts} · Tab to fly`
        // Unlocked there is no crosshair to describe, but the counts still say
        // what was just opened, behind the overlay.
        else text = (controls.isLocked && describe(hover)) || counts
      }
      if (physics.isRunning) {
        const count = graph.clusterCount
        const clusters = count ? ` · ${count} cluster${count === 1 ? '' : 's'}` : ''
        const progress = `balancing ${Math.round(physics.progress * 100)}%${clusters}`
        text = text ? `${text} · ${progress}` : progress
      }
    }
    if (text === hudText) return
    hudText = text
    hud.textContent = text
  }

  function update() {
    const speed = flight.getSpeed()
    if (speed !== lastSpeed) {
      lastSpeed = speed
      setStatus(`flight speed ${speed.toFixed(2)}x`)
    }

    if (mode === 'idle' || mode === 'connecting') {
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

    updateHud()
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
    graph.addNode({ x: point.x, y: point.y, z: point.z })
    view.syncNodes()
    physics.invalidate()
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
    if (graph.addEdge(sourceId, hover.id)) {
      view.syncEdges()
      physics.invalidate()
    }
    cancelConnect()
  }

  function deleteNode(nodeId) {
    if (sourceId === nodeId) cancelConnect()
    graph.removeNode(nodeId)
    clearHover()
    // Not `view.sync()`, which snaps sizes: the deleted node's neighbours
    // should ease down to their new ones like after any other edit.
    view.syncNodes()
    view.syncEdges()
    physics.invalidate()
  }

  /**
   * Sizes are derived from the flag, so the view picks this up by itself on
   * its next frame; physics needs telling, because collision radii and link
   * lengths are only read when a run is seeded.
   */
  function toggleCore(node) {
    graph.setCore(node.id, !node.is_core)
    physics.invalidate()
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

  async function editNode(node) {
    mode = 'editing'
    beginModal()
    const values = await editor.open(`node ${nodeName(node)}`, [
      { key: 'label', label: 'Label', value: node.label },
      { key: 'notes', label: 'Notes', value: node.notes, multiline: true },
    ])
    endModal()
    // The node can be gone if the session was torn down mid-edit.
    if (!values || !graph.getNode(node.id)) return
    node.label = values.label
    node.notes = values.notes
  }

  async function editEdge(edge) {
    mode = 'editing'
    beginModal()
    const values = await editor.open('edge', [{ key: 'label', label: 'Label', value: edge.label }])
    endModal()
    if (!values || !graph.getEdge(edge.id)) return
    edge.label = values.label
  }

  /** Opens the editor panel as a modal and hands back what it collected. */
  async function prompt(title, fields, note) {
    mode = 'editing'
    beginModal()
    const values = await editor.open(title, fields, note)
    endModal()
    return values
  }

  /**
   * `Ctrl/Cmd+S`. The first save asks for a name and a password, and confirms
   * the password: a typo in it produces a file nobody can ever open again.
   * Afterwards the session holds both and this is a single keystroke, until
   * `Shift` asks for them again.
   */
  async function saveMap({ reprompt }) {
    if (busy) return
    busy = true
    let note = null
    // Carried across retries: a mistyped confirmation should not also cost the
    // user the name they typed into a different field.
    let name = files.filename
    try {
      while (!files.hasPassword || reprompt) {
        const values = await prompt(
          files.hasPassword ? 'save as' : 'save map',
          [
            { key: 'filename', label: 'File name', value: name },
            { key: 'password', label: 'Password', type: 'password' },
            { key: 'confirm', label: 'Confirm password', type: 'password' },
          ],
          note
        )
        if (!values) return
        name = values.filename
        if (!values.password) {
          note = 'Enter a password.'
          continue
        }
        if (values.password !== values.confirm) {
          note = 'Passwords do not match.'
          continue
        }
        files.setCredentials(values.password, values.filename)
        break
      }

      setStatus(`saving ${files.filename}`)
      const result = await files.save()
      setStatus(result.ok ? `saved ${files.filename}` : `save failed: ${result.error}`)
    } finally {
      busy = false
    }
  }

  /**
   * `Ctrl/Cmd+O`. Pointer lock goes first and stays gone: the file dialog is a
   * native window, so the browser would drop the lock to show it anyway, and
   * releasing it deliberately means the state machine lands somewhere clean
   * instead of being unwound mid-flow. The user clicks to fly again afterwards.
   */
  async function openMap() {
    if (busy) return
    busy = true
    try {
      if (controls.isLocked) controls.unlock()
      const file = await files.pickFile()
      if (!file) return

      let note = null
      for (;;) {
        const values = await prompt(`open ${file.name}`, [{ key: 'password', label: 'Password', type: 'password' }], note)
        if (!values) return

        setStatus(`opening ${file.name}`)
        const result = await files.open(file, values.password)
        if (result.ok) {
          setStatus(`opened ${file.name} · ${graph.nodes.size} nodes · ${graph.edges.size} edges`)
          // A no-op unless the overview is up, where the orbit would otherwise
          // still be circling the previous map's centre.
          overview.refit()
          return
        }
        // A wrong password is the one failure worth another go at the panel;
        // a corrupt file or a dead server will not read any differently.
        if (!result.wrongPassword) {
          setStatus(`open failed: ${result.error}`)
          return
        }
        note = result.error
      }
    } finally {
      busy = false
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
    if (busy) return
    busy = true
    try {
      setStatus('exporting')
      const result = await files.exportHtml()
      setStatus(result.ok ? `exported ${result.filename}` : `export failed: ${result.error}`)
    } finally {
      busy = false
    }
  }

  function openMenu(target) {
    const title = describe(target)
    if (!title) return
    menuTarget = target
    mode = 'menu'
    beginModal()
    menu.open(title, target.kind === 'node' ? nodeMenu(graph.getNode(target.id)) : EDGE_MENU)
  }

  function closeMenu() {
    const key = menu.close()
    const target = menuTarget
    menuTarget = null
    endModal()
    if (!key || !target) return

    if (target.kind === 'node') {
      const node = graph.getNode(target.id)
      if (!node) return
      if (key === 'connect') startConnect(node.id)
      else if (key === 'edit') editNode(node)
      else if (key === 'core') toggleCore(node)
      else if (key === 'delete') deleteNode(node.id)
      return
    }

    const edge = graph.getEdge(target.id)
    if (!edge) return
    if (key === 'edit') editEdge(edge)
    else if (key === 'delete') {
      graph.removeEdge(edge.id)
      clearHover()
      view.syncEdges()
      physics.invalidate()
    }
  }

  function onMouseDown(event) {
    if (!controls.isLocked || mode === 'editing') return

    if (event.button === 2) {
      event.preventDefault()
      if (mode === 'menu') return
      if (mode === 'connecting') cancelConnect()
      else if (hover) openMenu(hover)
      return
    }

    if (event.button !== 0 || mode === 'menu') return

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
    }

    // The one mode switch that releases pointer lock, so it is also the one
    // keypress that has to work while unlocked. `preventDefault` because Tab
    // would otherwise walk the browser's focus ring off the canvas.
    if (event.code === 'Tab' && !event.repeat && mode !== 'menu') {
      event.preventDefault()
      overview.toggle()
      return
    }

    if (event.key === 'Escape' && mode === 'connecting') cancelConnect()
    // Balance is a toggle: pressing it again abandons the run wherever it got
    // to, which is the only way to stop a layout that is going somewhere you
    // don't want. It works in the overview too, which is the natural place to
    // watch a layout settle from.
    if (event.code === 'KeyB' && !event.repeat && (controls.isLocked || overview.isActive) && mode !== 'menu') {
      physics.toggle()
    }
  }

  function onContextMenu(event) {
    event.preventDefault()
  }

  // Esc drops pointer lock whatever the mode was; land back in a clean state.
  function onUnlock() {
    if (menu.isOpen) menu.close()
    if (editor.isOpen) editor.cancel()
    menuTarget = null
    if (mode === 'connecting') cancelConnect()
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
    /** True while a panel owns the keyboard — nothing should steal focus back. */
    get isModal() {
      return mode === 'menu' || mode === 'editing'
    },
  }
}

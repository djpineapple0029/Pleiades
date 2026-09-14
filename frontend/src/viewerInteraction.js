import * as THREE from 'three'

/**
 * The read-only half of `interaction.js`, for the exported viewer.
 *
 * This is a separate module rather than a flag on `interaction.js` on purpose:
 * an exported map is view-only *by construction*, because the code that could
 * change a graph is not in the bundle at all. There is nothing here to turn
 * back on. Between them, the two modules cover the same surface — crosshair
 * targeting, the HUD, and Tab — and this one simply has no menu, no editor, no
 * spawn, no delete, no Balance and no file flows.
 *
 * Pointer lock behaves exactly as it does in the app: Tab is the one mode
 * switch that releases it, and Esc drops it as browsers reserve it.
 */

// How long the flight-speed readout holds the HUD before it goes back to
// reporting what the crosshair is on.
const STATUS_MS = 5000

const nodeName = (node) => node.label || node.id

function sameTarget(a, b) {
  if (a === b) return true
  return Boolean(a && b) && a.kind === b.kind && a.id === b.id
}

export function createViewerInteraction({ camera, controls, flight, graph, view, overview, hud }) {
  const raycaster = new THREE.Raycaster()
  const crosshair = new THREE.Vector2(0, 0) // dead centre of the viewport

  let hover = null // { kind, id } under the crosshair
  let hudText = null
  let status = null
  let statusUntil = 0
  let lastSpeed = flight.getSpeed()

  function clearHover() {
    hover = null
    view.setHover(null)
  }

  /** The same readout the app gives, minus anything about editing it. */
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
      text = status
    } else {
      status = null
      const counts = `${graph.nodes.size} nodes · ${graph.edges.size} edges`
      // The overview hides the overlay, so the HUD is the only thing left
      // saying how to get out of it.
      if (overview.isActive) text = `overview · ${counts} · Tab to fly`
      else text = (controls.isLocked && describe(hover)) || counts
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

    updateHud()
  }

  function onKeyDown(event) {
    // `preventDefault` because Tab would otherwise walk the browser's focus
    // ring off the canvas. This has to work while unlocked, since it is also
    // the way back out of the overview.
    if (event.code === 'Tab' && !event.repeat) {
      event.preventDefault()
      overview.toggle()
    }
  }

  // No radial menu here, but a right-click while locked should still not raise
  // the browser's own menu over the map.
  function onContextMenu(event) {
    event.preventDefault()
  }

  function onUnlock() {
    clearHover()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('contextmenu', onContextMenu)
  controls.addEventListener('unlock', onUnlock)

  function dispose() {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('contextmenu', onContextMenu)
    controls.removeEventListener('unlock', onUnlock)
  }

  return { update, dispose }
}

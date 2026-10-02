import * as THREE from 'three'
import { createStatus } from './status.js'
import { createKeymap } from './keymap.js'
import { focusSetOf } from './heat.js'
import { nodeName } from './ids.js'

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
 * Click-to-focus and the heat key are here too: both only change what is lit,
 * never the graph.
 *
 * Pointer lock behaves exactly as it does in the app: Tab is the one mode
 * switch that releases it, and Esc drops it as browsers reserve it.
 *
 * Shares `status.js` with `interaction.js` (imported directly, not through
 * it — this module must never import anything that can mutate a graph) so
 * the HUD's message-vs-state split can never drift between the two. There
 * are no file flows here, so the only message this side ever posts is the
 * heat key's `info`.
 */

function sameTarget(a, b) {
  if (a === b) return true
  return Boolean(a && b) && a.kind === b.kind && a.id === b.id
}

export function createViewerInteraction({
  camera,
  controls,
  flight,
  graph,
  view,
  overview,
  hud,
  speedEl,
  keymap = createKeymap(),
}) {
  const raycaster = new THREE.Raycaster()
  const crosshair = new THREE.Vector2(0, 0) // dead centre of the viewport
  const status = createStatus(hud)

  let hover = null // { kind, id } under the crosshair
  let lastSpeedText = null
  let focusTarget = null // `{ kind, id }` whose connections alone stay lit, or null

  /** Focuses a star or link, or clears the focus with null. The graph never changes here. */
  function setFocus(target) {
    const lit = target && focusSetOf(graph, target)
    focusTarget = lit ? target : null
    view.setFocus(lit || null)
  }

  function clearHover() {
    hover = null
    view.setHover(null)
  }

  /** The same readout the app gives, minus anything about editing it. */
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

  /** What the HUD shows — the same as the app's: how to leave the overview
   *  or a focus, and nothing otherwise. */
  function hudLine() {
    if (overview.isActive) {
      const back = keymap.label('overview')
      return back ? `${back} to fly` : ''
    }
    return focusTarget && describe(focusTarget) ? 'focused · click empty space to clear' : ''
  }

  /** The full readout behind the HUD (`data-trace`, see `status.js`). */
  function traceLine() {
    const counts = `${graph.nodes.size} nodes · ${graph.edges.size} edges`
    // The overview hides the overlay, so the HUD is the only thing left
    // saying how to get out of it.
    if (overview.isActive) {
      const back = keymap.label('overview')
      return `overview · ${counts}${back ? ` · ${back} to fly` : ''}`
    }
    if (controls.isLocked && describe(hover)) return describe(hover)
    const focused = focusTarget && describe(focusTarget)
    if (focused) return `focus ${focused} · click empty space to clear`
    return counts
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

  function update() {
    updateSpeedReadout()

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
    if (keymap.is(event, 'overview') && !event.repeat) {
      event.preventDefault()
      overview.toggle()
      return
    }
    if (keymap.is(event, 'heat') && !event.repeat && (controls.isLocked || overview.isActive)) {
      view.setHeat(!view.heatOn)
      status.info(`connection heat ${view.heatOn ? 'on' : 'off'}`)
    }
  }

  // A click on a star or link focuses it; on it again, or on empty space, clears.
  function onMouseDown(event) {
    if (!controls.isLocked || event.button !== 0) return
    setFocus(!hover || sameTarget(hover, focusTarget) ? null : hover)
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
  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('contextmenu', onContextMenu)
  controls.addEventListener('unlock', onUnlock)

  function dispose() {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('mousedown', onMouseDown)
    window.removeEventListener('contextmenu', onContextMenu)
    controls.removeEventListener('unlock', onUnlock)
  }

  return {
    update,
    dispose,
    /** An error from outside the frame loop, sticky on the HUD. */
    reportError: (text) => status.error(`error: ${text}`),
  }
}

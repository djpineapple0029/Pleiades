const SVG_NS = 'http://www.w3.org/2000/svg'

const CENTER = 130 // half the viewBox — the wheel is square and centred
const INNER_RADIUS = 44
const OUTER_RADIUS = 112
const LABEL_RADIUS = (INNER_RADIUS + OUTER_RADIUS) / 2

// Accumulated pointer travel, in screen pixels, before a wedge arms. Below it
// the gesture is a plain right-click, which cancels.
const DEADZONE = 32
const TRAVEL_CLAMP = 96 // how far the indicator can drift from the centre
const DELTA_CLAMP = 120 // per-event guard: pointer lock occasionally spikes

/** Screen-space polar to SVG cartesian: angle 0 points up, grows clockwise. */
function polar(angle, radius) {
  return [CENTER + Math.sin(angle) * radius, CENTER - Math.cos(angle) * radius]
}

function wedgePath(from, to) {
  const largeArc = to - from > Math.PI ? 1 : 0
  const [ox1, oy1] = polar(from, OUTER_RADIUS)
  const [ox2, oy2] = polar(to, OUTER_RADIUS)
  const [ix1, iy1] = polar(from, INNER_RADIUS)
  const [ix2, iy2] = polar(to, INNER_RADIUS)
  return [
    `M ${ix1} ${iy1}`,
    `L ${ox1} ${oy1}`,
    `A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 ${largeArc} 1 ${ox2} ${oy2}`,
    `L ${ix2} ${iy2}`,
    `A ${INNER_RADIUS} ${INNER_RADIUS} 0 ${largeArc} 0 ${ix1} ${iy1}`,
    'Z',
  ].join(' ')
}

/**
 * Weapon-wheel menu for a pointer-locked view: there is no cursor, so the
 * choice comes from accumulated mouse delta rather than a hit test. Open on
 * right-mousedown, `track` every mousemove, `close` on right-mouseup.
 */
export function createRadialMenu(container) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${CENTER * 2} ${CENTER * 2}`)
  container.append(svg)

  let items = []
  let wedges = []
  let selected = -1
  let travelX = 0
  let travelY = 0
  let indicator = null
  let spoke = null

  function clear() {
    svg.replaceChildren()
    wedges = []
    indicator = null
    spoke = null
  }

  function highlight(index) {
    if (index === selected) return
    wedges[selected]?.group.classList.remove('armed')
    wedges[index]?.group.classList.add('armed')
    selected = index
  }

  /** `menuItems` are `{ key, label }`, laid out clockwise from the top. */
  function open(menuItems) {
    clear()
    items = menuItems
    selected = -1
    travelX = 0
    travelY = 0

    // Backs the donut hole with an opaque disc: the node/edge behind the menu
    // (often a bright, bloom-lit sphere) would otherwise show through and wash
    // out whichever wedge is armed, plus anything drawn at the centre.
    const hub = document.createElementNS(SVG_NS, 'circle')
    hub.setAttribute('class', 'hub')
    hub.setAttribute('r', INNER_RADIUS)
    hub.setAttribute('cx', CENTER)
    hub.setAttribute('cy', CENTER)
    svg.append(hub)

    const step = (Math.PI * 2) / items.length
    items.forEach((item, index) => {
      const group = document.createElementNS(SVG_NS, 'g')
      group.setAttribute('class', 'wedge')

      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', wedgePath(index * step - step / 2, index * step + step / 2))
      group.append(path)

      const [lx, ly] = polar(index * step, LABEL_RADIUS)
      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('x', lx)
      text.setAttribute('y', ly)
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('dominant-baseline', 'middle')
      text.textContent = item.label
      group.append(text)

      svg.append(group)
      wedges.push({ group })
    })

    // Spoke from the fixed hub centre out to the drag indicator, so the
    // indicator's position on the wheel reads as a direction, not a stray dot.
    spoke = document.createElementNS(SVG_NS, 'line')
    spoke.setAttribute('class', 'spoke')
    spoke.setAttribute('x1', CENTER)
    spoke.setAttribute('y1', CENTER)
    spoke.setAttribute('x2', CENTER)
    spoke.setAttribute('y2', CENTER)
    svg.append(spoke)

    const pivot = document.createElementNS(SVG_NS, 'circle')
    pivot.setAttribute('class', 'pivot')
    pivot.setAttribute('r', 3)
    pivot.setAttribute('cx', CENTER)
    pivot.setAttribute('cy', CENTER)
    svg.append(pivot)

    indicator = document.createElementNS(SVG_NS, 'circle')
    indicator.setAttribute('class', 'indicator')
    indicator.setAttribute('r', 4)
    indicator.setAttribute('cx', CENTER)
    indicator.setAttribute('cy', CENTER)
    svg.append(indicator)

    container.hidden = false
  }

  function track(dx, dy) {
    if (container.hidden) return
    travelX += Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, dx))
    travelY += Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, dy))

    const distance = Math.hypot(travelX, travelY)
    const drawn = Math.min(distance, TRAVEL_CLAMP)
    const scale = distance > 0 ? drawn / distance : 0
    const ix = CENTER + travelX * scale
    const iy = CENTER + travelY * scale
    indicator.setAttribute('cx', ix)
    indicator.setAttribute('cy', iy)
    spoke.setAttribute('x2', ix)
    spoke.setAttribute('y2', iy)

    if (distance < DEADZONE) {
      highlight(-1)
      return
    }
    // Screen y grows downward, so negate it to match the angle convention.
    const angle = Math.atan2(travelX, -travelY)
    const step = (Math.PI * 2) / items.length
    highlight(Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / step) % items.length)
  }

  /** Hides the wheel and returns the armed item's key, or null if none was. */
  function close() {
    if (container.hidden) return null
    const key = items[selected]?.key ?? null
    container.hidden = true
    clear()
    items = []
    selected = -1
    return key
  }

  return {
    open,
    track,
    close,
    get isOpen() {
      return !container.hidden
    },
  }
}

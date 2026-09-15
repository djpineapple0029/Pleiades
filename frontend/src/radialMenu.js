const SVG_NS = 'http://www.w3.org/2000/svg'

const CENTER = 130 // half the viewBox — the wheel is square and centred, fixed regardless of item count

// Drawing geometry scales with item count via these two profiles; a menu of
// 2-4 items (today's node/edge menus) renders pixel-identical to before.
// 5-6 items (the map menu, and the node menu once Move is added) get a
// slightly smaller hub and larger ring, buying more arc length per wedge.
const RADIUS_PROFILES = {
  default: { inner: 44, outer: 112 },
  wide: { inner: 40, outer: 118 },
}
const profileFor = (count) => (count <= 4 ? RADIUS_PROFILES.default : RADIUS_PROFILES.wide)

// Accumulated pointer travel, in screen pixels, before a wedge arms. Below it
// the gesture is a plain right-click, which cancels. Gesture feel, not
// drawing geometry — independent of item count.
const DEADZONE = 32
const TRAVEL_CLAMP = 96 // how far the indicator can drift from the centre
const DELTA_CLAMP = 120 // per-event guard: pointer lock occasionally spikes

// Label sizing: matches the current CSS default exactly, so 4-item wedges are
// unchanged; shrinks toward the floor before falling back to two lines.
const BASE_FONT_PX = 12
const MIN_FONT_PX = 9
const LABEL_PADDING = 0.85 // fraction of the raw chord width used as the fit target

/** Screen-space polar to SVG cartesian: angle 0 points up, grows clockwise. */
function polar(angle, radius) {
  return [CENTER + Math.sin(angle) * radius, CENTER - Math.cos(angle) * radius]
}

function wedgePath(from, to, inner, outer) {
  const largeArc = to - from > Math.PI ? 1 : 0
  const [ox1, oy1] = polar(from, outer)
  const [ox2, oy2] = polar(to, outer)
  const [ix1, iy1] = polar(from, inner)
  const [ix2, iy2] = polar(to, inner)
  return [
    `M ${ix1} ${iy1}`,
    `L ${ox1} ${oy1}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${ox2} ${oy2}`,
    `L ${ix2} ${iy2}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${ix1} ${iy1}`,
    'Z',
  ].join(' ')
}

/**
 * How much horizontal room a label has at `angle`/`radius` inside a wedge of
 * the given angular span and inner/outer radii. Two independent constraints
 * bound it, and the tighter one wins:
 * - the wedge's own two straight edges (the old chord estimate) — tight for
 *   an angularly narrow wedge, regardless of where it sits on the ring;
 * - the ring's curved inner/outer edges — tight near the left/right of the
 *   ring, where horizontal text runs along the ring's radial *thickness*
 *   rather than its circumference, however wide the wedge's angle is. The
 *   original code only checked the first, so a wide-but-side-sitting wedge
 *   (e.g. a 3-item ring's middle item) let text run at full size straight
 *   past the ring's own edge.
 */
function availableWidth(angle, radius, angleSpan, inner, outer) {
  const chordWidth = 2 * radius * Math.sin(angleSpan / 2)
  // Vertical distance from the ring's centre to the label's row: the two arcs
  // are symmetric across it, so this alone determines how far each reaches.
  const dy = Math.abs(Math.cos(angle)) * radius
  const reach = (r) => Math.sqrt(Math.max(r * r - dy * dy, 0))
  const outerReach = reach(outer) - reach(radius)
  const innerReach = dy <= inner ? reach(radius) - reach(inner) : Infinity
  const arcWidth = 2 * Math.min(outerReach, innerReach)
  return Math.min(chordWidth, arcWidth)
}

/**
 * Fits `label` into `available` px, shrinking font-size first and falling
 * back to two lines (split on the label's own space) only if it still
 * doesn't fit at the floor size. Requires `text` to already be attached to
 * the SVG document, since `getComputedTextLength()` needs real layout.
 */
function layoutLabel(text, label, available) {
  text.textContent = ''
  available *= LABEL_PADDING

  const line = document.createElementNS(SVG_NS, 'tspan')
  line.textContent = label
  text.append(line)

  let fontPx = BASE_FONT_PX
  line.style.fontSize = `${fontPx}px`
  while (line.getComputedTextLength() > available && fontPx > MIN_FONT_PX) {
    fontPx -= 1
    line.style.fontSize = `${fontPx}px`
  }

  const words = label.split(' ')
  if (fontPx === MIN_FONT_PX && line.getComputedTextLength() > available && words.length > 1) {
    text.textContent = ''
    const mid = Math.ceil(words.length / 2)
    const lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
    lines.forEach((content, i) => {
      const tspan = document.createElementNS(SVG_NS, 'tspan')
      tspan.textContent = content
      tspan.setAttribute('x', text.getAttribute('x'))
      tspan.setAttribute('dy', i === 0 ? '-0.55em' : '1.1em')
      tspan.style.fontSize = `${BASE_FONT_PX}px`
      text.append(tspan)
    })
  }
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

  /**
   * Visual cue for a dwell-triggered transition (e.g. a submenu wedge held
   * without releasing): `true` starts the pulse on the armed wedge, `false`
   * clears it from every wedge — not just the current one, since the armed
   * wedge may have already changed by the time the caller cancels a dwell
   * that was building on a different one.
   */
  function charge(active) {
    if (active) wedges[selected]?.group.classList.add('charging')
    else wedges.forEach((w) => w.group.classList.remove('charging'))
  }

  /** `menuItems` are `{ key, label }`, laid out clockwise from the top. */
  function open(menuItems) {
    clear()
    items = menuItems
    selected = -1
    travelX = 0
    travelY = 0
    const { inner, outer } = profileFor(items.length)
    const labelRadius = (inner + outer) / 2

    // Backs the donut hole with an opaque disc: the node/edge behind the menu
    // (often a bright, bloom-lit sphere) would otherwise show through and wash
    // out whichever wedge is armed, plus anything drawn at the centre.
    const hub = document.createElementNS(SVG_NS, 'circle')
    hub.setAttribute('class', 'hub')
    hub.setAttribute('r', inner)
    hub.setAttribute('cx', CENTER)
    hub.setAttribute('cy', CENTER)
    svg.append(hub)

    const step = (Math.PI * 2) / items.length
    items.forEach((item, index) => {
      const group = document.createElementNS(SVG_NS, 'g')
      group.setAttribute('class', 'wedge')

      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', wedgePath(index * step - step / 2, index * step + step / 2, inner, outer))
      group.append(path)

      const angle = index * step
      const [lx, ly] = polar(angle, labelRadius)
      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('x', lx)
      text.setAttribute('y', ly)
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('dominant-baseline', 'middle')
      group.append(text)
      svg.append(group) // attached before measuring: getComputedTextLength() needs real layout
      layoutLabel(text, item.label, availableWidth(angle, labelRadius, step, inner, outer))

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
    charge,
    /** The currently armed item's key, or null if none is armed. */
    get armed() {
      return items[selected]?.key ?? null
    },
    get isOpen() {
      return !container.hidden
    },
  }
}

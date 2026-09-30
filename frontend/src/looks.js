/**
 * Looks: whole-scene presets, picked from a radial menu (hold V) or the More
 * menu. Each one decides which layers are drawn at all, how the stars are
 * drawn, whether anything moves, and the colours.
 *
 * - Deep Space: everything. Pulsing stars, dust rivers, drift along links,
 *   supernovas, the nebula and bloom. What "Motion: on" used to be.
 * - Shallow Space: the same stars and sky, standing still. No rivers, drift,
 *   supernovas or floating dust. What "Motion: off" used to be, and quieter.
 * - Deep Sea: the same pipeline dressed as the deep ocean. A water column lit
 *   from above instead of a sky, jellies instead of stars, sinking marine
 *   snow instead of dust, and teal and violet colours.
 * - Minimal: built for speed. Plain lit orbs on a flat ground, no glow, no
 *   bloom passes, no sky, no dust, nothing animated.
 *
 * The choice is remembered in this browser; the config's `visuals.look` is
 * where a browser with no choice yet starts.
 */

const SPACE = {
  clear: 0x05060a,
  tints: [
    [0.5, 0.68, 1.0],
    [0.92, 0.94, 1.0],
    [1.0, 0.7, 0.42],
  ],
  edges: { edge: 0x557aa3, mote: 0xa9c8ea, heat: [0x8a6ad6, 0xd455b4, 0xff5a4f] },
  rivers: [
    [1.0, 0.72, 0.45],
    [0.5, 0.6, 0.78],
  ],
  murk: 0,
}

const SEA = {
  clear: 0x000306,
  // Bioluminescence: cyan, pale aqua and violet in place of blue, white, warm.
  tints: [
    [0.25, 0.95, 0.88],
    [0.78, 1.0, 0.96],
    [0.74, 0.52, 1.0],
  ],
  // Kelp-green links heating through cyan and violet to a coral pink; amber
  // stays the hover colour.
  edges: { edge: 0x2b8a80, mote: 0x9ff5e6, heat: [0x2fb4d8, 0x8b7cff, 0xff5fa8] },
  rivers: [
    [0.6, 1.0, 0.8],
    [0.25, 0.55, 0.85],
  ],
  // Light lost per world unit: a jelly 700 units off is at about a third.
  murk: 1 / 700,
}

const MINIMAL = {
  clear: 0x0d1016,
  tints: [
    [0.55, 0.68, 0.92],
    [0.86, 0.89, 0.95],
    [0.95, 0.72, 0.5],
  ],
  edges: { edge: 0x5a6a80, mote: 0xa9c8ea, heat: [0x8a6ad6, 0xd455b4, 0xff5a4f] },
  rivers: SPACE.rivers,
  murk: 0,
}

export const LOOKS = [
  {
    id: 'deep-space',
    name: 'Deep Space',
    motion: true,
    sky: 'space',
    dust: 'space',
    rivers: true,
    supernova: true,
    drift: true,
    bloom: 1,
    stars: 'rays',
    palette: SPACE,
  },
  {
    id: 'deep-sea',
    name: 'Deep Sea',
    motion: true,
    sky: 'sea',
    dust: 'sea',
    rivers: true,
    supernova: true,
    drift: true,
    bloom: 1.6,
    stars: 'jelly',
    palette: SEA,
  },
  {
    id: 'minimal',
    name: 'Minimal',
    motion: false,
    sky: null,
    dust: null,
    rivers: false,
    supernova: false,
    drift: false,
    bloom: 0,
    stars: 'orbs',
    palette: MINIMAL,
  },
  {
    id: 'shallow-space',
    name: 'Shallow Space',
    motion: false,
    sky: 'space',
    dust: null,
    rivers: false,
    supernova: false,
    drift: false,
    bloom: 1,
    stars: 'rays',
    palette: SPACE,
  },
]

export const DEFAULT_LOOK = 'deep-space'
const BY_ID = new Map(LOOKS.map((look) => [look.id, look]))
const STORAGE_KEY = 'atlasmap.look'
// Milliseconds of the dip to black either side of a switch (style.css
// #look-fade matches it). Long enough to cover
// a first bake of the sea (~0.1 s) and a shader recompile, short enough not
// to feel like a loading screen.
const FADE_MS = 160

export function lookById(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_LOOK)
}

/** This browser's remembered look id, or null (none yet, or storage is off). */
export function storedLook() {
  try {
    const id = localStorage.getItem(STORAGE_KEY)
    return BY_ID.has(id) ? id : null
  } catch {
    return null
  }
}

function storeLook(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Private window or storage blocked: the look just isn't remembered.
  }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/**
 * Applies looks to the scene's parts. `bloomStrength` is the config's
 * strength, which a look scales. `fade` is an element that CSS fades to
 * black while it has the `on` class; without one, switches are instant.
 * `onChange(look)` runs right after a look lands, still under the fade.
 */
export function createLooks({
  renderer,
  skybox,
  dust,
  bloom,
  view,
  rivers,
  supernova = null,
  fade = null,
  bloomStrength = 0.3,
  onChange = () => {},
}) {
  let current = null
  let switching = null // the running switch's promise
  let queued = null // the id to switch to once it's done

  function applyNow(look) {
    const { palette } = look
    renderer.setClearColor(palette.clear)
    skybox.setVariant(look.sky)
    dust.setStyle(look.dust)
    bloom.setEnabled(look.bloom > 0)
    bloom.setStrength(Math.min(1, bloomStrength * look.bloom))
    view.setStyle({
      stars: look.stars,
      tints: palette.tints,
      murk: palette.murk,
      voidColor: palette.clear,
      edges: palette.edges,
      drift: look.drift,
    })
    rivers.setColors(...palette.rivers)
    if (!look.rivers) rivers.hide()
    if (!look.supernova) supernova?.clear()
    document.documentElement.dataset.look = look.id
    current = look
    onChange(look)
  }

  async function switchTo(id) {
    fade.classList.add('on')
    await new Promise((resolve) => setTimeout(resolve, FADE_MS))
    applyNow(lookById(id))
    // Two frames drawn under the fade: the first compiles whatever the new
    // look needs, so the reveal doesn't stutter.
    await nextFrame()
    await nextFrame()
    fade.classList.remove('on')
  }

  /**
   * Switches to look `id`, remembering it. Under the fade unless `instant`
   * or there is no fade element. Resolves once the new look is showing.
   */
  async function set(id, { instant = false, remember = true } = {}) {
    const look = lookById(id)
    if (remember) storeLook(look.id)
    if (instant || !fade) {
      applyNow(look)
      return
    }
    if (switching) {
      queued = look.id
      return switching
    }
    if (look === current) return
    switching = (async () => {
      let next = look.id
      while (next) {
        queued = null
        if (next !== current?.id) await switchTo(next)
        next = queued
      }
      switching = null
    })()
    return switching
  }

  return {
    set,
    get current() {
      return current
    },
    get isSwitching() {
      return switching !== null
    },
  }
}

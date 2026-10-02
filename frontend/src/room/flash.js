/**
 * Other people's edits glow in their colour for a moment (context/MOONSHOT.md
 * decision 11). Pure: graphView.js asks `mix` for each star as it writes the
 * drawn tints. Times are the view's clock, in seconds.
 */
const STRENGTH = 0.8

export function createFlashes() {
  const flashes = new Map() // id -> { rgb, start, seconds }

  /** Starts (or restarts) a flash on each star. */
  function add(ids, rgb, now, seconds = 1.5) {
    for (const id of ids) flashes.set(id, { rgb, start: now, seconds })
  }

  /**
   * Leans `tint` (in place) toward the star's flash colour, strongest at the
   * start and gone by its end. False when the star has no flash running.
   */
  function mix(id, tint, now) {
    const flash = flashes.get(id)
    if (!flash) return false
    const left = 1 - (now - flash.start) / flash.seconds
    if (left <= 0) return false
    const k = STRENGTH * Math.min(1, left)
    for (let i = 0; i < 3; i++) tint[i] += (flash.rgb[i] - tint[i]) * k
    return true
  }

  /** Forgets flashes that have finished by `now`. */
  function prune(now) {
    for (const [id, flash] of flashes) if (now - flash.start >= flash.seconds) flashes.delete(id)
  }

  return {
    add,
    mix,
    prune,
    get active() {
      return flashes.size > 0
    },
  }
}

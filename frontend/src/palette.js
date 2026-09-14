/**
 * The cluster palette — pure colour, no graph theory and no dependencies.
 *
 * Split out of `clustering.js` so that reading a cluster's colour does not drag
 * Louvain in with it. `graphView.js` and `labels.js` want nothing but the hue
 * for a colour id, while `clustering.js` imports `graphology` and
 * `graphology-communities-louvain` (~97 KB of the bundle) to *compute* which id
 * a node gets. The exported viewer (see `viewer.js`) never re-partitions, so
 * that split is what keeps the whole clustering stack out of an exported file.
 *
 * Colour id 0 means "no cluster" and is not a palette entry; see `clustering.js`.
 */

// Hues, in degrees, in the order colours are handed out. Ordered for maximum
// separation between the *first* few, since most maps have only a handful of
// clusters — walking the wheel in order would give cluster 1 and cluster 2
// neighbouring hues.
//
// Sky blue (210) is deliberately **not** first, though it is the prettiest of
// these on a star. An unclustered star is tinted along blue -> white -> warm,
// so a blue cluster is the one hue that reads as "no cluster" rather than as a
// group, and up close, where the core saturates toward white anyway, it stops
// reading as a colour at all. Cyan at 180 survives the same treatment; 210 does
// not. It is kept, but late, where a map is already colourful enough to place it.
const HUES = [140, 300, 32, 180, 262, 342, 100, 210, 58, 322, 158, 18]
// Pastel on purpose. A cluster colour multiplies a star's whole glow and its
// rays, so a dark or fully saturated hue makes a dim star; and the same values
// are the label ink, which has to stay readable over the halo.
const SATURATION = 0.7
const LIGHTNESS = 0.76

/** CSS's hsl-to-rgb, `h` in turns. All three outputs are sRGB on 0..1. */
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l)
  const f = (n) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

/**
 * The cluster palette, as sRGB `[r, g, b]` on 0..1. Consumers convert: the
 * label ink is written in sRGB as-is, and `graphView` reads them into a
 * `THREE.Color` as sRGB so three converts them to linear for the shader.
 */
export const CLUSTER_INKS = HUES.map((hue) => hslToRgb(hue / 360, SATURATION, LIGHTNESS))

/**
 * The colour for a colour id, or null for 0 (no cluster). More clusters than
 * the palette has entries wrap around and share a hue — with twelve, a map
 * would have to be very fragmented to get there, and the alternative is hues
 * too close together to tell apart anyway.
 */
export function clusterInk(colorId) {
  if (!colorId) return null
  return CLUSTER_INKS[(colorId - 1) % CLUSTER_INKS.length]
}

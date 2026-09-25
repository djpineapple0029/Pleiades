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

// Hues, in degrees, indexed by colour id - 1. **Never reorder or remove an
// entry**: every saved file stores the index, so a reorder recolours every map
// already written. New hues only ever go on the end.
//
// The first twelve were once handed out in this order, front-loaded for
// separation. Since clustering now draws a *random* unused id (see
// `clustering.js`, `pickColor`), order no longer decides which colour a map
// gets first; it only has to stay put.
//
// The second eight fill the widest gaps the first twelve left on the wheel.
// Twenty is about as many as stay apart at this saturation and lightness;
// closer than ~15 degrees, two pastels read as one.
//
// Sky blue (210) is kept **late**: an unclustered star is tinted along blue ->
// white -> warm, so a blue cluster is the one hue that reads as "no cluster"
// rather than as a group, and up close, where the core saturates toward white
// anyway, it stops reading as a colour at all. Cyan at 180 survives the same
// treatment; 210 does not, nor do its neighbours 195 and 228. `LATE_IDS` holds
// them, and the picker reaches for them only once everything else is taken.
const HUES = [
  140, 300, 32, 180, 262, 342, 100, 210, 58, 322, 158, 18,
  79, 245, 0, 120, 281, 45, 195, 228,
]
const LATE_HUES = new Set([210, 195, 228])
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

/** How many colour ids the palette has before it wraps. */
export const PALETTE_SIZE = HUES.length

/** Colour ids (1-based) the picker holds back until every other one is taken. */
export const LATE_IDS = new Set(
  HUES.map((hue, index) => (LATE_HUES.has(hue) ? index + 1 : 0)).filter(Boolean)
)

/** A colour id's hue in degrees, wrapping like `clusterInk`. */
export function hueOf(colorId) {
  return HUES[(colorId - 1) % HUES.length]
}

export function clusterInk(colorId) {
  if (!colorId) return null
  return CLUSTER_INKS[(colorId - 1) % CLUSTER_INKS.length]
}

// --- Mixing ----------------------------------------------------------------------
// `colorBlend.js` fades cluster colours into each other. Averaging in sRGB turns
// a pink/green midpoint into mud, so mixing happens in OKLab, where a straight
// line between two colours looks like an even fade, and `mixToSrgb` then puts
// back the chroma a straight average loses.

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/** sRGB `[r, g, b]` on 0..1 to OKLab `[L, a, b]`. */
export function srgbToOklab([r, g, b]) {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** OKLab `[L, a, b]` to sRGB `[r, g, b]`, clamped to 0..1. */
export function oklabToSrgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (v) => Math.min(1, Math.max(0, toGamma(Math.max(0, v))))
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

// How much of the chroma a straight average lost is given back: the mix's
// share of its intended chroma is raised to this power. Averaging two nearly
// opposite hues (green and pink, say) cancels most of the chroma, and a hard
// "lift it back to full" would snap a mostly-green mix straight back to pure
// green, hiding the fade; a power below 1 lifts a slightly muted mix almost to
// full and a heavily cancelled one only part way, smoothly, so the midpoint of
// two opposite hues fades toward a pastel white — which reads as a star's own
// colour — and never jumps.
const CHROMA_RESTORE = 0.5

/**
 * An ink as the four numbers `colorBlend.js` mixes: OKLab `[L, a, b]` plus the
 * chroma it should end up with. Averaging the fourth alongside the others is
 * what lets `mixToSrgb` restore a mix's chroma without flattening every hue to
 * one lightness — a pure ink comes back exactly as it went in.
 */
export function inkToMix(rgb) {
  const [L, a, b] = srgbToOklab(rgb)
  return [L, a, b, Math.hypot(a, b)]
}

/** A mixed `[L, a, b, chroma]` back to sRGB, its chroma lifted back to the intended one. */
export function mixToSrgb([L, a, b, target]) {
  const chroma = Math.hypot(a, b)
  if (chroma < 1e-9) return oklabToSrgb([L, 0, 0])
  const wanted = target * Math.min(1, chroma / target) ** CHROMA_RESTORE
  return oklabToSrgb([L, (a / chroma) * wanted, (b / chroma) * wanted])
}

/**
 * Node sizing rule — plain data, no Three.js. Sizes are unitless multipliers
 * of the base node radius, so the model never needs to know how big a radius
 * is on screen.
 *
 * Only a core is bigger: CORE_SIZE, and every other node 1x. This replaced the
 * original rule (`atlasmap-build-plan.md`, "Node Sizing Rule"), where size also
 * grew with a node's degree and with nearness to a core. That made a core's
 * neighbours nearly as big as the core itself, so a node looked important only
 * for being next to one; now size says exactly one thing, "this is a core".
 *
 * `labels.js` reads the same sizes, so a core's name is the only one shown at
 * any distance, and every other name appears within the same reveal range.
 */

// Was 3 under the old rule; brought down by a quarter now that nothing around
// a core is enlarged to lead the eye up to it. Still above `labels.js`'s
// ALWAYS_ON_SIZE of 2, so a core stays labelled at any distance.
export const CORE_SIZE = 2.25

/**
 * Size multiplier for every node, as a Map keyed by node id. `nodes` is the
 * id -> node map.
 */
export function computeSizes(nodes) {
  const sizes = new Map()
  for (const [id, node] of nodes) sizes.set(id, node.is_core ? CORE_SIZE : 1)
  return sizes
}

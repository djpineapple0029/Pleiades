/**
 * The delete supernova's shockwave shell, shared by `supernova.js`, which
 * draws it, and `riverFlow.js`/`dustRivers.js`, which work out from the same
 * numbers where it has pushed the dust. Plain numbers, no Three.js.
 */

// Seconds the shell lives.
export const SHOCK_LIFE = 1.0
// Shock radius it eases out to, in radii, and the time constant it eases with.
export const SHOCK_REACH = 7
export const SHOCK_EASE = 0.28
// Push the shell gives the dust, world units per second at its crest.
export const SHOCK_PUSH = 260

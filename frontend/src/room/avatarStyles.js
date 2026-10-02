/**
 * How other people look in each Look (context/MOONSHOT.md decision 14):
 * a small ship in space, a submarine in the sea, a block cursor in the
 * terminal, a plain cone in Minimal. Built from three.js primitives, no
 * model files; every part keeps only positions so one instanced mesh can
 * draw any of them. Each points along -Z, a camera's forward, and is
 * centred on the pose.
 */
import * as THREE from 'three'

export const AVATAR_STYLES = ['ship', 'sub', 'cursor', 'marker']

/** Positions only, unindexed: what `merge` can concatenate. */
function positionsOf(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry
  const positions = flat.getAttribute('position').array.slice()
  if (flat !== geometry) flat.dispose()
  geometry.dispose()
  return positions
}

function merge(parts) {
  const arrays = parts.map(positionsOf)
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0))
  let at = 0
  for (const array of arrays) {
    out.set(array, at)
    at += array.length
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(out, 3))
  return geometry
}

function triangles(points) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3))
  return geometry
}

/** A cone with its tip along -Z. */
function nose(radius, length, segments) {
  const cone = new THREE.ConeGeometry(radius, length, segments)
  cone.rotateX(-Math.PI / 2)
  return cone
}

function ship(s) {
  // A slim body and two swept, flat wings (drawn both sides).
  const wing = (side) => [
    [side * 0.3 * s, 0, -0.4 * s],
    [side * 1.6 * s, 0, 1.6 * s],
    [side * 0.3 * s, 0, 1.6 * s],
  ]
  const fin = [
    [0, 0.3 * s, 0.6 * s],
    [0, 0.9 * s, 1.8 * s],
    [0, 0.3 * s, 1.8 * s],
  ]
  return merge([nose(0.6 * s, 4 * s, 8), triangles(wing(-1)), triangles(wing(1)), triangles(fin)])
}

function sub(s) {
  const hull = new THREE.CapsuleGeometry(0.8 * s, 2.4 * s, 4, 10)
  hull.rotateX(Math.PI / 2)
  const sail = new THREE.BoxGeometry(0.3 * s, 0.7 * s, 0.9 * s)
  sail.translate(0, 1.1 * s, -0.4 * s)
  const rudder = triangles([
    [0, 0, 1.2 * s],
    [0, 1.0 * s, 2.0 * s],
    [0, 0, 2.0 * s],
  ])
  return merge([hull, sail, rudder])
}

function cursor(s) {
  // A block cursor's outline: twelve thin bars round a box.
  const w = 1.2 * s
  const h = 2 * s
  const d = 2.4 * s
  const t = 0.14 * s
  const bars = []
  const bar = (x, y, z, sx, sy, sz) => {
    const box = new THREE.BoxGeometry(sx, sy, sz)
    box.translate(x, y, z)
    bars.push(box)
  }
  for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2]) bar(0, y, z, w + t, t, t)
  for (const x of [-w / 2, w / 2]) for (const z of [-d / 2, d / 2]) bar(x, 0, z, t, h + t, t)
  for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) bar(x, y, 0, t, t, d + t)
  return merge(bars)
}

function marker(s) {
  return merge([nose(1.2 * s, 3.5 * s, 12)])
}

const BUILD = { ship, sub, cursor, marker }

/** The shape for a style, at `size` (1 is the base scale); the marker for anything unknown. */
export function avatarGeometry(style, size = 2) {
  return (BUILD[style] ?? marker)(size)
}

/** The colour an avatar is drawn in: the person's, or for the cursor the look's ink tinted by it. */
export function avatarTint(style, colour, ink) {
  if (style !== 'cursor' || !ink) return colour
  // Half and half, channel by channel, as the hex values read.
  const channels = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const a = channels(ink)
  const b = channels(colour)
  return `#${a
    .map((v, i) =>
      Math.round((v + b[i]) / 2)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** The cursor's blink: on for half a second, off for half, once a second. */
export function blinkOn(now) {
  return Math.floor(now / 500) % 2 === 0
}

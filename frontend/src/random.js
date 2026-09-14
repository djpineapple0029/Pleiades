/** 32-bit hash of a string: FNV-1a, then the murmur3 finaliser. */
export function hash32(string, seed = 0x811c9dc5) {
  // FNV alone leaves sequential ids (n1, n2, ...) close together in the high
  // bits, which set a star's pulse rate.
  let h = seed
  for (let i = 0; i < string.length; i++) h = Math.imul(h ^ string.charCodeAt(i), 0x01000193)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** Mulberry32: a small seeded PRNG returning a function uniform on [0, 1). */
export function seededRandom(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

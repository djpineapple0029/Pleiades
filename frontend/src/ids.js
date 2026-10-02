/**
 * Ids for new stars and links (context/MOONSHOT.md): random, so two people
 * adding a star at the same moment never both mint `n26`. Files keep the ids
 * they were saved with — old `n25`-style ones included.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const LENGTH = 10
const SHORT = 4
const RANDOM_ID = new RegExp(`^[ne]-[0-9a-z]{${LENGTH}}$`)

const cryptoFill = (bytes) => globalThis.crypto.getRandomValues(bytes)

/** `n-k3f9x2q7ab`: the prefix, a dash, ten base-36 characters not in `taken`. */
export function randomId(prefix, taken, fill = cryptoFill) {
  for (;;) {
    const bytes = fill(new Uint8Array(LENGTH))
    let id = `${prefix}-`
    for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length]
    if (!taken.has(id)) return id
  }
}

/**
 * `n1`, `n2`… per prefix, skipping taken ids. For tests that name ids — and
 * that were written against the counter graph.js used to keep, which carried
 * on above the highest id in use and restarted on every load: `reset()`
 * (graph.load calls it) does the same, so a spec that clears its graph and
 * adds stars again gets `n1`… again, and the same star pulses and tints.
 */
export function sequentialIds() {
  const next = { n: 0, e: 0 }
  const fresh = { n: true, e: true }
  const mint = (prefix, taken) => {
    if (fresh[prefix]) {
      fresh[prefix] = false
      const pattern = new RegExp(`^${prefix}(\\d+)$`)
      for (const id of taken.keys()) {
        const match = pattern.exec(id)
        if (match) next[prefix] = Math.max(next[prefix], Number(match[1]))
      }
    }
    let id
    do id = `${prefix}${++next[prefix]}`
    while (taken.has(id))
    return id
  }
  mint.reset = () => {
    next.n = next.e = 0
    fresh.n = fresh.e = true
  }
  return mint
}

/**
 * How an id reads on screen: a random one shortened to its first four
 * characters (`n-k3f9x2q7ab` → `k3f9`), anything else — `n25` from an older
 * file — as it is.
 */
export function shortId(id) {
  return RANDOM_ID.test(id) ? id.slice(2, 2 + SHORT) : id
}

/** A star's name in the HUD and undo labels: its label, or its short id. */
export const nodeName = (node) => node.label || shortId(node.id)

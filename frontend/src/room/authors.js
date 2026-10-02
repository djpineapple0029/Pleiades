/**
 * Who made a remote change (context/MOONSHOT.md decision 11), as Yjs client
 * ids, and the colour the room gave them. Pure.
 *
 * A transaction's authors are the clients whose clock it advanced. Deletions
 * don't advance clocks, so a pure delete has no author: the supernova plays
 * and nothing is tinted.
 */
export function authorsOf(txn) {
  const authors = new Set()
  for (const [client, clock] of txn.afterState) {
    if (clock > (txn.beforeState.get(client) ?? 0)) authors.add(client)
  }
  return authors
}

/** Their colour from the room's roster (`clientIds` per person), or null. */
export function colourFor(clientId, roster) {
  for (const person of roster ?? []) if (person.clientIds?.includes(clientId)) return person.colour
  return null
}

/** `#rrggbb` → [r, g, b] on 0..1. */
export function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

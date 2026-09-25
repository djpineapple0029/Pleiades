/**
 * Star-name search: pure ranking, no DOM and no three.js, so it runs in Node.
 *
 * Case- and accent-insensitive. A name that starts with the query beats one
 * with a word starting with it, which beats one merely containing it. Ties go
 * to core stars, then to the better-connected, then to the shorter name (the
 * closer fit), then alphabetically so the order never flickers between frames.
 */

const PREFIX = 0
const WORD_START = 1
const SUBSTRING = 2

/** Lower-case with accents stripped: "Café" and "cafe" match each other. */
export function fold(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * `[tier, index]` of the best occurrence of `query` in `name` (both already
 * folded): PREFIX, WORD_START or SUBSTRING, or null for no match.
 */
function matchOf(name, query) {
  const at = name.indexOf(query)
  if (at < 0) return null
  if (at === 0) return [PREFIX, 0]
  // Any later occurrence right after a non-letter/digit counts as a word start.
  for (let i = at; i >= 0; i = name.indexOf(query, i + 1)) {
    if (!/[\p{L}\p{N}]/u.test(name[i - 1])) return [WORD_START, i]
  }
  return [SUBSTRING, at]
}

/**
 * Every named node matching `query`, best first, as
 * `{ id, label, isCore, degree, mark }`. `mark` is `[start, end]` of the
 * matched text in `label`, for highlighting — or null when folding changed the
 * name's length (a decomposed accent, say) and the offsets can't be trusted.
 * Nameless nodes are never matched, and an empty (or all-space) query matches
 * nothing.
 */
export function rankNodes(nodes, query, degreeOf) {
  const q = fold(query.trim())
  if (!q) return []
  const hits = []
  for (const node of nodes) {
    if (!node.label) continue
    const name = fold(node.label)
    const match = matchOf(name, q)
    if (!match) continue
    const [tier, at] = match
    const mark = name.length === node.label.length ? [at, at + q.length] : null
    hits.push({
      id: node.id,
      label: node.label,
      isCore: Boolean(node.is_core),
      degree: degreeOf(node.id),
      mark,
      tier,
      length: name.length,
    })
  }
  hits.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.isCore) - Number(a.isCore) ||
      b.degree - a.degree ||
      a.length - b.length ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  )
  return hits.map(({ id, label, isCore, degree, mark }) => ({ id, label, isCore, degree, mark }))
}

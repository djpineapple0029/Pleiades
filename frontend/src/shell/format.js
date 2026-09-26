/** Small, DOM-free wording helpers for the account shell's map list. */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "just now", "5 min ago", "3 hours ago", "yesterday", then a date. Both in unix seconds. */
export function relativeTime(then, now = Date.now() / 1000) {
  const age = Math.max(0, now - then)
  if (age < MINUTE) return 'just now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`
  if (age < DAY) return `${plural(Math.floor(age / HOUR), 'hour')} ago`
  if (age < 2 * DAY) return 'yesterday'
  if (age < 7 * DAY) return `${Math.floor(age / DAY)} days ago`
  return new Date(then * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** "12 stars · 5 min ago · 3.2 KB" */
export function mapSummary(map, now) {
  return [plural(map.node_count, 'star'), relativeTime(map.updated_at, now), formatSize(map.size_bytes)].join(
    ' · ',
  )
}

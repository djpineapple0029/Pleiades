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

// Why a version was kept (server/history.py's reasons). A plain hourly one says nothing.
const REASONS = {
  'before-restore': 'kept before a restore',
  'unsaved-edits': 'edits a tab dropped to load a newer version',
  'before-upload-replace': 'kept before an upload replaced it',
}

/** "Sep 30, 2:05 PM", in the reader's own locale and time zone. Unix seconds. */
export function dateTime(then) {
  return new Date(then * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** "12 stars · 3.2 KB · kept before a restore" */
export function versionSummary(snapshot) {
  const parts = [plural(snapshot.node_count, 'star'), formatSize(snapshot.size_bytes)]
  if (REASONS[snapshot.reason]) parts.push(REASONS[snapshot.reason])
  return parts.join(' · ')
}

const people = (n) => (n === 1 ? '1 person' : `${n} people`)

/**
 * The Restore confirm (context/MOONSHOT.md decision 13): with people in the
 * map it swaps for all of them, so it says so.
 */
export function restoreQuestion(online) {
  if (!online)
    return { text: 'Make this the current version? The current one is kept here first.', yes: 'Restore' }
  return {
    text: `${people(online)} ${online === 1 ? 'is' : 'are'} in this map. Restore this version for everyone? What’s there now is kept in History.`,
    yes: 'Restore for everyone',
  }
}

/** The Delete confirm (decision 22): it removes the map for everyone it reaches. */
export function deleteQuestion(members, online) {
  if (!members && !online) return { text: "Delete it for good? This can't be undone.", yes: 'Delete' }
  const after = 'Deleting it removes it for everyone.'
  if (!members)
    return {
      text: `${people(online)} ${online === 1 ? 'is' : 'are'} in this map now. ${after}`,
      yes: 'Delete for everyone',
    }
  const inNow = online ? `, and ${online} ${online === 1 ? 'is' : 'are'} in it now` : ''
  return { text: `This map is shared with ${people(members)}${inNow}. ${after}`, yes: 'Delete for everyone' }
}

const SHOWN_INITIALS = 3

/**
 * Who is in a map right now, for its row (context/MOONSHOT.md decision 17):
 * up to three coloured initials, "+N" for the rest, and every name in a
 * title. Null when nobody is. Names are text wherever this lands.
 */
export function whoIsIn(online) {
  if (!online?.length) return null
  const names = online.map((p) => (p.guest ? `${p.name} (guest)` : p.name))
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return {
    initials: online.slice(0, SHOWN_INITIALS).map((p) => ({
      initial: ([...(p.name ?? '').trim()][0] ?? '?').toUpperCase(),
      colour: p.colour,
    })),
    more: online.length > SHOWN_INITIALS ? `+${online.length - SHOWN_INITIALS}` : '',
    title: `In this map now: ${listed}`,
  }
}

/**
 * Whether two lists of map ids hold the same maps, whatever their order:
 * a live map saving moves up the list, which is no reason to rebuild it.
 */
export function sameMaps(shown, now) {
  if (shown.length !== now.length) return false
  const set = new Set(shown)
  return now.every((id) => set.has(id))
}

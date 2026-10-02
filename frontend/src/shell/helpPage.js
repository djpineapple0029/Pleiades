/**
 * Help (USERS.md decision 7a, V2.md F9): every key in a map, from the same
 * keymap the app builds, so it shows the keys this user actually has — their
 * own where they changed them (Settings), the defaults everywhere else. The
 * overlay's `?` list (keysHelp.js) is the short version of this page.
 */
import schema from '../../../server/settings_schema.json'
import { APP_ROWS } from '../keysHelp.js'
import { chordCaps, createKeymap } from '../keymap.js'

// What an action does differently on a map from My maps (keysHelp.js
// SERVER_MAP_ROWS says the same in the overlay).
const ON_SERVER_MAPS = {
  save: 'On a map from My maps it saves now; those also save by themselves.',
  save_as: 'On a map from My maps: saves a copy as a file.',
  open: 'Not on a map from My maps.',
}

/**
 * Shared maps (context/MOONSHOT.md): who can do what, and what to expect
 * when other people are in a map with you. Plain text, one paragraph a line.
 */
export const MULTIPLAYER_HELP = [
  {
    title: 'Sharing a map',
    lines: [
      'Share a map from My maps (or the Share link on the Esc screen): with someone’s username, or with a link anyone can open. Each person is an Owner, an Editor or a Viewer.',
      'The Owner made the map. Only they rename or delete it, change permissions, kick or ban people, and set the Look it opens in.',
      'Editors change stars, links, labels and notes. Viewers fly round, follow people and read notes, but change nothing.',
      'A link lets people in as Viewers or Editors, for as long as you choose. People without an account type a name and come in as guests.',
    ],
  },
  {
    title: 'Permissions',
    lines: [
      'Run Balance: rearrange the whole map. On for Editors.',
      'Export and download: save a copy as a file or a view-only page. On for Editors, off for Viewers.',
      'Invite people: share the map and manage its link, never above your own role. On for Editors, off for Viewers.',
      'View and restore history: off for both, until the Owner turns it on.',
      'Chat and emotes: on for Editors, off for Viewers.',
      'The Owner sets these for each role and, under Share, for each person.',
      'Editing, inviting, history, chat and downloads from My maps are checked by the server. Run Balance and Export in the map only hide the button: an editor can move every star by hand anyway, and anyone who can see a map can copy what they see.',
    ],
  },
  {
    title: 'In a map together',
    lines: [
      'Everyone else is a ship (or a submarine, or a cursor, as the Look has it) with their name over it; the bubbles top right are who’s here, and clicking one flies you to them.',
      'Edits land for everyone as they happen and glow for a moment in the colour of whoever made them. Typing in a star’s notes merges, and you can see where others are typing.',
      'Undo only takes back your own changes. If someone has changed the same thing since, undoing puts yours back on top of theirs.',
      'Deleting a star removes it for everyone, and closes anything anyone had open on it. Balance asks first when other editors are in the map.',
      'Chat, emote and follow with the keys under Multiplayer above. Chat isn’t saved: only the people in the map at the time see it.',
      'The Esc screen lists who’s here, with Follow, your chat, and Show editors / Show viewers to hide either group’s ships for you alone.',
      'If the connection drops, the map is view-only until you’re back; it reconnects by itself.',
    ],
  },
  {
    title: 'Guests and bans',
    lines: [
      'A guest has no account, so banning a guest is per browser tab: they can come back through the link from a new tab. For persistent trouble, use “Kick, ban and make a new link”, which stops the old link working for everyone.',
    ],
  },
]

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/** One `<kbd>` per chord, "or" between them; `none` when unbound. */
function chordNodes(chords) {
  if (!chords.length) return [el('span', { className: 'unbound', textContent: 'no key' })]
  const nodes = []
  chords.forEach((chord, i) => {
    if (i) nodes.push(el('span', { className: 'or', textContent: 'or' }))
    nodes.push(el('kbd', { textContent: chordCaps(chord).join('+') }))
  })
  return nodes
}

function row(keys, text, notes = []) {
  return el(
    'li',
    {},
    el('span', { className: 'keys' }, ...keys),
    el(
      'span',
      { className: 'what' },
      el('span', { textContent: text }),
      ...notes.map((note) => el('small', { textContent: note })),
    ),
  )
}

/** Fills `root` from `settings` as `fetchSettings` returns them. */
export function renderHelp(root, settings, { settingsHref = '#settings' } = {}) {
  const keymap = createKeymap(settings.keybinds)

  const intro = el(
    'header',
    { className: 'page-head' },
    el(
      'div',
      {},
      el('h1', { textContent: 'Help' }),
      el(
        'p',
        {},
        'Every key in a map, as you have them set. ',
        el('a', { href: settingsHref, textContent: 'Change them in Settings' }),
        '.',
      ),
    ),
  )

  // Mouse and the keys nobody can rebind, as the overlay words them.
  const fixed = APP_ROWS.filter((r) => r.caps)
  const mouse = el(
    'div',
    { className: 'card' },
    el('h2', { textContent: 'Mouse' }),
    el(
      'ul',
      { className: 'help-keys' },
      ...fixed.map((r) =>
        row(
          r.caps.map((cap) => el('kbd', { textContent: cap })),
          // The overlay's wording, in sentence case for a page of its own.
          r.text[0].toUpperCase() + r.text.slice(1),
        ),
      ),
    ),
  )

  const groups = new Map()
  for (const action of schema.keybinds) {
    if (!groups.has(action.group)) groups.set(action.group, [])
    groups.get(action.group).push(action)
  }
  const cards = [...groups].map(([group, actions]) =>
    el(
      'div',
      { className: 'card' },
      el('h2', { textContent: group }),
      el(
        'ul',
        { className: 'help-keys' },
        ...actions.map((action) => {
          const notes = []
          if (action.scope.includes('viewer')) notes.push('also in exported maps')
          if (ON_SERVER_MAPS[action.id]) notes.push(ON_SERVER_MAPS[action.id])
          const li = row(chordNodes(keymap.chords(action.id)), action.label, notes)
          li.dataset.action = action.id
          return li
        }),
      ),
    ),
  )
  const shared = el(
    'div',
    { className: 'card help-prose' },
    el('h2', { textContent: 'Shared maps' }),
    ...MULTIPLAYER_HELP.flatMap((section) => [
      el('h3', { textContent: section.title }),
      ...section.lines.map((line) => el('p', { textContent: line })),
    ]),
  )
  root.replaceChildren(intro, mouse, ...cards, shared)
}

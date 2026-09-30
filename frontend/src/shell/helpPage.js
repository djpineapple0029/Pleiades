/**
 * Help (USERS.md decision 7a, V2.md F9): every key in a map, from the same
 * keymap the app builds, so it shows the keys this user actually has — their
 * own where they changed them (Settings), the server's everywhere else. The
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
    'p',
    { className: 'note intro' },
    'Every key in a map, as they are for you right now. ',
    el('a', { href: settingsHref, textContent: 'Change them in Settings' }),
    '. Keys marked “also in exported maps” work in a view-only .html too.',
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
          r.text,
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
  root.replaceChildren(intro, mouse, ...cards)
}

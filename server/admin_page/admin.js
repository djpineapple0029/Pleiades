// The /admin page. Plain DOM, no build step: Flask serves this file as is, so
// the panel works on a server that has never run `npm run build`.
//
// Every URL here is relative — the page is also served under a path prefix
// (/pleiades/admin), and `api/admin/…` resolves against that the same way.

const TOKEN_KEY = 'pleiades-admin-token'
const STATUS_EVERY_MS = 5000
const MAX_BINDINGS = 3
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const SECTION_TITLES = {
  flight: 'Flight & feel',
  visuals: 'Visual effects',
  server: 'Server',
  accounts: 'Accounts',
  sharing: 'Sharing',
  admin: 'Admin access',
}
const SECTION_NOTES = {
  server: 'Applies to the next request, no restart needed.',
  accounts:
    'Applies to the next request. Maps kept here are readable by whoever runs the server; local files with a password stay private.',
  sharing: "Applies to the next request or connection. Shared maps count against their owner's map limit only.",
  admin: 'Applies to this panel at once. The allowed networks must include your own address.',
}
// Schema entries marked `user`: this panel sets the default a signed-in user
// starts from, and they may change it for themselves (server/account.py).
const USER_TAG = ' · users can change their own'
// Mirrors server/config.py: named keys by `event.key`, symbols by the character.
const NAMED = [
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]
const CHARS = new Set("/?[]{};:'\",.<>-_=`~!@#$%^&*()|\\")

const $ = (id) => document.getElementById(id)

let token = null
let schema = null
let saved = null // values as the server last confirmed them
let draft = null // what the form shows
let fieldErrors = {} // "keybinds.save" / "flight.move_speed" -> message
let listening = null // action id whose "+ key" is waiting for a chord
let tab = 'status'
let statusTimer = null

// --- Storage (can throw in private windows and previews) ----------------------

function remember(value) {
  token = value
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* in memory is enough; a reload just asks again */
  }
}

function recall() {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

// --- Server -------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetch(`api/admin/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }
  }
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && token && path !== 'password') {
    signedOut(data.error || 'Signed out.')
  }
  return { ok: response.ok, status: response.status, data }
}

// --- Sign-in ------------------------------------------------------------------

function showSignIn(message = '') {
  $('panel').hidden = true
  $('sign-out').hidden = true
  $('sign-in').hidden = false
  $('sign-in-error').textContent = message
  $('sign-in-password').focus()
  stopStatus()
}

function signedOut(message) {
  remember(null)
  saved = draft = null
  showSignIn(message)
}

$('sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = event.submitter
  button.disabled = true
  const { ok, data } = await api('login', { method: 'POST', body: { password: $('sign-in-password').value } })
  button.disabled = false
  if (!ok) {
    $('sign-in-error').textContent = data.error || 'Sign-in failed.'
    $('sign-in-password').select()
    return
  }
  $('sign-in-password').value = ''
  remember(data.token)
  await openPanel()
})

$('sign-out').addEventListener('click', async () => {
  if (isDirty() && !confirm('Discard unsaved changes and sign out?')) return
  await api('logout', { method: 'POST' })
  signedOut('')
})

async function openPanel() {
  const { ok, data } = await api('config')
  if (!ok) {
    if (token) signedOut(data.error)
    return
  }
  schema = data.schema
  saved = data.values
  draft = structuredClone(saved)
  fieldErrors = {}
  showProblems(data.problems)
  $('sign-in').hidden = true
  $('panel').hidden = false
  $('sign-out').hidden = false
  renderKeybinds()
  renderSettings()
  renderAccountsSettings()
  updateSavebar()
  selectTab(tab)
}

// --- Tabs ---------------------------------------------------------------------

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => selectTab(button.dataset.tab))
}

function selectTab(name) {
  tab = name
  stopListening()
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name))
  }
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name
  if (name === 'status') startStatus()
  else stopStatus()
  if (name === 'accounts') loadUsers()
  updateSavebar()
}

// --- Status -------------------------------------------------------------------

function startStatus() {
  stopStatus()
  refreshStatus()
  statusTimer = setInterval(() => {
    if (!document.hidden) refreshStatus()
  }, STATUS_EVERY_MS)
}

function stopStatus() {
  clearInterval(statusTimer)
  statusTimer = null
}

async function refreshStatus() {
  const { ok, data } = await api('status')
  if (!ok) return
  renderStatus(data)
}

function tile(label, value, sub = '') {
  const el = document.createElement('div')
  el.className = 'tile'
  el.append(
    Object.assign(document.createElement('div'), { className: 'label', textContent: label }),
    Object.assign(document.createElement('div'), { className: 'value', textContent: value }),
  )
  if (sub) el.append(Object.assign(document.createElement('div'), { className: 'sub', textContent: sub }))
  return el
}

function duration(seconds) {
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m ${s % 60}s`
}

function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return i ? `${n.toFixed(1)} ${units[i]}` : `${n} B`
}

const when = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString() : '—')
const clock = (epoch) => new Date(epoch * 1000).toLocaleTimeString()

function renderStatus({ requests, build, server, accounts }) {
  const st = requests.status
  $('stat-tiles').replaceChildren(
    tile('Uptime', duration(requests.uptime), `since ${new Date(requests.started * 1000).toLocaleString()}`),
    tile('Requests', String(requests.total), `${requests.in_flight} in flight`),
    tile('Errors', String((st['4xx'] || 0) + (st['5xx'] || 0)), `${st['4xx'] || 0} 4xx · ${st['5xx'] || 0} 5xx`),
    tile('Data sent', bytes(requests.bytes_sent)),
    tile('Clients', String(requests.unique_clients), 'unique addresses'),
    accountsTile(accounts),
  )

  const facts = [
    ['Bundle', build.bundle || 'no build in server/static'],
    ['Built', when(build.built)],
    ['Config file', server.config_path],
    ['Accounts database', accounts.database.exists ? `${accounts.database.path} · ${bytes(accounts.database.bytes)}` : 'not created yet'],
    ['Process', `pid ${server.pid} · Python ${server.python}`],
  ]
  $('server-info').replaceChildren(
    ...facts.flatMap(([k, v]) => [
      Object.assign(document.createElement('dt'), { textContent: k }),
      Object.assign(document.createElement('dd'), { textContent: v }),
    ]),
  )

  const clients = requests.top_clients.map(([ip, n]) => {
    const li = document.createElement('li')
    li.append(ip, Object.assign(document.createElement('span'), { className: 'muted', textContent: `${n} requests` }))
    return li
  })
  if (!clients.length) clients.push(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'none yet' }))
  $('top-clients').replaceChildren(...clients)

  $('recent').replaceChildren(
    ...requests.recent.map((r) => {
      const row = document.createElement('tr')
      for (const [text, cls] of [
        [clock(r.time), ''],
        [`${r.method} ${r.path}`, ''],
        [String(r.status), `s${String(r.status)[0]}`],
        [r.client, ''],
      ]) {
        row.append(Object.assign(document.createElement('td'), { textContent: text, className: cls }))
      }
      return row
    }),
  )

  showProblems(server.problems)
  $('generated').hidden = !server.password_generated
}

function accountsTile({ enabled, database }) {
  if (!enabled && !database.exists) return tile('Accounts', 'off')
  return tile(
    'Accounts',
    enabled ? plural(database.users, 'user') : `off · ${plural(database.users, 'user')}`,
    `${plural(database.maps, 'map')} · ${bytes(database.bytes)}`,
  )
}

function showProblems(problems) {
  const list = $('problems')
  list.replaceChildren(
    ...(problems || []).map((p) => Object.assign(document.createElement('li'), { textContent: `Config file: ${p}` })),
  )
  list.hidden = !problems?.length
}

// --- Keybinds -----------------------------------------------------------------

const pretty = (chord) =>
  chord
    .split('+')
    .map((part) => (part === 'Mod' ? (IS_MAC ? '⌘' : 'Ctrl') : part === 'Cmd' ? '⌘' : part))
    .join('+')

function resetButton(label, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'quiet'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function renderKeybinds() {
  const root = $('keybinds')
  const groups = new Map()
  for (const action of schema.keybinds) {
    if (!groups.has(action.group)) groups.set(action.group, [])
    groups.get(action.group).push(action)
  }
  const cards = [...groups].map(([group, actions]) => {
    const card = document.createElement('div')
    card.className = 'card group'
    card.append(Object.assign(document.createElement('h2'), { textContent: group }))
    for (const action of actions) card.append(bindRow(action))
    return card
  })
  const tools = document.createElement('p')
  tools.append(
    resetButton('Reset all keybinds to defaults', () => {
      for (const action of schema.keybinds) draft.keybinds[action.id] = [...action.default]
      changed()
    }),
  )
  root.replaceChildren(tools, ...cards)
}

function bindRow(action) {
  const row = document.createElement('div')
  row.className = 'bind-row'
  const current = draft.keybinds[action.id] || []
  if (JSON.stringify(current) !== JSON.stringify(saved.keybinds[action.id] || [])) row.classList.add('changed')

  const name = document.createElement('div')
  name.className = 'name'
  const where = action.scope.includes('viewer') ? ' · also in exported maps' : ''
  const own = action.user ? USER_TAG : ''
  name.append(action.label, Object.assign(document.createElement('small'), { textContent: `${action.id}${where}${own}` }))

  const chips = document.createElement('div')
  chips.className = 'chips'
  current.forEach((chord, i) => {
    const chip = document.createElement('span')
    chip.className = 'chip'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `Remove ${pretty(chord)} from ${action.label}`)
    remove.addEventListener('click', () => {
      draft.keybinds[action.id] = current.filter((_, j) => j !== i)
      changed()
    })
    chip.append(pretty(chord), remove)
    chips.append(chip)
  })
  if (!current.length) chips.append(Object.assign(document.createElement('span'), { className: 'note', textContent: 'unbound' }))

  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'quiet add'
  const isListening = listening === action.id
  add.classList.toggle('listening', isListening)
  add.textContent = isListening ? 'press keys… (Esc cancels)' : '+ key'
  add.disabled = !isListening && current.length >= MAX_BINDINGS
  add.addEventListener('click', () => {
    listening = isListening ? null : action.id
    renderKeybinds()
  })
  chips.append(add)

  if (JSON.stringify(current) !== JSON.stringify(action.default)) {
    const reset = resetButton('default', () => {
      draft.keybinds[action.id] = [...action.default]
      changed()
    })
    reset.classList.add('reset')
    reset.title = `Back to ${action.default.map(pretty).join(', ') || 'unbound'}`
    chips.append(reset)
  }

  row.append(name, chips)
  const error = fieldErrors[`keybinds.${action.id}`]
  if (error) row.append(Object.assign(document.createElement('p'), { className: 'error', textContent: error }))
  return row
}

function stopListening() {
  if (!listening) return
  listening = null
  renderKeybinds()
}

/** A keydown as chord text in the config's syntax, or null to keep waiting.
 *  frontend/src/keymap.js `chordFromEvent` is the same rule for the account
 *  shell; this page has no build step, so it can't import that one. */
function chordFrom(event, movement) {
  const { key, code } = event
  if (key === 'Shift') return movement ? 'Shift' : null
  if (['Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock', 'OS'].includes(key)) return null
  let name
  if (/^Key[A-Z]$/.test(code)) name = code.slice(3)
  else if (/^Digit\d$/.test(code)) name = code.slice(5)
  else if (code === 'Space') name = 'Space'
  else if (NAMED.includes(key)) name = key
  else if (CHARS.has(key)) name = key
  else return undefined // a key the config can't name

  const mods = []
  // ⌘ is always Mod. Ctrl is Mod off a Mac; on a Mac it's Ctrl proper.
  if (event.metaKey || (event.ctrlKey && !IS_MAC)) mods.push('Mod')
  if (event.ctrlKey && IS_MAC) mods.push('Ctrl')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey && !CHARS.has(name)) mods.push('Shift')
  return [...mods, name].join('+')
}

document.addEventListener(
  'keydown',
  (event) => {
    if (!listening) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      stopListening()
      return
    }
    const action = schema.keybinds.find((a) => a.id === listening)
    const chord = chordFrom(event, action.movement)
    if (chord === null) return
    if (chord === undefined) {
      toast(`${event.key} can't be bound.`)
      return
    }
    const list = draft.keybinds[action.id]
    if (!list.includes(chord)) draft.keybinds[action.id] = [...list, chord]
    listening = null
    changed()
  },
  true,
)

// --- Settings -----------------------------------------------------------------

// The accounts section lives on the Accounts tab, above the users it governs.
const ACCOUNTS_SECTION = 'accounts'

function settingsCard(section) {
  const card = document.createElement('div')
  card.className = 'card'
  card.append(Object.assign(document.createElement('h2'), { textContent: SECTION_TITLES[section] || section }))
  if (section in SECTION_NOTES) {
    card.append(Object.assign(document.createElement('p'), { className: 'note', textContent: SECTION_NOTES[section] }))
  }
  for (const spec of schema.settings.filter((s) => s.section === section)) card.append(settingRow(spec))
  return card
}

function renderAccountsSettings() {
  $('accounts-settings').replaceChildren(settingsCard(ACCOUNTS_SECTION))
}

function renderSettings() {
  const root = $('settings')
  const sections = [...new Set(schema.settings.map((s) => s.section))].filter((s) => s !== ACCOUNTS_SECTION)
  const tools = document.createElement('p')
  tools.append(
    resetButton('Reset flight & visuals to defaults', () => {
      for (const spec of schema.settings) {
        if (spec.scope === 'client') draft[spec.section][spec.key] = structuredClone(spec.default)
      }
      changed()
    }),
  )
  root.replaceChildren(tools, ...sections.map(settingsCard))
}

function settingRow(spec) {
  const path = `${spec.section}.${spec.key}`
  const value = draft[spec.section][spec.key]
  const row = document.createElement('div')
  row.className = 'setting'
  if (JSON.stringify(value) !== JSON.stringify(saved[spec.section][spec.key])) row.classList.add('changed')

  const head = document.createElement('div')
  head.className = 'head'
  const id = `set-${spec.section}-${spec.key}`
  head.append(Object.assign(document.createElement('label'), { htmlFor: id, textContent: spec.label, className: 'inline' }))

  const control = document.createElement('div')
  control.className = 'control'
  const set = (v) => {
    draft[spec.section][spec.key] = v
    changed({ rerender: false })
    row.classList.toggle('changed', JSON.stringify(v) !== JSON.stringify(saved[spec.section][spec.key]))
  }

  if (spec.type === 'boolean') {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked: value })
    box.addEventListener('change', () => set(box.checked))
    control.append(box)
  } else if (spec.type === 'choice') {
    const select = Object.assign(document.createElement('select'), { id })
    for (const option of spec.options) select.append(new Option(option, option, false, option === value))
    select.addEventListener('change', () => set(select.value))
    control.append(select)
  } else if (spec.type === 'number' || spec.type === 'integer') {
    const step = spec.step ?? 1
    const number = Object.assign(document.createElement('input'), {
      type: 'number', id, min: spec.min, max: spec.max, step, value,
    })
    const parse = (text) => (spec.type === 'integer' ? parseInt(text, 10) : parseFloat(text))
    if (spec.type === 'number') {
      const range = Object.assign(document.createElement('input'), {
        type: 'range', min: spec.min, max: spec.max, step, value,
      })
      range.setAttribute('aria-label', spec.label)
      range.addEventListener('input', () => {
        number.value = range.value
        set(parse(range.value))
      })
      number.addEventListener('input', () => {
        if (number.value !== '') range.value = number.value
      })
      control.append(range)
    }
    number.addEventListener('input', () => {
      const v = parse(number.value)
      if (Number.isFinite(v)) set(v)
    })
    control.append(number)
  } else if (spec.type === 'networks') {
    const area = Object.assign(document.createElement('textarea'), { id, rows: 3, value: value.join('\n') })
    area.addEventListener('input', () => set(area.value.split(/[\n,]/).map((l) => l.trim()).filter(Boolean)))
    row.append(head, Object.assign(document.createElement('p'), { className: 'help', textContent: spec.help }), area)
    appendError(row, path)
    return row
  }
  head.append(control)
  const help = spec.user ? `${spec.help}${USER_TAG}` : spec.help
  row.append(head, Object.assign(document.createElement('p'), { className: 'help', textContent: help }))
  appendError(row, path)
  return row
}

function appendError(row, path) {
  const error = fieldErrors[path]
  if (error) row.append(Object.assign(document.createElement('p'), { className: 'error', textContent: error }))
}

// --- Saving -------------------------------------------------------------------

function isDirty() {
  return !!draft && JSON.stringify(draft) !== JSON.stringify(saved)
}

function changed({ rerender = true } = {}) {
  if (rerender) {
    renderKeybinds()
    renderSettings()
    renderAccountsSettings()
  }
  updateSavebar()
}

function updateSavebar() {
  $('savebar').hidden = !isDirty()
  $('save-state').textContent = 'Unsaved changes'
}

$('discard').addEventListener('click', () => {
  draft = structuredClone(saved)
  fieldErrors = {}
  changed()
})

$('save').addEventListener('click', async () => {
  const button = $('save')
  button.disabled = true
  const { ok, data } = await api('config', { method: 'PUT', body: draft })
  button.disabled = false
  if (!ok) {
    fieldErrors = {}
    const loose = []
    for (const message of data.errors || [data.error || 'Save failed.']) {
      const match = /^([a-z_]+\.[a-z_]+): (.*)$/.exec(message)
      if (match) fieldErrors[match[1]] = fieldErrors[match[1]] ? `${fieldErrors[match[1]]} · ${match[2]}` : match[2]
      else loose.push(message)
    }
    changed()
    $('save-state').textContent = `Not saved: ${loose.join(' · ') || 'fix the marked fields'}`
    return
  }
  saved = data.values
  draft = structuredClone(saved)
  fieldErrors = {}
  showProblems([])
  changed()
  toast('Saved. Browsers pick it up on their next load.')
})

window.addEventListener('beforeunload', (event) => {
  if (!isDirty()) return
  event.preventDefault()
  event.returnValue = ''
})

// --- Users (server/admin_users.py) ---------------------------------------------

let users = []
// What's open under a row, by user id: {kind: 'reset' | 'delete' | 'password', …}.
const userPanels = new Map()
const rowErrors = new Map()

async function loadUsers() {
  const { ok, data } = await api('users')
  if (!ok) {
    $('users-error').textContent = data.error || 'Could not load the accounts.'
    return
  }
  $('users-error').textContent = ''
  users = data.users
  const ids = new Set(users.map((u) => u.id))
  for (const id of [...userPanels.keys()]) if (!ids.has(id)) userPanels.delete(id)
  $('users-off').hidden = data.enabled
  renderUsers()
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const day = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleDateString() : '—')

function renderUsers() {
  $('user-count').textContent = users.length ? `(${users.length})` : ''
  $('users-table').hidden = !users.length
  $('users-empty').hidden = users.length > 0
  $('users').replaceChildren(...users.flatMap(userRows))
}

function cell(text, className = '', title = '') {
  return Object.assign(document.createElement('td'), { textContent: text, className, title })
}

function smallButton(label, onClick, className = 'quiet small') {
  const button = resetButton(label, onClick)
  button.className = className
  return button
}

function userRows(user) {
  const row = document.createElement('tr')
  row.dataset.user = user.username
  if (user.disabled) row.className = 'disabled'
  const status = user.disabled ? 'Disabled' : user.must_change_password ? 'Reset, not yet changed' : 'Active'
  const statusCell = cell(status, user.disabled ? 'bad' : user.must_change_password ? 'warn' : '')
  statusCell.append(
    Object.assign(document.createElement('small'), {
      textContent: user.sessions ? `signed in on ${plural(user.sessions, 'device')}` : 'signed out',
    }),
  )
  const storage = user.map_bytes + user.history_bytes
  const actions = document.createElement('td')
  actions.className = 'actions'
  actions.append(
    smallButton('Reset password', () => openUserPanel(user, { kind: 'reset' })),
    smallButton(user.disabled ? 'Enable' : 'Disable', () => setDisabled(user, !user.disabled)),
    smallButton('Sign out everywhere', () => signOutEverywhere(user)),
    smallButton('Delete', () => openUserPanel(user, { kind: 'delete' }), 'quiet small danger'),
  )
  actions.querySelectorAll('button')[2].disabled = !user.sessions
  row.append(
    cell(user.username, 'name'),
    cell(day(user.created_at), '', when(user.created_at)),
    cell(day(user.last_seen_at), '', user.last_seen_at ? when(user.last_seen_at) : 'never signed in'),
    cell(String(user.map_count), 'num'),
    cell(bytes(storage), 'num', `maps ${bytes(user.map_bytes)} · history ${bytes(user.history_bytes)}`),
    statusCell,
    actions,
  )
  const rows = [row]
  const panel = userPanels.get(user.id)
  const error = rowErrors.get(user.id)
  if (panel || error) {
    const extra = document.createElement('tr')
    extra.className = 'row-panel'
    const td = document.createElement('td')
    td.colSpan = 7
    if (panel) td.append(panelFor(user, panel))
    if (error) td.append(Object.assign(document.createElement('p'), { className: 'error', textContent: error }))
    extra.append(td)
    rows.push(extra)
  }
  return rows
}

function openUserPanel(user, panel) {
  rowErrors.delete(user.id)
  const current = userPanels.get(user.id)
  // The same button again closes it; a temporary password stays until Done.
  if (current?.kind === panel.kind) userPanels.delete(user.id)
  else if (current?.kind !== 'password') userPanels.set(user.id, panel)
  renderUsers()
  $('users').querySelector('.row-panel input, .row-panel button.danger, .row-panel button:not(.quiet)')?.focus()
}

function closeUserPanel(user) {
  userPanels.delete(user.id)
  renderUsers()
}

function panelFor(user, panel) {
  const box = document.createElement('div')
  box.className = 'confirm'
  const text = (t) => Object.assign(document.createElement('p'), { textContent: t })
  if (panel.kind === 'reset') {
    box.append(
      text(
        `Reset ${user.username}'s password? They're signed out everywhere and have to choose a new ` +
          'password when they next sign in. Their maps are kept.',
      ),
      smallButton('Reset password', (event) => resetPassword(user, event.currentTarget), 'small danger'),
      smallButton('Cancel', () => closeUserPanel(user)),
    )
  } else if (panel.kind === 'delete') {
    const what = user.map_count ? `, ${plural(user.map_count, 'map')} and their history` : ''
    const label = document.createElement('label')
    label.className = 'typed'
    const input = Object.assign(document.createElement('input'), {
      type: 'text',
      autocomplete: 'off',
      spellcheck: false,
      value: panel.typed || '',
    })
    input.setAttribute('autocapitalize', 'none')
    label.append(`Type ${user.username} to confirm`, input)
    const yes = smallButton('Delete for good', () => deleteUser(user, input.value, yes), 'small danger')
    const matches = () => input.value.trim().toLowerCase() === user.username
    yes.disabled = !matches()
    input.addEventListener('input', () => {
      panel.typed = input.value
      yes.disabled = !matches()
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && matches()) deleteUser(user, input.value, yes)
      if (event.key === 'Escape') closeUserPanel(user)
    })
    box.append(
      text(`Delete the account ${user.username}${what}? This can't be undone.`),
      label,
      yes,
      smallButton('Cancel', () => closeUserPanel(user)),
    )
  } else if (panel.kind === 'password') {
    const code = Object.assign(document.createElement('code'), { className: 'temp', textContent: panel.password })
    const copy = smallButton('Copy', async () => {
      try {
        await navigator.clipboard.writeText(panel.password)
        copy.textContent = 'Copied'
      } catch {
        // No clipboard over plain http: select it for Ctrl/⌘+C instead.
        getSelection().selectAllChildren(code)
        copy.textContent = 'Selected, press Ctrl/⌘+C'
      }
    })
    const line = document.createElement('p')
    line.append(`Temporary password for ${user.username}: `, code, ' ', copy)
    box.append(
      line,
      text("Shown once. Give it to them; they'll choose their own when they sign in with it."),
      smallButton('Done', () => closeUserPanel(user)),
    )
  }
  return box
}

async function userAction(user, button, path, options) {
  if (button) button.disabled = true
  const { ok, data } = await api(`users/${user.id}${path}`, options)
  if (button) button.disabled = false
  if (!ok) {
    rowErrors.set(user.id, data.error || "That didn't work.")
    renderUsers()
    return null
  }
  rowErrors.delete(user.id)
  return data
}

async function resetPassword(user, button) {
  const data = await userAction(user, button, '/password', { method: 'POST' })
  if (!data) return
  userPanels.set(user.id, { kind: 'password', password: data.password })
  await loadUsers()
}

async function setDisabled(user, disabled) {
  if (await userAction(user, null, '', { method: 'PATCH', body: { disabled } })) {
    toast(disabled ? `${user.username} is disabled and signed out.` : `${user.username} can sign in again.`)
    await loadUsers()
  }
}

async function signOutEverywhere(user) {
  const data = await userAction(user, null, '/sign-out', { method: 'POST' })
  if (data) {
    toast(`${user.username} is signed out on ${plural(data.ended, 'device')}.`)
    await loadUsers()
  }
}

async function deleteUser(user, typed, button) {
  if (typed.trim().toLowerCase() !== user.username) return
  if (await userAction(user, button, '', { method: 'DELETE', body: { username: typed } })) {
    userPanels.delete(user.id)
    toast(`Deleted ${user.username}.`)
    await loadUsers()
  }
}

// --- Password -----------------------------------------------------------------

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  $('pw-error').textContent = ''
  $('pw-ok').textContent = ''
  const current = $('pw-current').value
  const next = $('pw-new').value
  if (next !== $('pw-confirm').value) {
    $('pw-error').textContent = "The new passwords don't match."
    return
  }
  const button = event.submitter
  button.disabled = true
  const { ok, data } = await api('password', { method: 'POST', body: { current, new: next } })
  button.disabled = false
  if (!ok) {
    $('pw-error').textContent = data.error || 'Could not change the password.'
    return
  }
  remember(data.token)
  event.target.reset()
  $('generated').hidden = true
  $('pw-ok').textContent = 'Password changed.'
})

// --- Toast --------------------------------------------------------------------

let toastTimer = null
function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), 3500)
}

// --- Start --------------------------------------------------------------------

const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
$('insecure').hidden = location.protocol === 'https:' || local

token = recall()
if (token) openPanel()
else showSignIn()

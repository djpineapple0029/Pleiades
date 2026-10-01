/**
 * The account shell (USERS.md, "Frontend"): sign in or sign up, then the list
 * of your maps, your Settings, Help and Account (`#settings`, `#help`,
 * `#account`). Plain DOM, no
 * WebGL: it loads fast and works where the scene can't. Opening a map hands
 * over to the app at `?map=<id>`.
 *
 * Every name the server sends is set as text, never as markup.
 */
import '@fontsource/jost/400.css'
import '@fontsource/jost/500.css'
import './shell.css'
import { BASE, appUrl, homeUrl, request } from '../api.js'
import { triggerDownload } from '../files.js'
import { createBackupStore } from '../localBackup.js'
import { fetchSettings } from '../settings.js'
import { createAccountPage } from './accountPage.js'
import { dateTime, mapSummary, relativeTime, versionSummary } from './format.js'
import { renderHelp } from './helpPage.js'
import { ACCEPT, fileName, mapFileBlob, nameFromFile, probe, readMapFile, readsHere } from './mapFiles.js'
import { createSettingsPage } from './settingsPage.js'

const $ = (id) => document.getElementById(id)
const backups = createBackupStore()
const views = [
  'loading',
  'off',
  'insecure',
  'signed-out',
  'must-change',
  'signed-in',
  'settings-view',
  'help-view',
  'account-view',
]
// Signed in, the hash picks the page; anything else is My maps.
const PAGES = {
  maps: { view: 'signed-in', title: 'My maps' },
  settings: { view: 'settings-view', title: 'Settings' },
  help: { view: 'help-view', title: 'Help' },
  account: { view: 'account-view', title: 'Account' },
}
let signedInNow = false

const NOTICES = {
  missing: "That map doesn't exist any more, or it belongs to another account.",
}

function show(view) {
  for (const id of views) $(id).hidden = id !== view
  signedInNow = Object.values(PAGES).some((page) => page.view === view)
  // Someone whose password was reset can still sign out instead.
  $('who').hidden = !signedInNow && view !== 'must-change'
  $('pages').hidden = !signedInNow
  // Signed out: a draft belongs to whoever was signed in, not the next person.
  if (!signedInNow) {
    settingsPage.forget()
    accountPage.forget()
    cancelUpload()
  }
}

function notice(text) {
  $('notice').textContent = text
  $('notice').hidden = !text
}

function setError(id, text) {
  $(id).textContent = text ?? ''
}

/** Disables a form's controls for the length of `work`. */
async function busy(form, work) {
  const controls = [...form.querySelectorAll('input, button')]
  for (const control of controls) control.disabled = true
  try {
    return await work()
  } finally {
    for (const control of controls) control.disabled = false
  }
}

// --- Signed out ---------------------------------------------------------------

let signupOpen = false

function selectTab(which) {
  const signUp = which === 'sign-up' && signupOpen
  $('tab-sign-in').setAttribute('aria-selected', String(!signUp))
  $('tab-sign-up').setAttribute('aria-selected', String(signUp))
  $('sign-in-form').hidden = signUp
  $('sign-up-form').hidden = !signUp
  $(signUp ? 'sign-up-username' : 'sign-in-username').focus()
}

// Plain HTTP from the network (server/accounts.py `secure_enough`): say what
// that means once per tab before anyone types a password.
const WARNED_KEY = 'pleiades.plain-http-ok'

function warnedAlready() {
  try {
    return sessionStorage.getItem(WARNED_KEY) === '1'
  } catch {
    return false
  }
}

function showSignedOut(me) {
  if (me.secure === false && !warnedAlready()) {
    document.title = 'Not encrypted — Pleiades'
    show('insecure')
    $('insecure-continue').onclick = () => {
      try {
        sessionStorage.setItem(WARNED_KEY, '1')
      } catch {
        // Private mode and the like: it asks again next time, nothing worse.
      }
      showSignedOut({ ...me, secure: true })
    }
    return
  }
  signupOpen = Boolean(me.signup_open)
  $('tab-sign-up').hidden = !signupOpen
  $('sign-up-min').textContent = me.min_password_length ? `At least ${me.min_password_length} characters` : ''
  document.title = 'Sign in — Pleiades'
  show('signed-out')
  selectTab(wantSignUp ? 'sign-up' : 'sign-in')
  wantSignUp = false
}

$('tab-sign-in').addEventListener('click', () => selectTab('sign-in'))
$('tab-sign-up').addEventListener('click', () => selectTab('sign-up'))

$('sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  setError('sign-in-error', '')
  const username = $('sign-in-username').value.trim()
  const password = $('sign-in-password').value
  if (!username || !password) return setError('sign-in-error', 'Enter your username and password.')
  const result = await busy(form, () =>
    request('api/auth/login', { method: 'POST', body: { username, password } }),
  )
  if (!result.ok) {
    $('sign-in-password').value = ''
    $('sign-in-password').focus()
    return setError('sign-in-error', result.error)
  }
  $('sign-in-password').value = ''
  notice('')
  start()
})

$('sign-up-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  setError('sign-up-error', '')
  const username = $('sign-up-username').value.trim().toLowerCase()
  const password = $('sign-up-password').value
  if (password !== $('sign-up-confirm').value) {
    $('sign-up-confirm').value = ''
    $('sign-up-confirm').focus()
    return setError('sign-up-error', 'The passwords do not match.')
  }
  const result = await busy(form, () =>
    request('api/auth/signup', { method: 'POST', body: { username, password } }),
  )
  if (!result.ok) return setError('sign-up-error', result.error)
  $('sign-up-password').value = ''
  $('sign-up-confirm').value = ''
  notice('')
  start()
})

$('sign-out').addEventListener('click', async () => {
  await request('api/auth/logout', { method: 'POST' })
  // Unsaved edits this browser kept are plaintext, and belong to whoever signed in.
  await backups.clear()
  start()
})

// --- Password reset by the admin ------------------------------------------------

function showMustChange(me) {
  document.title = 'Choose a new password — Pleiades'
  $('who-name').textContent = me.user.username
  $('must-change-username').value = me.user.username
  $('must-change-min').textContent = me.min_password_length
    ? `At least ${me.min_password_length} characters`
    : ''
  show('must-change')
  $('must-change-password').focus()
}

$('must-change-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  setError('must-change-error', '')
  const password = $('must-change-password').value
  if (!password) return setError('must-change-error', 'Enter a new password.')
  if (password !== $('must-change-confirm').value) {
    $('must-change-confirm').value = ''
    $('must-change-confirm').focus()
    return setError('must-change-error', 'The passwords do not match.')
  }
  const result = await busy(form, () =>
    request('api/account/password', { method: 'POST', body: { new: password } }),
  )
  if (!result.ok) return signedOutBy(result) || setError('must-change-error', result.error)
  $('must-change-password').value = ''
  $('must-change-confirm').value = ''
  notice('Password changed.')
  start()
})

// --- Signed in ----------------------------------------------------------------

/**
 * A 401 anywhere means the session is gone: back to the sign-in form. A 403
 * saying the password must change (an admin reset it meanwhile) goes to that.
 */
function signedOutBy(result) {
  if (result.status === 403 && result.data?.must_change_password) {
    start()
    return true
  }
  // A password typed to confirm something was wrong; the session is fine.
  if (result.status !== 401 || result.data?.wrong_password) return false
  notice('You were signed out. Sign in again.')
  start()
  return true
}

async function showSignedIn(me) {
  $('who-name').textContent = me.user.username
  accountPage.setMinPasswordLength(me.min_password_length)
  await route()
}

function pageName() {
  const name = location.hash.slice(1)
  return name in PAGES ? name : 'maps'
}

/** Shows the page the hash names. */
async function route() {
  const name = pageName()
  const page = PAGES[name]
  document.title = `${page.title} — Pleiades`
  for (const link of $('pages').querySelectorAll('a')) {
    if (link.dataset.page === name) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  if (name !== 'settings') settingsPage.close()
  // Passwords typed on Account don't wait around on another page.
  if (name !== 'account') accountPage.forget()
  if (name !== 'maps') cancelUpload()
  show(page.view)
  if (name === 'maps') {
    listStatus('')
    await refreshList()
  } else if (name === 'settings') await settingsPage.open()
  else if (name === 'account') await accountPage.open()
  else await showHelp()
}

async function showHelp() {
  // Fresh each time: it should show keys just saved in Settings.
  $('help-view').replaceChildren(
    Object.assign(document.createElement('p'), { className: 'note', textContent: 'Loading…' }),
  )
  renderHelp($('help-view'), await fetchSettings(`${BASE}api/config`))
}

const settingsPage = createSettingsPage({ root: $('settings-view'), request, onSignedOut: signedOutBy })

const accountPage = createAccountPage({
  request,
  onSignedOut: signedOutBy,
  onUsername: (name) => {
    $('who-name').textContent = name
  },
  onDeleted: async () => {
    // Nothing of the account stays behind in this browser either.
    await backups.clear()
    notice('Your account and its maps were deleted.')
    // Not `location.hash = ''`: its hashchange would route a page that's
    // still signed in, find the session gone and say "you were signed out".
    history.replaceState(null, '', location.pathname + location.search)
    start()
  },
})

window.addEventListener('hashchange', () => {
  if (signedInNow) route()
})

window.addEventListener('beforeunload', (event) => {
  if (!settingsPage.isDirty) return
  event.preventDefault()
  event.returnValue = ''
})

async function refreshList() {
  const result = await request('api/maps')
  if (!result.ok) {
    if (!signedOutBy(result)) setError('list-error', `Could not load your maps: ${result.error}`)
    return
  }
  setError('list-error', '')
  renderList(result.data.maps)
}

// The list as last shown, by id.
const mapsById = new Map()

function renderList(maps) {
  const now = Date.now() / 1000
  mapsById.clear()
  for (const map of maps) mapsById.set(map.id, map)
  $('maps').replaceChildren(...maps.map((map) => mapRow(map, now)))
  $('empty').hidden = maps.length > 0
  $('map-count').textContent = maps.length ? `(${maps.length})` : ''
}

function button(label, onClick, className = 'quiet small') {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  el.textContent = label
  el.addEventListener('click', onClick)
  return el
}

function mapRow(map, now) {
  const row = document.createElement('li')
  row.className = 'map'
  row.dataset.id = map.id

  const info = document.createElement('div')
  info.className = 'info'
  const link = document.createElement('a')
  link.className = 'name'
  link.href = appUrl(map.id)
  link.textContent = map.name
  const meta = document.createElement('span')
  meta.className = 'meta'
  meta.textContent = mapSummary(map, now)
  info.append(link, meta)

  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(
    button('History', () => toggleHistory(row, map)),
    button('Download', () => toggleDownload(row, map)),
    button('Rename', () => startRename(row, map)),
    button('Duplicate', () => duplicate(map)),
    button('Delete', () => confirmDelete(row, map)),
  )

  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')

  row.append(info, actions, error)
  return row
}

// --- History (server/history.py) ------------------------------------------------

/** Opens or closes a map's earlier versions under its row. */
function toggleHistory(row, map, message = '') {
  const open = row.querySelector('.history')
  if (open) {
    open.remove()
    return
  }
  const panel = document.createElement('div')
  panel.className = 'history'
  panel.setAttribute('aria-label', `History of ${map.name}`)
  panel.textContent = 'Loading history…'
  row.querySelector('.error').before(panel)
  loadHistory(row, map, panel, message)
}

async function loadHistory(row, map, panel, message) {
  const result = await request(`api/maps/${encodeURIComponent(map.id)}/snapshots`)
  if (!result.ok) {
    panel.remove()
    return signedOutBy(result) || rowError(row, `Could not load the history: ${result.error}`)
  }
  const now = Date.now() / 1000
  const { snapshots, updated_at: updatedAt } = result.data

  const current = document.createElement('p')
  current.className = 'now'
  current.textContent = `Now: saved ${dateTime(updatedAt)} (${relativeTime(updatedAt, now)})`
  const head = [current]
  if (message) {
    const done = document.createElement('p')
    done.className = 'done'
    done.setAttribute('role', 'status')
    done.textContent = message
    head.unshift(done)
  }
  if (!snapshots.length) {
    const none = document.createElement('p')
    none.className = 'note'
    none.textContent =
      'No earlier versions yet. One is kept when you save more than an hour after the last, and before any restore.'
    panel.replaceChildren(...head, none)
    return
  }
  const list = document.createElement('ol')
  list.className = 'versions'
  list.append(...snapshots.map((snapshot) => versionRow(row, map, snapshot, now)))
  const note = document.createElement('p')
  note.className = 'note'
  note.textContent =
    'Kept: everything from the last hour, then one an hour for a day, then one a day for 30 days.'
  panel.replaceChildren(...head, list, note)
}

function versionRow(row, map, snapshot, now) {
  const item = document.createElement('li')
  item.className = 'version'
  item.dataset.id = String(snapshot.id)
  const info = document.createElement('div')
  info.className = 'info'
  const when = document.createElement('span')
  when.className = 'when'
  when.textContent = `${dateTime(snapshot.created_at)} (${relativeTime(snapshot.created_at, now)})`
  const meta = document.createElement('span')
  meta.className = 'meta'
  meta.textContent = versionSummary(snapshot)
  info.append(when, meta)
  const actions = document.createElement('div')
  actions.className = 'actions'
  const offer = () =>
    actions.replaceChildren(button('Restore', () => confirmRestore(row, map, snapshot, actions, offer)))
  offer()
  item.append(info, actions)
  return item
}

function confirmRestore(row, map, snapshot, actions, cancel) {
  const question = document.createElement('span')
  question.className = 'confirm'
  question.textContent = 'Make this the current version? The current one is kept here first.'
  const yes = button(
    'Restore',
    async () => {
      yes.disabled = true
      const result = await request(
        `api/maps/${encodeURIComponent(map.id)}/snapshots/${snapshot.id}/restore`,
        { method: 'POST' },
      )
      if (!result.ok) {
        yes.disabled = false
        return signedOutBy(result) || rowError(row, result.error)
      }
      await refreshList()
      // Stay on the history, which now also holds the version just replaced.
      const again = $('maps').querySelector(`.map[data-id="${CSS.escape(map.id)}"]`)
      const fresh = mapsById.get(map.id)
      if (again && fresh) {
        toggleHistory(again, fresh, `Restored the version from ${dateTime(snapshot.created_at)}.`)
      }
    },
    'danger small',
  )
  actions.replaceChildren(question, yes, button('Cancel', cancel))
  yes.focus()
}

// --- Download a map as a file -----------------------------------------------------

/** Opens or closes the "download as a file" form under a map's row. */
function toggleDownload(row, map) {
  const open = row.querySelector('.download')
  if (open) {
    open.remove()
    return
  }
  const form = document.createElement('form')
  form.className = 'download inline-form'
  form.noValidate = true
  const password = document.createElement('input')
  password.type = 'password'
  password.autocomplete = 'new-password'
  password.placeholder = 'Password (optional)'
  password.setAttribute('aria-label', 'Password for the file (optional)')
  const save = document.createElement('button')
  save.type = 'submit'
  save.className = 'small'
  save.textContent = `Download ${fileName(map.name)}`
  const note = document.createElement('p')
  note.className = 'note'
  note.textContent = 'With no password, anyone who has the file can open it.'
  const fields = document.createElement('div')
  fields.className = 'inline-form'
  fields.append(
    password,
    save,
    button('Cancel', () => form.remove()),
  )
  form.append(fields, note)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    rowError(row, '')
    await busy(form, () => download(row, map, password.value))
    if (!row.querySelector('.error').textContent) form.remove()
  })
  password.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') form.remove()
  })
  row.querySelector('.error').before(form)
  password.focus()
}

async function download(row, map, password) {
  const result = await request(`api/maps/${encodeURIComponent(map.id)}`)
  if (!result.ok) return signedOutBy(result) || rowError(row, `Could not download it: ${result.error}`)
  const file = await mapFileBlob(result.data.payload, password, { base: BASE })
  if (!file.ok) return rowError(row, `Could not download it: ${file.error}`)
  triggerDownload(file.blob, fileName(result.data.name))
}

function rowError(row, text) {
  row.querySelector('.error').textContent = text
}

function startRename(row, map) {
  const form = document.createElement('form')
  form.className = 'inline-form rename'
  const input = document.createElement('input')
  input.type = 'text'
  input.maxLength = 120
  input.value = map.name
  input.setAttribute('aria-label', 'Map name')
  const save = document.createElement('button')
  save.type = 'submit'
  save.textContent = 'Save'
  const cancel = button('Cancel', () => refreshList())
  form.append(input, save, cancel)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const name = input.value.trim()
    if (!name) return rowError(row, 'A map needs a name.')
    if (name === map.name) return refreshList()
    const result = await busy(form, () =>
      request(`api/maps/${encodeURIComponent(map.id)}`, { method: 'PATCH', body: { name } }),
    )
    if (!result.ok) return signedOutBy(result) || rowError(row, result.error)
    refreshList()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') refreshList()
  })
  row.querySelector('.info').replaceChildren(form)
  row.querySelector('.actions').replaceChildren()
  input.focus()
  input.select()
}

async function duplicate(map) {
  const result = await request(`api/maps/${encodeURIComponent(map.id)}/duplicate`, { method: 'POST' })
  if (!result.ok) {
    if (!signedOutBy(result)) setError('list-error', result.error)
    return
  }
  refreshList()
}

function confirmDelete(row, map) {
  const actions = row.querySelector('.actions')
  const question = document.createElement('span')
  question.className = 'confirm'
  question.textContent = "Delete it for good? This can't be undone."
  const yes = button(
    'Delete',
    async () => {
      yes.disabled = true
      const result = await request(`api/maps/${encodeURIComponent(map.id)}`, { method: 'DELETE' })
      if (!result.ok && result.status !== 404) {
        yes.disabled = false
        return signedOutBy(result) || rowError(row, result.error)
      }
      await backups.remove(map.id)
      refreshList()
    },
    'danger small',
  )
  actions.replaceChildren(
    question,
    yes,
    button('Cancel', () => refreshList()),
  )
  yes.focus()
}

$('new-map-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  setError('list-error', '')
  const name = $('new-map-name').value.trim()
  const result = await busy(form, () => request('api/maps', { method: 'POST', body: name ? { name } : {} }))
  if (!result.ok) {
    if (!signedOutBy(result)) setError('list-error', result.error)
    return
  }
  location.assign(appUrl(result.data.id))
})

// --- Upload a file into the list ----------------------------------------------------

// The file being uploaded while its password is asked for.
let pending = null

function listStatus(text) {
  $('list-status').textContent = text
  $('list-status').hidden = !text
}

function cancelUpload() {
  pending = null
  $('upload-form').hidden = true
  $('upload-password').value = ''
  setError('upload-error', '')
}

$('upload-input').accept = ACCEPT
$('upload-button').addEventListener('click', () => {
  $('upload-input').value = ''
  $('upload-input').click()
})

$('upload-input').addEventListener('change', async () => {
  const file = $('upload-input').files?.[0]
  if (!file) return
  cancelUpload()
  listStatus('')
  setError('list-error', '')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const probed = probe(bytes)
  if (!probed) return setError('list-error', `${file.name} isn't a Pleiades map file (.plm or .atlasmap).`)
  pending = { file, bytes, probed }
  if (!probed.needsPassword) return busy($('new-map-form'), () => upload(''))
  $('upload-what').textContent = `${file.name} has a password.`
  $('upload-form').hidden = false
  $('upload-password').focus()
})

$('upload-form').addEventListener('submit', (event) => {
  event.preventDefault()
  if (!pending) return
  const password = $('upload-password').value
  if (!password) return setError('upload-error', "Enter the file's password.")
  return busy(event.currentTarget, () => upload(password))
})

$('upload-cancel').addEventListener('click', cancelUpload)
$('upload-password').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancelUpload()
})

/** Reads the pending file here when possible, else has the server read it; adds it to the list. */
async function upload(password) {
  const { file, bytes, probed } = pending
  setError('upload-error', '')
  const name = nameFromFile(file.name)
  let result
  if (readsHere(probed)) {
    const read = await readMapFile(bytes, password)
    if (!read.ok) return uploadFailed(read.wrongPassword, read.error)
    result = await request('api/maps', {
      method: 'POST',
      body: { name: name || undefined, payload: read.payload },
    })
  } else {
    // No WebCrypto on this page (plain HTTP): the server decrypts it, as Open does here.
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('password', password)
    result = await request('api/maps/import', { method: 'POST', body: form })
    if (!result.ok && result.data?.wrong_password) {
      return uploadFailed(true, result.error)
    }
  }
  if (!result.ok) {
    if (signedOutBy(result)) return
    return uploadFailed(false, result.error)
  }
  cancelUpload()
  await refreshList()
  listStatus(`Uploaded ${file.name} as “${result.data.name}”.`)
}

function uploadFailed(wrongPassword, error) {
  if (wrongPassword && !$('upload-form').hidden) {
    $('upload-password').value = ''
    $('upload-password').focus()
    return setError('upload-error', error)
  }
  cancelUpload()
  setError('list-error', `Could not upload it: ${error}`)
}

// --- Start --------------------------------------------------------------------

async function start() {
  const result = await request('api/auth/me')
  if (!result.ok) {
    show('loading')
    $('loading').textContent = `Could not reach the server: ${result.error}. Reload to try again.`
    return
  }
  const me = result.data
  if (!me.enabled) {
    document.title = 'Pleiades'
    show('off')
    return
  }
  if (me.user?.must_change_password) showMustChange(me)
  else if (me.user) await showSignedIn(me)
  else showSignedOut(me)
}

for (const id of ['local-link', 'local-link-in', 'insecure-local', 'off-open']) $(id).href = appUrl()
$('home-link').href = homeUrl()
const reason = location.hash.slice(1)
// The homepage's "create an account" link.
let wantSignUp = reason === 'sign-up'
if (NOTICES[reason] || wantSignUp) {
  notice(NOTICES[reason] ?? '')
  // Once said is enough: a reload shouldn't say it again.
  history.replaceState(null, '', location.pathname + location.search)
}
start()

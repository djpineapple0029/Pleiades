/**
 * The account shell (USERS.md, "Frontend"): sign in or sign up, then the list
 * of your maps. Plain DOM, no WebGL: it loads fast and works where the scene
 * can't. Opening a map hands over to the app at `?map=<id>`.
 *
 * Every name the server sends is set as text, never as markup.
 */
import './shell.css'
import { BASE, appUrl, request } from '../api.js'
import { mapSummary } from './format.js'

const $ = (id) => document.getElementById(id)
const views = ['loading', 'off', 'signed-out', 'signed-in']

const NOTICES = {
  missing: "That map doesn't exist any more, or it belongs to another account.",
}

function show(view) {
  for (const id of views) $(id).hidden = id !== view
  $('who').hidden = view !== 'signed-in'
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

function showSignedOut(me) {
  signupOpen = Boolean(me.signup_open)
  $('tab-sign-up').hidden = !signupOpen
  $('sign-up-min').textContent = me.min_password_length ? `At least ${me.min_password_length} characters` : ''
  document.title = 'Sign in — AtlasMap'
  show('signed-out')
  selectTab('sign-in')
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
  start()
})

// --- Signed in ----------------------------------------------------------------

/** A 401 anywhere means the session is gone: back to the sign-in form. */
function signedOutBy(result) {
  if (result.status !== 401) return false
  notice('You were signed out. Sign in again.')
  start()
  return true
}

async function showSignedIn(me) {
  $('who-name').textContent = me.user.username
  document.title = 'My maps — AtlasMap'
  show('signed-in')
  await refreshList()
}

async function refreshList() {
  const result = await request('api/maps')
  if (!result.ok) {
    if (!signedOutBy(result)) setError('list-error', `Could not load your maps: ${result.error}`)
    return
  }
  setError('list-error', '')
  renderList(result.data.maps)
}

function renderList(maps) {
  const now = Date.now() / 1000
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
    document.title = 'AtlasMap'
    show('off')
    return
  }
  if (me.user) await showSignedIn(me)
  else showSignedOut(me)
}

for (const id of ['local-link', 'local-link-in']) $(id).href = appUrl()
$('off-open').href = BASE
const reason = location.hash.slice(1)
if (NOTICES[reason]) {
  notice(NOTICES[reason])
  // Once said is enough: a reload shouldn't say it again.
  history.replaceState(null, '', location.pathname + location.search)
}
start()

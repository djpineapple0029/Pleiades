/**
 * The homepage (home.html): what Pleiades is, then Get started (the app with
 * no account) or Sign in (the account shell). Plain `/` serves this page only
 * while signed out; Flask sends a signed-in visitor on to My maps.
 */
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import './home.css'
import { BASE, accountUrl, appUrl, homeUrl, request } from '../api.js'
import { APP_ROWS, renderKeyList } from '../keysHelp.js'
import { createKeymap } from '../keymap.js'
import { fetchSettings } from '../settings.js'
import { createGalaxy, drawStill } from './galaxy.js'

const $ = (id) => document.getElementById(id)

for (const id of ['get-started', 'get-started-foot']) $(id).href = appUrl()
document.querySelector('.wordmark').href = homeUrl()

const still = matchMedia('(prefers-reduced-motion: reduce)').matches
if (!createGalaxy($('galaxy'), { still })) {
  $('galaxy').hidden = true
  $('galaxy-still').hidden = false
  drawStill($('galaxy-still'))
}

/** Key caps in the copy and the full list, from this server's keybinds. */
async function showKeys() {
  const settings = await fetchSettings(`${BASE}api/config`)
  const keymap = createKeymap(settings.keybinds)
  for (const kbd of document.querySelectorAll('kbd[data-key]')) {
    const label = keymap.label(kbd.dataset.key)
    if (label) kbd.textContent = label
  }
  renderKeyList($('keys'), keymap, APP_ROWS)
}

async function showAccount() {
  const result = await request('api/auth/me')
  const me = result.ok ? result.data : null
  if (!me?.enabled) return
  if (me.user) {
    // Only reached like this in dev: Vite, not Flask, serves `/`.
    if (location.pathname === BASE && !location.search) {
      location.replace(accountUrl())
      return
    }
    $('sign-in').textContent = 'My maps'
  } else if (me.signup_open) {
    $('sign-up').hidden = false
  }
  $('sign-in').href = accountUrl()
  $('sign-up').href = accountUrl('sign-up')
  $('account').hidden = false
  $('way-account').hidden = false
}

showAccount()
showKeys()

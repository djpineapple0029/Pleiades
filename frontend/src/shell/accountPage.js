/**
 * Account (USERS.md decisions 16 and 20, server/account.py): download all my
 * data, change username or password, sign out other devices, delete the
 * account. The markup is static, in account.html; this wires it up.
 *
 * A wrong password answers 401 with `wrong_password`, which `onSignedOut`
 * leaves alone, so it's said beside the form instead of signing anyone out.
 */
import { BASE } from '../api.js'
import { triggerDownload } from '../files.js'
import { formatSize } from './format.js'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "You're also signed in on 2 other browsers or devices." */
export function sessionsText(others) {
  if (!others) return "You aren't signed in anywhere else."
  if (others === 1) return "You're also signed in on 1 other browser or device."
  return `You're also signed in on ${others} other browsers or devices.`
}

/** The zip's name from Content-Disposition, or a plain one. */
export function attachmentName(header, fallback) {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header ?? '')
  if (!match) return fallback
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * `request` is api.js's. `onSignedOut(result)` is the shell's 401/403
 * handler and returns true when it took over. `onUsername(name)` and
 * `onDeleted()` let the shell update its header or start over.
 */
export function createAccountPage({ request, onSignedOut, onUsername, onDeleted, fetchImpl }) {
  const $ = (id) => document.getElementById(id)
  let summary = null

  function say(id, text) {
    $(id).textContent = text ?? ''
  }

  function clearMessages() {
    for (const id of [
      'export-error',
      'username-error',
      'username-done',
      'password-error',
      'password-done',
      'sessions-error',
      'delete-error',
    ]) {
      say(id, '')
    }
  }

  async function busy(target, work) {
    const controls = [...target.querySelectorAll('input, button')]
    if (target instanceof HTMLButtonElement) controls.push(target)
    for (const control of controls) control.disabled = true
    try {
      return await work()
    } finally {
      for (const control of controls) control.disabled = false
      // Nobody else to sign out: the button stays off.
      $('sessions-button').disabled = !summary?.other_sessions
    }
  }

  function render() {
    const since = new Date(summary.created_at * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    say('account-since', `Signed in as ${summary.username}, here since ${since}.`)
    const limit = summary.max_maps ? ` (you can keep up to ${summary.max_maps})` : ''
    say(
      'account-usage',
      `${plural(summary.maps, 'map')}${limit}, ${formatSize(summary.map_bytes)} on this server.`,
    )
    for (const id of ['password-username', 'delete-username']) $(id).value = summary.username
    renderSessions()
  }

  function renderSessions() {
    if (!summary) return
    say('sessions-text', sessionsText(summary.other_sessions))
    $('sessions-button').disabled = !summary.other_sessions
  }

  async function refresh() {
    const result = await request('api/account')
    if (!result.ok) {
      if (!onSignedOut(result)) say('export-error', `Could not load your account: ${result.error}`)
      return false
    }
    summary = result.data
    render()
    return true
  }

  // --- Download all my data ---

  $('export-button').addEventListener('click', () =>
    busy($('export-button'), async () => {
      say('export-error', '')
      const doFetch = fetchImpl ?? globalThis.fetch
      let response
      try {
        response = await doFetch(`${BASE}api/account/export.zip`, {
          credentials: 'same-origin',
          cache: 'no-store',
        })
      } catch {
        return say('export-error', 'Could not reach the server.')
      }
      if (!response.ok) {
        let data = null
        try {
          data = await response.json()
        } catch {
          // Not JSON: a proxy answered.
        }
        const result = { ok: false, status: response.status, data, error: data?.error }
        if (onSignedOut(result)) return
        return say('export-error', data?.error || `The server returned ${response.status}.`)
      }
      const name = attachmentName(response.headers.get('Content-Disposition'), 'pleiades.zip')
      triggerDownload(await response.blob(), name)
    }),
  )

  // --- Username ---

  $('username-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.currentTarget
    clearMessages()
    const username = $('username-new').value.trim().toLowerCase()
    const password = $('username-password').value
    if (!username) return say('username-error', 'Enter the new username.')
    if (!password) return say('username-error', 'Enter your password to change it.')
    return busy(form, async () => {
      const result = await request('api/account/username', { method: 'POST', body: { username, password } })
      $('username-password').value = ''
      if (!result.ok) return onSignedOut(result) || say('username-error', result.error)
      $('username-new').value = ''
      summary = { ...summary, username: result.data.user.username }
      render()
      onUsername(summary.username)
      say('username-done', `Done. You sign in as ${summary.username} now.`)
    })
  })

  // --- Password ---

  $('password-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.currentTarget
    clearMessages()
    const current = $('password-current').value
    const next = $('password-new').value
    if (!current) return say('password-error', 'Enter your current password.')
    if (!next) return say('password-error', 'Enter a new password.')
    if (next !== $('password-confirm').value) {
      $('password-confirm').value = ''
      $('password-confirm').focus()
      return say('password-error', 'The new passwords do not match.')
    }
    return busy(form, async () => {
      const result = await request('api/account/password', { method: 'POST', body: { current, new: next } })
      $('password-current').value = ''
      if (!result.ok) return onSignedOut(result) || say('password-error', result.error)
      $('password-new').value = ''
      $('password-confirm').value = ''
      const others = summary?.other_sessions ?? 0
      summary = { ...summary, other_sessions: 0 }
      renderSessions()
      say(
        'password-done',
        others ? `Password changed. ${plural(others, 'other session')} signed out.` : 'Password changed.',
      )
    })
  })

  // --- Other devices ---

  $('sessions-button').addEventListener('click', () =>
    busy($('sessions-button'), async () => {
      clearMessages()
      const result = await request('api/account/sessions/revoke-others', { method: 'POST' })
      if (!result.ok) return onSignedOut(result) || say('sessions-error', result.error)
      summary = { ...summary, other_sessions: 0 }
      renderSessions()
      say('sessions-text', `Signed out ${plural(result.data.ended, 'other session')}. Only this one is left.`)
    }),
  )

  // --- Delete account ---

  $('delete-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.currentTarget
    clearMessages()
    const password = $('delete-password').value
    if (!password) return say('delete-error', 'Enter your password to delete the account.')
    return busy(form, async () => {
      const result = await request('api/account', { method: 'DELETE', body: { password } })
      $('delete-password').value = ''
      if (!result.ok) return onSignedOut(result) || say('delete-error', result.error)
      await onDeleted()
    })
  })

  return {
    async open() {
      clearMessages()
      return refresh()
    },
    /** The server's minimum, from `/api/auth/me`. */
    setMinPasswordLength(length) {
      $('password-min').textContent = length ? `At least ${length} characters` : ''
    },
    /** Drops everything typed: called when the page is left or the user signs out. */
    forget() {
      summary = null
      for (const id of [
        'username-new',
        'username-password',
        'password-current',
        'password-new',
        'password-confirm',
        'delete-password',
      ]) {
        $(id).value = ''
      }
    },
  }
}

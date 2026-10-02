/**
 * Sharing a map (context/MOONSHOT.md, "Share dialog"): the rules first, pure,
 * then the dialog. The server enforces all of it again (server/sharing.py);
 * these only decide what the dialog offers.
 */
import { personName } from '../room/authors.js'
import { dateTime } from './format.js'

const RANK = { viewer: 1, editor: 2, owner: 3 }
export const PERMS = ['balance', 'export', 'invite', 'history', 'chat']
const PERM_NAMES = {
  balance: 'Run Balance',
  export: 'Export and download',
  invite: 'Invite people and manage the link',
  history: 'View and restore history',
  chat: 'Chat and emotes',
}
const LINK_DAYS = [null, 1, 7, 30]

/** The roles you may give: never above your own, and none without Invite. */
export function inviteRoles(you) {
  if (!you.perms?.invite) return []
  return ['editor', 'viewer'].filter((role) => RANK[role] <= RANK[you.role])
}

/** The member list, each row saying what you may do to it. */
export function memberRows(sharing, you) {
  const owner = you.role === 'owner'
  return sharing.members.map((member) => ({
    ...member,
    canChangeRole: owner,
    canRemove: owner || member.user_id === you.user_id,
  }))
}

/**
 * The permissions table: each role's defaults, and each person's overrides
 * (true / false, or null for "the role's default"). Only the owner edits;
 * a viewer can never Balance (they can't edit at all).
 */
export function permissionGrid(sharing, you) {
  const owner = you.role === 'owner'
  const roles = ['editor', 'viewer'].map((role) => {
    const perms = {}
    for (const perm of PERMS) {
      const locked = role === 'viewer' && perm === 'balance'
      perms[perm] = {
        value: locked ? false : Boolean(sharing.role_defaults?.[role]?.[perm]),
        editable: owner && !locked,
      }
    }
    return { role, perms }
  })
  const people = sharing.members.map((member) => {
    const override = {}
    for (const perm of PERMS) {
      const value = member.perms_override?.[perm]
      override[perm] = typeof value === 'boolean' ? value : null
    }
    return {
      user_id: member.user_id,
      username: member.username,
      role: member.role,
      override,
      editable: owner,
    }
  })
  return { roles, people }
}

/** The share link as the dialog shows it, and what you may do to it. */
export function linkState(sharing, you) {
  const roles = inviteRoles(you)
  return {
    mode: sharing.link ? sharing.link.role : 'off',
    expires_at: sharing.link?.expires_at ?? null,
    canChange: roles.length > 0,
    roles,
  }
}

/** For "make a new link": the shortest allowed lifetime that still covers what's left. */
export function daysLeft(expiresAt, now = Date.now() / 1000) {
  if (expiresAt === null || expiresAt === undefined) return null
  const days = Math.max(0, expiresAt - now) / 86400
  return LINK_DAYS.find((d) => d !== null && d >= days) ?? 30
}

const ROLE_NAMES = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' }

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function smallButton(label, onClick, className = 'quiet small') {
  const node = el('button', className, label)
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

/**
 * Sharing, under a map's row in My maps: the people it's shared with (role,
 * Remove, Leave; per-person permissions for the owner), the role defaults
 * (owner), the share link, who's in the map now (Kick, ban for the owner) and
 * who's banned. `onSignedOut(result)` is the shell's usual 401 handling;
 * `onLeft()` runs once you've removed yourself. Names only ever go in as
 * text (Review Focus 4).
 */
export function createSharePanel({
  request,
  mapId,
  mapName,
  onSignedOut = () => false,
  onLeft = () => {},
  origin = globalThis.location?.origin ?? '',
  copy = (text) => globalThis.navigator?.clipboard?.writeText(text),
}) {
  const panel = el('div', 'sharing')
  panel.setAttribute('aria-label', `Sharing of ${mapName}`)
  const error = el('p', 'error')
  error.setAttribute('role', 'alert')
  const url = (suffix = '') => `api/maps/${encodeURIComponent(mapId)}${suffix}`
  // Which person's permissions are open, kept across reloads of the panel.
  let openPerms = null
  // A link's URL is only returned when it's made: shown while this panel is open.
  let freshLink = null

  function fail(result, what) {
    if (onSignedOut(result)) return
    error.textContent = `${what}: ${result.error}`
  }

  async function load() {
    if (!panel.childElementCount)
      panel.replaceChildren(el('p', 'note', 'Loading who it’s shared with…'), error)
    const result = await request(url('/sharing'))
    if (!result.ok) return fail(result, 'Could not load who it’s shared with')
    render(result.data)
  }

  async function send(path, init, what) {
    const result = await request(url(path), init)
    if (!result.ok) {
      fail(result, what)
      return null
    }
    return result
  }

  function render(sharing) {
    const you = sharing.you
    const grid = permissionGrid(sharing, you)
    const parts = [heading('People'), peopleList(sharing, you, grid)]
    const roles = inviteRoles(you)
    if (roles.length) parts.push(addForm(roles))
    else parts.push(el('p', 'note', 'Only people who can invite add others to this map.'))
    if (you.role === 'owner') parts.push(heading('Role defaults'), roleDefaults(grid))
    parts.push(heading('Link'), linkSection(sharing, you))
    if (sharing.online?.length) parts.push(heading('In this map now'), onlineList(sharing, you))
    if (you.role === 'owner' && sharing.bans?.length) parts.push(heading('Banned'), banList(sharing.bans))
    error.textContent = ''
    panel.replaceChildren(...parts, error)
  }

  function heading(text) {
    return el('h3', 'sharing-heading', text)
  }

  // --- People ----------------------------------------------------------------

  function peopleList(sharing, you, grid) {
    const list = el('ul', 'members')
    const owner = el('li', 'member')
    const ownerName = you.role === 'owner' ? `${sharing.owner.username} (you)` : sharing.owner.username
    owner.append(el('span', 'who', ownerName), el('span', 'role', ROLE_NAMES.owner))
    list.append(owner)
    for (const row of memberRows(sharing, you)) {
      const person = grid.people.find((p) => p.user_id === row.user_id)
      list.append(memberRow(row, you, person))
      if (person?.editable && openPerms === row.user_id) list.append(overrideRow(person, sharing))
    }
    return list
  }

  function memberRow(row, you, person) {
    const item = el('li', 'member')
    const yours = row.user_id === you.user_id
    item.append(el('span', 'who', yours ? `${row.username} (you)` : row.username))
    if (row.canChangeRole) {
      const select = el('select', 'role')
      select.setAttribute('aria-label', `Role of ${row.username}`)
      for (const role of ['editor', 'viewer']) {
        const option = el('option', '', ROLE_NAMES[role])
        option.value = role
        option.selected = role === row.role
        select.append(option)
      }
      select.addEventListener('change', async () => {
        select.disabled = true
        if (
          await send(
            `/members/${row.user_id}`,
            { method: 'PATCH', body: { role: select.value } },
            'Could not change the role',
          )
        )
          load()
      })
      item.append(select)
    } else {
      item.append(el('span', 'role', ROLE_NAMES[row.role] ?? row.role))
    }
    if (person?.editable) {
      const open = openPerms === row.user_id
      const toggle = smallButton(open ? 'Hide permissions' : 'Permissions…', () => {
        openPerms = open ? null : row.user_id
        load()
      })
      toggle.setAttribute('aria-expanded', String(open))
      item.append(toggle)
    }
    if (row.canRemove) {
      item.append(
        smallButton(yours ? 'Leave' : 'Remove', async (event) => {
          event.currentTarget.disabled = true
          const done = await send(
            `/members/${row.user_id}`,
            { method: 'DELETE' },
            yours ? 'Could not leave' : 'Could not remove them',
          )
          if (!done) return
          if (yours) onLeft()
          else load()
        }),
      )
    }
    return item
  }

  /** One person's permissions: each the role's default, or on, or off for them. */
  function overrideRow(person, sharing) {
    const item = el('li', 'member perms')
    item.setAttribute('aria-label', `Permissions of ${person.username}`)
    const table = el('div', 'perm-grid')
    for (const perm of PERMS) {
      if (person.role === 'viewer' && perm === 'balance') continue
      const fallback = sharing.role_defaults?.[person.role]?.[perm] ? 'on' : 'off'
      const select = el('select')
      select.setAttribute('aria-label', `${PERM_NAMES[perm]} for ${person.username}`)
      for (const [value, label] of [
        ['default', `Role default (${fallback})`],
        ['on', 'On'],
        ['off', 'Off'],
      ]) {
        const option = el('option', '', label)
        option.value = value
        select.append(option)
      }
      const current = person.override[perm]
      select.value = current === null ? 'default' : current ? 'on' : 'off'
      select.addEventListener('change', async () => {
        select.disabled = true
        const override = {
          ...person.override,
          [perm]: select.value === 'default' ? null : select.value === 'on',
        }
        const set = Object.fromEntries(Object.entries(override).filter(([, value]) => value !== null))
        const body = { perms: Object.keys(set).length ? set : null }
        if (
          await send(
            `/members/${person.user_id}`,
            { method: 'PATCH', body },
            'Could not change their permissions',
          )
        )
          load()
      })
      table.append(el('span', 'perm-name', PERM_NAMES[perm]), select)
    }
    item.append(table)
    return item
  }

  function addForm(roles) {
    const form = el('form', 'inline-form add')
    form.noValidate = true
    const name = el('input')
    name.type = 'text'
    name.placeholder = 'Username'
    name.autocomplete = 'off'
    name.setAttribute('aria-label', 'Username to share with')
    const role = roleSelect(roles, 'Their role')
    const add = el('button', 'small', 'Share')
    add.type = 'submit'
    form.append(name, role, add)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const username = name.value.trim()
      if (!username) {
        error.textContent = 'Type the username of the account to share with.'
        return
      }
      add.disabled = true
      const done = await send(
        '/members',
        { method: 'POST', body: { username, role: role.value } },
        'Not shared',
      )
      add.disabled = false
      if (done) load()
    })
    return form
  }

  function roleSelect(roles, label) {
    const select = el('select')
    select.setAttribute('aria-label', label)
    for (const value of roles) {
      const option = el('option', '', ROLE_NAMES[value])
      option.value = value
      select.append(option)
    }
    return select
  }

  // --- Role defaults (owner) -----------------------------------------------------

  function roleDefaults(grid) {
    const table = el('div', 'perm-grid perm-table')
    table.append(
      el('span', 'perm-name'),
      el('span', 'perm-head', 'Editors'),
      el('span', 'perm-head', 'Viewers'),
    )
    for (const perm of PERMS) {
      table.append(el('span', 'perm-name', PERM_NAMES[perm]))
      for (const { role, perms } of grid.roles) {
        const box = el('input')
        box.type = 'checkbox'
        box.checked = perms[perm].value
        box.disabled = !perms[perm].editable
        box.setAttribute('aria-label', `${PERM_NAMES[perm]} for ${role}s`)
        box.addEventListener('change', async () => {
          box.disabled = true
          const values = Object.fromEntries(PERMS.map((p) => [p, perms[p].value]))
          values[perm] = box.checked
          if (
            await send(
              `/roles/${role}`,
              { method: 'PUT', body: { perms: values } },
              'Could not change the default',
            )
          )
            load()
        })
        table.append(box)
      }
    }
    const wrap = el('div', 'role-defaults')
    wrap.append(
      table,
      el(
        'p',
        'note',
        'What each role may do here, unless a person has their own setting. Balance and in-app export hide the buttons; they don’t stop someone copying what they can see.',
      ),
    )
    return wrap
  }

  // --- The share link --------------------------------------------------------------

  function linkSection(sharing, you) {
    const state = linkState(sharing, you)
    const wrap = el('div', 'link')
    const says =
      state.mode === 'off'
        ? 'Off: only the people above can open this map.'
        : `Anyone with the link can ${state.mode === 'editor' ? 'edit' : 'view'}${state.expires_at ? ` until ${dateTime(state.expires_at)}` : ''}.`
    wrap.append(el('p', 'link-state', says))
    if (freshLink) wrap.append(linkCopy(freshLink))
    if (!state.canChange) {
      if (state.mode !== 'off') wrap.append(el('p', 'note', 'Ask someone who can invite for the link.'))
      return wrap
    }
    const form = el('form', 'inline-form link-form')
    form.noValidate = true
    const role = el('select')
    role.setAttribute('aria-label', 'Anyone with the link can')
    for (const value of state.roles) {
      const option = el(
        'option',
        '',
        value === 'editor' ? 'Anyone with the link can edit' : 'Anyone with the link can view',
      )
      option.value = value
      option.selected = value === (state.mode === 'off' ? 'viewer' : state.mode)
      role.append(option)
    }
    const days = el('select')
    days.setAttribute('aria-label', 'Link expires')
    for (const value of LINK_DAYS) {
      const option = el(
        'option',
        '',
        value === null ? 'Never expires' : `Expires in ${value} day${value === 1 ? '' : 's'}`,
      )
      option.value = value === null ? '' : String(value)
      days.append(option)
    }
    const make = el('button', 'small', state.mode === 'off' ? 'Make link' : 'New link')
    make.type = 'submit'
    form.append(role, days, make)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      make.disabled = true
      await makeLink(role.value, days.value ? Number(days.value) : null)
      make.disabled = false
    })
    wrap.append(form)
    if (state.mode !== 'off') {
      wrap.append(
        el(
          'p',
          'note',
          'The link is shown once, when it’s made. New link makes a fresh one; the old one stops working at once, and anyone in on it is sent out.',
        ),
        smallButton('Turn off', async (event) => {
          event.currentTarget.disabled = true
          freshLink = null
          if (await send('/link', { method: 'DELETE' }, 'Could not turn the link off')) load()
        }),
      )
    }
    return wrap
  }

  async function makeLink(role, expiresInDays) {
    const result = await send(
      '/link',
      { method: 'POST', body: { role, expires_in_days: expiresInDays } },
      'No link made',
    )
    if (!result) return false
    freshLink = new URL(result.data.url, origin || 'http://localhost').href
    load()
    return true
  }

  function linkCopy(href) {
    const row = el('div', 'inline-form link-copy')
    const field = el('input')
    field.type = 'text'
    field.readOnly = true
    field.value = href
    field.setAttribute('aria-label', 'Share link')
    field.addEventListener('focus', () => field.select())
    const button = smallButton('Copy link', async () => {
      try {
        await copy(href)
        button.textContent = 'Copied'
      } catch {
        field.select()
      }
    })
    row.append(field, button)
    return row
  }

  // --- Who's in the map now, and bans (owner) ------------------------------------------

  function onlineList(sharing, you) {
    const owner = you.role === 'owner'
    const list = el('ul', 'members online')
    for (const person of sharing.online) {
      const item = el('li', 'member')
      const dot = el('span', 'dot')
      dot.style.background = person.colour
      item.append(
        dot,
        el('span', 'who', personName(person)),
        el('span', 'role', ROLE_NAMES[person.role] ?? person.role),
      )
      if (owner && person.role !== 'owner') {
        item.append(
          smallButton('Kick', () => kick(person, false)),
          smallButton('Kick and ban', () => kick(person, true), 'danger small'),
        )
        if (person.guest && sharing.link) {
          item.append(
            smallButton(
              'Kick, ban and make a new link',
              () => kick(person, true, sharing.link),
              'danger small',
            ),
          )
        }
      }
      list.append(item)
    }
    const parts = el('div', 'in-now')
    parts.append(list)
    if (owner && sharing.online.some((person) => person.guest)) {
      parts.append(
        el(
          'p',
          'note',
          'A guest’s ban holds for the browser tab they joined in. While the link works they could come back in a new one: make a new link to stop that.',
        ),
      )
    }
    return parts
  }

  async function kick(person, ban, link = null) {
    const done = await send(
      '/kick',
      { method: 'POST', body: { conn: person.conn, ban } },
      `Could not send ${person.name} out`,
    )
    if (!done) return
    if (link) await makeLink(link.role, daysLeft(link.expires_at))
    else load()
  }

  function banList(bans) {
    const list = el('ul', 'members bans')
    for (const ban of bans) {
      const item = el('li', 'member')
      item.append(
        el('span', 'who', ban.guest ? `${ban.name} (guest)` : ban.name),
        el('span', 'role', dateTime(ban.banned_at)),
      )
      item.append(
        smallButton('Unban', async (event) => {
          event.currentTarget.disabled = true
          if (await send(`/bans/${ban.id}`, { method: 'DELETE' }, 'Could not unban')) load()
        }),
      )
      list.append(item)
    }
    return list
  }

  return { element: panel, load }
}

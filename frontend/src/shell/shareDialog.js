/**
 * Sharing a map by username (context/MOONSHOT.md, milestone 1): the rules
 * first, pure, then the dialog. The server enforces all of it again
 * (server/sharing.py); these only decide what the dialog offers.
 */
const RANK = { viewer: 1, editor: 2, owner: 3 }

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
 * Who a map is shared with, under its row in My maps: the members (role and
 * Remove for the owner, Leave for yourself) and a username + role to add.
 * `onSignedOut(result)` is the shell's usual 401 handling; `onLeft()` runs
 * once you've removed yourself. Names only ever go in as text.
 */
export function createSharePanel({ request, mapId, mapName, onSignedOut = () => false, onLeft = () => {} }) {
  const panel = el('div', 'sharing')
  panel.setAttribute('aria-label', `Sharing of ${mapName}`)
  const error = el('p', 'error')
  error.setAttribute('role', 'alert')
  const url = (suffix = '') => `api/maps/${encodeURIComponent(mapId)}${suffix}`

  function fail(result, what) {
    if (onSignedOut(result)) return
    error.textContent = `${what}: ${result.error}`
  }

  async function load() {
    panel.replaceChildren(el('p', 'note', 'Loading who it’s shared with…'), error)
    const result = await request(url('/sharing'))
    if (!result.ok) return fail(result, 'Could not load who it’s shared with')
    render(result.data)
  }

  function render(sharing) {
    const you = sharing.you
    const list = el('ul', 'members')
    const owner = el('li', 'member')
    const ownerName = you.role === 'owner' ? `${sharing.owner.username} (you)` : sharing.owner.username
    owner.append(el('span', 'who', ownerName), el('span', 'role', ROLE_NAMES.owner))
    list.append(owner)
    for (const row of memberRows(sharing, you)) list.append(memberRow(row, you))

    const parts = [list]
    const roles = inviteRoles(you)
    if (roles.length) parts.push(addForm(roles))
    else parts.push(el('p', 'note', 'Only people who can invite add others to this map.'))
    error.textContent = ''
    panel.replaceChildren(...parts, error)
  }

  function memberRow(row, you) {
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
        const result = await request(url(`/members/${row.user_id}`), {
          method: 'PATCH',
          body: { role: select.value },
        })
        if (!result.ok) return fail(result, 'Could not change the role')
        load()
      })
      item.append(select)
    } else {
      item.append(el('span', 'role', ROLE_NAMES[row.role] ?? row.role))
    }
    if (row.canRemove) {
      item.append(
        smallButton(yours ? 'Leave' : 'Remove', async (event) => {
          event.currentTarget.disabled = true
          const result = await request(url(`/members/${row.user_id}`), { method: 'DELETE' })
          if (!result.ok) return fail(result, yours ? 'Could not leave' : 'Could not remove them')
          if (yours) onLeft()
          else load()
        }),
      )
    }
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
    const role = el('select')
    role.setAttribute('aria-label', 'Their role')
    for (const value of roles) {
      const option = el('option', '', ROLE_NAMES[value])
      option.value = value
      role.append(option)
    }
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
      const result = await request(url('/members'), { method: 'POST', body: { username, role: role.value } })
      add.disabled = false
      if (!result.ok) return fail(result, 'Not shared')
      load()
    })
    return form
  }

  return { element: panel, load }
}

/**
 * The room panel on the Esc screen (context/MOONSHOT.md, "Esc menu"): who's
 * in the map, the chat log and a line to type into, beside the slim "Click
 * to fly", which stays the main thing. Everything people typed (names, chat)
 * is set as text, never markup (Review Focus 4).
 */
import { personName } from './authors.js'
import { CHAT_MAX, chatLine } from './chat.js'

/** The people list: you first, then the room's order. Pure. */
export function panelPeople(roster, you) {
  const people = (roster ?? []).map((person) => ({
    conn: person.conn,
    name: personName(person),
    colour: person.colour,
    role: person.role,
    you: Boolean(you) && person.conn === you.conn,
    clientIds: person.clientIds ?? [],
  }))
  return [...people.filter((p) => p.you), ...people.filter((p) => !p.you)]
}

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function createRoomPanel(element, { onSend = () => {}, onFollow = null } = {}) {
  const people = el('ul', 'room-people')
  const log = el('div', 'room-chat-log')
  log.setAttribute('role', 'log')
  log.setAttribute('aria-label', 'Chat')
  const form = el('form', 'room-chat-form')
  const field = el('input')
  field.type = 'text'
  field.maxLength = CHAT_MAX
  field.placeholder = 'Say something to everyone here'
  field.setAttribute('aria-label', 'Chat message')
  form.append(field)
  const chatOff = el('p', 'room-note', 'Chat is off for you on this map')
  chatOff.hidden = true
  element.replaceChildren(
    el('h2', 'room-heading', 'In this map'),
    people,
    el('h2', 'room-heading', 'Chat'),
    log,
    form,
    chatOff,
  )

  // Its keys are its own: Enter here sends rather than taking the pointer
  // back, ? is a question mark, Tab doesn't switch to the overview.
  field.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      if (field.value.trim()) onSend(field.value)
      field.value = ''
    } else if (event.key === 'Escape') field.blur()
  })
  field.addEventListener('keyup', (event) => event.stopPropagation())
  form.addEventListener('submit', (event) => event.preventDefault())

  function renderPeople(roster, you) {
    people.replaceChildren(
      ...panelPeople(roster, you).map((person) => {
        const row = el('li', 'room-person')
        const dot = el('span', 'room-dot')
        dot.style.background = person.colour
        const name = el('span', 'room-name', person.you ? `${person.name} (you)` : person.name)
        name.style.color = person.colour
        row.append(dot, name, el('span', 'room-role', person.role))
        if (onFollow && !person.you) {
          const button = el('button', 'room-follow', 'Follow')
          button.type = 'button'
          button.setAttribute('aria-label', `Follow ${person.name}`)
          button.addEventListener('click', () => onFollow(person))
          row.append(button)
        }
        return row
      }),
    )
  }

  function renderChat(messages) {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8
    log.replaceChildren(...messages.map((message) => chatLine(message, personName)))
    log.hidden = messages.length === 0
    if (atBottom) log.scrollTop = log.scrollHeight
  }

  function setCanChat(allowed) {
    form.hidden = !allowed
    chatOff.hidden = allowed
  }

  return { renderPeople, renderChat, setCanChat, element }
}

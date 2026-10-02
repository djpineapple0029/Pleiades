/**
 * Chat in a live map (context/MOONSHOT.md decision 16): Y opens a line to
 * type into, Enter sends it to everyone in the map, Esc closes it. The room
 * sends every message back to everyone, the sender too, so all logs are in
 * the room's order. Nothing is saved: the log is this tab's, from when it
 * joined.
 *
 * A message shows three ways: over the sender's avatar for a few seconds
 * (avatars.say), in a short feed over the HUD that fades, and in the Esc
 * screen's room panel (roomPanel.js). Every one of them is text, never
 * markup (Review Focus 4).
 */

/** The longest message, in characters, the room passes on (rooms.py CHAT_MAX). */
export const CHAT_MAX = 500
const FEED_WINDOW_MS = 8000
const FEED_LINES = 4

/** The last `limit` messages, in the order they arrived. Pure. */
export function createChatLog({ limit = 100 } = {}) {
  const messages = []
  const listeners = []
  return {
    add(message) {
      messages.push(message)
      if (messages.length > limit) messages.splice(0, messages.length - limit)
      for (const listener of listeners) listener(message)
    },
    onAdd(listener) {
      listeners.push(listener)
    },
    get messages() {
      return messages.slice()
    },
  }
}

/** A roster person's Yjs client ids (their avatars), by connection. Pure. */
export function clientIdsOf(conn, roster) {
  return roster?.find((person) => person.conn === conn)?.clientIds ?? []
}

/** The feed's lines: younger than `window` ms, newest last, at most `max`. Pure. */
export function recentLines(messages, { now, window = FEED_WINDOW_MS, max = FEED_LINES, arrivedAt }) {
  return messages.filter((message) => now - arrivedAt(message) < window).slice(-max)
}

/** One line of chat as DOM: the name in its colour, then the text. */
export function chatLine(message, personName) {
  const line = document.createElement('p')
  line.className = 'chat-line'
  const who = document.createElement('span')
  who.className = 'chat-name'
  who.textContent = personName(message)
  who.style.color = message.colour
  const text = document.createElement('span')
  text.className = 'chat-text'
  text.textContent = message.text
  line.append(who, text)
  return line
}

/**
 * The live part: what comes in goes to the log, the feed and the sender's
 * avatar; `prompt()` shows the input (Y) and resolves when it closes.
 *
 * `feed` is the element over the HUD; `input` the form with one text field.
 */
export function createChat({ room, log, feed, form, avatars, personName, now = () => performance.now() }) {
  const field = form.querySelector('input')
  field.maxLength = CHAT_MAX
  const arrived = new WeakMap()
  let fadeTimer = null

  function receive(message) {
    if (typeof message?.text !== 'string') return
    arrived.set(message, now())
    log.add(message)
    if (message.conn !== room.you?.conn) avatars?.say(clientIdsOf(message.conn, room.roster), message.text)
    renderFeed()
  }

  function renderFeed() {
    const lines = recentLines(log.messages, { now: now(), arrivedAt: (m) => arrived.get(m) ?? -Infinity })
    feed.replaceChildren(...lines.map((message) => chatLine(message, personName)))
    feed.hidden = lines.length === 0 && form.hidden
    clearTimeout(fadeTimer)
    if (lines.length) fadeTimer = setTimeout(renderFeed, 1000)
  }

  /** Sends a line; false if there was nothing to send. */
  function send(text) {
    const trimmed = text.trim()
    if (!trimmed) return false
    room.send({ type: 'chat', text: trimmed.slice(0, CHAT_MAX) })
    return true
  }

  // The field keeps its keys: Enter here must not also take the pointer
  // back, W must not fly, ? must not open the key list.
  let close = null
  field.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      send(field.value)
      close?.()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close?.()
    }
  })
  field.addEventListener('keyup', (event) => event.stopPropagation())
  form.addEventListener('submit', (event) => event.preventDefault())
  // Clicking away closes it, like Esc.
  field.addEventListener('blur', () => close?.())

  /** Y: the input, until Enter or Esc. */
  function prompt() {
    if (close) return Promise.resolve()
    return new Promise((resolve) => {
      form.hidden = false
      feed.hidden = false
      field.value = ''
      field.focus()
      close = () => {
        close = null
        form.hidden = true
        field.blur()
        renderFeed()
        resolve()
      }
    })
  }

  return {
    receive,
    send,
    prompt,
    get isOpen() {
      return close !== null
    },
  }
}

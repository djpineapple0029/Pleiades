/**
 * Emotes in a live map (context/MOONSHOT.md decision 16): hold G, point at
 * one of eight, let go. It shows over your ship for everyone else, and in
 * your own corner for you, for two seconds. One a second: the room drops
 * anything sooner, and the ring here waits too, so it never seems broken.
 */

/** The same list, in the same order, as rooms.py's EMOTE_IDS. */
export const EMOTES = ['wave', 'yes', 'no', 'look', 'idea', 'laugh', 'heart', 'question']
const GLYPHS = {
  wave: '👋',
  yes: '👍',
  no: '👎',
  look: '👀',
  idea: '💡',
  laugh: '😂',
  heart: '❤️',
  question: '❓',
}
export const EMOTE_MS = 2000
export const EMOTE_COOLDOWN_MS = 1000

export function glyphOf(id) {
  return Object.hasOwn(GLYPHS, id) ? GLYPHS[id] : null
}

/** The ring's wedges: the glyph alone, eight round the wheel. */
export const EMOTE_MENU = EMOTES.map((id) => ({ key: id, label: glyphOf(id) }))

/** `(now) => true` at most once per `ms`. Pure. */
export function createCooldown(ms = EMOTE_COOLDOWN_MS) {
  let last = -Infinity
  return (now) => {
    if (now - last < ms) return false
    last = now
    return true
  }
}

/**
 * The live part. `send(id)` goes to the room if the cooldown allows;
 * `receive(message)` shows one over the sender's avatar, or in `corner`
 * when it's yours.
 */
export function createEmotes({ room, avatars, corner, now = () => performance.now() }) {
  const ready = createCooldown()
  let cornerTimer = null

  function send(id) {
    if (!glyphOf(id) || !ready(now())) return false
    room.send({ type: 'emote', id })
    return true
  }

  function receive(message) {
    const glyph = glyphOf(message?.id)
    if (!glyph) return
    if (message.conn === room.you?.conn) {
      corner.textContent = glyph
      corner.hidden = true
      void corner.offsetWidth // a fresh animation, even mid-way through the last one
      corner.hidden = false
      clearTimeout(cornerTimer)
      cornerTimer = setTimeout(() => (corner.hidden = true), EMOTE_MS)
      return
    }
    const person = room.roster.find((p) => p.conn === message.conn)
    avatars?.emote(person?.clientIds ?? [], glyph)
  }

  return { send, receive }
}

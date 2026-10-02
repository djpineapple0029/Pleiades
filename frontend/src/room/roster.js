/**
 * Who else is in the map (context/MOONSHOT.md decision 17): a coloured
 * initial per person, top right, outside the quiet HUD. Click one to fly to
 * them. Joining and leaving show only as bubbles coming and going. Names are
 * only ever set as text (Review Focus 4).
 */

/** The bubbles to draw: everyone but you, in the room's order. Pure. */
export function rosterEntries(people, you) {
  return people
    .filter((person) => person.conn !== you?.conn)
    .map((person) => ({
      conn: person.conn,
      initial: ([...(person.name ?? '').trim()][0] ?? '?').toUpperCase(),
      colour: person.colour,
      title: `${person.name} · ${person.role}`,
      clientIds: person.clientIds ?? [],
    }))
}

export function createRoster(element, { onFly = () => {} } = {}) {
  function render(people, you) {
    const entries = rosterEntries(people, you)
    element.replaceChildren(
      ...entries.map((entry) => {
        const bubble = document.createElement('button')
        bubble.type = 'button'
        bubble.className = 'roster-bubble'
        bubble.textContent = entry.initial
        bubble.title = entry.title
        bubble.setAttribute('aria-label', `Fly to ${entry.title}`)
        bubble.style.setProperty('--person', entry.colour)
        bubble.addEventListener('click', () => onFly(entry))
        return bubble
      }),
    )
    element.hidden = entries.length === 0
  }

  return { render }
}

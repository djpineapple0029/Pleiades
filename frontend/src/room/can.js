/**
 * What this person may do in the map they're in (context/MOONSHOT.md,
 * "Permissions"). Local files: everything. Server maps: what the room last
 * said — `room.you` is replaced on every `access` message, so this reads
 * the live answer. Balance and the in-app Export are UI permissions only (an
 * editor can move every star by hand; anyone who sees a map can copy it);
 * the server enforces the rest.
 */
const DENIED = {
  balance: 'Balance is off for you on this map',
  export: 'Saving and exporting are off for you on this map',
  history: 'History is off for you on this map',
  invite: 'Sharing is off for you on this map',
  chat: 'Chat is off for you on this map',
}

export function can(room, perm) {
  if (!room) return true
  if (perm === 'edit') return Boolean(room.canEdit)
  return room.you?.perms?.[perm] === true
}

export function denyText(perm) {
  return DENIED[perm] ?? 'That is off for you on this map'
}

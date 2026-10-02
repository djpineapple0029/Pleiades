/**
 * Everyone else in the map, drawn where they are (context/MOONSHOT.md
 * decision 14). Milestone 1 has one style for every Look: a small cone in
 * the person's colour pointing where they look, with their name over it.
 *
 * What people say in chat floats over them for a few seconds (`say`).
 *
 * Poses come in through `push` (awareness, ~10 Hz) and are drawn smoothly a
 * moment in the past (room/presence.js). The cones are one instanced mesh —
 * no draw call per person — on the layer that never blooms, and nothing here
 * is in graphView's raycast, so the crosshair never picks a person.
 */
import * as THREE from 'three'
import { LABEL_LAYER } from '../bloom.js'
import { createPoseBuffer } from './presence.js'

const MAX_PEOPLE = 16
// Names fade out past this distance; the cone stays.
const NAME_RANGE = 900
const NAME_HEIGHT = 2.2 // world units over the cone's centre
const NAME_SCALE = 0.06 // world units per canvas pixel

const FONT = '600 28px system-ui, sans-serif'
const LINE_HEIGHT = 36
const MAX_WIDTH = 480 // canvas pixels
const SAY_MS = 5000 // how long a chat message floats over its sender
const SAY_LINES = 3

/** `text` broken into at most `SAY_LINES` lines that fit `MAX_WIDTH`; the last one ends in … if cut. */
function wrap(context, text, maxWidth) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (context.measureText(next).width <= maxWidth || !line) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  if (lines.length > SAY_LINES) {
    lines.length = SAY_LINES
    lines[SAY_LINES - 1] += '…'
  }
  return lines
}

/**
 * Text drawn onto a canvas and shown as a sprite that always faces the
 * camera: names, and what people say. Canvas text is only ever text.
 */
function textSprite(lines, colour, { backdrop = false } = {}) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  context.font = FONT
  const textWidth = Math.max(...lines.map((line) => Math.min(context.measureText(line).width, MAX_WIDTH)))
  const width = Math.ceil(textWidth) + (backdrop ? 32 : 16)
  const height = lines.length * LINE_HEIGHT + 4
  canvas.width = width
  canvas.height = height
  if (backdrop) {
    context.fillStyle = 'rgba(0, 0, 0, 0.6)'
    context.beginPath()
    context.roundRect(0, 0, width, height, 12)
    context.fill()
  }
  context.font = FONT
  context.textBaseline = 'middle'
  context.fillStyle = colour
  lines.forEach((line, i) =>
    context.fillText(line, backdrop ? 16 : 8, 2 + LINE_HEIGHT * (i + 0.5), MAX_WIDTH),
  )
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }),
  )
  sprite.scale.set(width * NAME_SCALE, height * NAME_SCALE, 1)
  sprite.layers.set(LABEL_LAYER)
  sprite.renderOrder = 3
  return sprite
}

const nameSprite = (name, colour) => textSprite([name], colour)

function sayingSprite(text, colour) {
  const context = document.createElement('canvas').getContext('2d')
  context.font = FONT
  return textSprite(wrap(context, text, MAX_WIDTH), colour, { backdrop: true })
}

function disposeSprite(scene, sprite) {
  if (!sprite) return
  scene.remove(sprite)
  sprite.material.map.dispose()
  sprite.material.dispose()
}

export function createAvatars({ scene, size = 2 }) {
  const geometry = new THREE.ConeGeometry(1.2 * size, 3.5 * size, 12)
  geometry.rotateX(-Math.PI / 2) // the tip along -Z: a camera's forward
  const material = new THREE.MeshBasicMaterial({ depthWrite: false })
  const mesh = new THREE.InstancedMesh(geometry, material, MAX_PEOPLE)
  mesh.count = 0
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  scene.add(mesh)

  const people = new Map() // clientId -> { name, colour, role, buffer, sprite, shown }
  const visible = { editors: true, viewers: true }
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3(1, 1, 1)
  const hidden = new THREE.Vector3(0, 0, 0)
  const colour = new THREE.Color()

  /** Who's in the room: `[{ clientId, name, colour, role }]`, others only. */
  function sync(list) {
    const wanted = new Map(list.map((person) => [person.clientId, person]))
    for (const [clientId, person] of people) {
      if (wanted.has(clientId)) continue
      disposeSprite(scene, person.sprite)
      disposeSprite(scene, person.saying?.sprite)
      people.delete(clientId)
    }
    for (const [clientId, info] of wanted) {
      const known = people.get(clientId)
      if (known && known.name === info.name && known.colour === info.colour) {
        known.role = info.role
        continue
      }
      if (known) disposeSprite(scene, known.sprite)
      const sprite = nameSprite(info.name, info.colour)
      sprite.visible = false
      scene.add(sprite)
      people.set(clientId, {
        name: info.name,
        colour: info.colour,
        role: info.role,
        buffer: known?.buffer ?? createPoseBuffer(),
        sprite,
        saying: known?.saying ?? null, // { sprite, until }
      })
    }
  }

  /** A pose from awareness, as it arrives. Ignored for someone not (yet) in `sync`. */
  function push(clientId, pose, arrivedAt) {
    const person = people.get(clientId)
    if (!person || !Array.isArray(pose?.p) || !Array.isArray(pose?.q)) return
    person.buffer.push(pose, arrivedAt)
  }

  /** A chat message over these avatars (one person's client ids) for a few seconds. */
  function say(clientIds, text, now = performance.now()) {
    for (const clientId of clientIds) {
      const person = people.get(clientId)
      if (!person) continue
      disposeSprite(scene, person.saying?.sprite)
      const sprite = sayingSprite(text, person.colour)
      sprite.visible = false
      scene.add(sprite)
      person.saying = { sprite, until: now + SAY_MS }
    }
  }

  const shows = (person) => (person.role === 'viewer' ? visible.viewers : visible.editors)

  /** Where someone is drawn now, `{ p, q }`, or null. */
  function sampleOf(clientId, now) {
    return people.get(clientId)?.buffer.sample(now) ?? null
  }

  function update(now, camera) {
    let slot = 0
    for (const person of people.values()) {
      if (slot >= MAX_PEOPLE) break
      if (person.saying && now >= person.saying.until) {
        disposeSprite(scene, person.saying.sprite)
        person.saying = null
      }
      const pose = shows(person) ? person.buffer.sample(now) : null
      if (!pose) {
        person.sprite.visible = false
        if (person.saying) person.saying.sprite.visible = false
        continue
      }
      position.fromArray(pose.p)
      quaternion.fromArray(pose.q)
      matrix.compose(position, quaternion, scale)
      mesh.setMatrixAt(slot, matrix)
      mesh.setColorAt(slot, colour.set(person.colour))
      slot++
      person.sprite.position.set(position.x, position.y + NAME_HEIGHT * size, position.z)
      person.sprite.visible = !camera || camera.position.distanceTo(position) < NAME_RANGE
      if (person.saying) {
        // Over the name, whatever the distance: a message is worth seeing.
        const { sprite } = person.saying
        sprite.position.set(
          position.x,
          position.y + NAME_HEIGHT * size + sprite.scale.y / 2 + 1.6,
          position.z,
        )
        sprite.visible = true
      }
    }
    for (let i = slot; i < mesh.count; i++) mesh.setMatrixAt(i, matrix.compose(hidden, quaternion, hidden))
    mesh.count = slot
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  /** "Show editors" / "Show viewers" (decision 14a). */
  function setVisible({ editors = visible.editors, viewers = visible.viewers } = {}) {
    visible.editors = editors
    visible.viewers = viewers
  }

  function dispose() {
    sync([])
    scene.remove(mesh)
    geometry.dispose()
    material.dispose()
    mesh.dispose()
  }

  return {
    sync,
    push,
    update,
    sampleOf,
    say,
    setVisible,
    dispose,
    /** How many avatars the last `update` drew. */
    get drawn() {
      return mesh.count
    },
  }
}

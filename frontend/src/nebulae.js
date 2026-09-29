import * as THREE from 'three'
import { clusterInk } from './palette.js'
import { seededRandom } from './random.js'

// A faint cloud in a colour group's own colour behind each group, so from the
// overview a group reads as a place rather than a scatter of stars
// (`context/BALANCE2.md`, prototype). It fades out as the camera comes in, so
// from inside a group there is nothing between you and its stars.
//
// Drawn as big as the group's ball times SIZE; full strength from FAR radii
// out, gone inside NEAR radii.
const SIZE = 2.6
const NEAR = 1.3
const FAR = 3.5
const STRENGTH = 0.55
const TEXTURE_SIZE = 256
// Soft blobs making up the cloud texture, so it reads as gas, not a disc.
const BLOBS = 18

/**
 * One billboard per colour group, on the default layer (never blooms), drawn
 * before the lines so it sits behind everything. `setGroups` takes
 * `lanes.measureGroups` output; `update(camera)` fades by distance.
 */
export function createNebulae(parent) {
  const root = new THREE.Group()
  root.name = 'nebulae'
  root.visible = false
  parent.add(root)
  const texture = cloudTexture()
  const sprites = new Map() // colour id -> Sprite
  let on = false

  function setGroups(groups) {
    for (const [color, sprite] of sprites) {
      if (groups.has(color) && groups.get(color).members.length >= 3) continue
      root.remove(sprite)
      sprite.material.dispose()
      sprites.delete(color)
    }
    for (const [color, group] of groups) {
      if (group.members.length < 3) continue
      let sprite = sprites.get(color)
      if (!sprite) {
        const ink = clusterInk(color)
        const material = new THREE.SpriteMaterial({
          map: texture,
          color: new THREE.Color().setRGB(ink[0], ink[1], ink[2], THREE.SRGBColorSpace),
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          opacity: 0,
        })
        // Each group's cloud turned its own way, so they don't all look stamped.
        material.rotation = seededRandom(color * 7919)() * Math.PI * 2
        sprite = new THREE.Sprite(material)
        sprite.renderOrder = -1
        sprites.set(color, sprite)
        root.add(sprite)
      }
      sprite.position.set(group.c[0], group.c[1], group.c[2])
      sprite.scale.setScalar(Math.max(group.r, 1) * SIZE)
      sprite.userData.radius = Math.max(group.r, 1)
    }
  }

  const eye = new THREE.Vector3()
  function update(camera) {
    if (!on) return
    eye.setFromMatrixPosition(camera.matrixWorld)
    for (const sprite of sprites.values()) {
      const r = sprite.userData.radius
      const d = eye.distanceTo(sprite.position) / r
      const t = Math.min(1, Math.max(0, (d - NEAR) / (FAR - NEAR)))
      sprite.material.opacity = STRENGTH * t * t * (3 - 2 * t)
    }
  }

  function setOn(value) {
    on = Boolean(value)
    root.visible = on
  }

  function dispose() {
    parent.remove(root)
    for (const sprite of sprites.values()) sprite.material.dispose()
    texture.dispose()
  }

  return {
    setGroups,
    update,
    setOn,
    dispose,
    get on() {
      return on
    },
  }
}

/** A soft, lumpy white cloud on transparent black, fading to nothing at the edge. */
function cloudTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = TEXTURE_SIZE
  const ctx = canvas.getContext('2d')
  const random = seededRandom(0x6e6275)
  const half = TEXTURE_SIZE / 2
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < BLOBS; i++) {
    const angle = random() * Math.PI * 2
    const reach = Math.sqrt(random()) * half * 0.42
    const x = half + Math.cos(angle) * reach
    const y = half + Math.sin(angle) * reach
    const radius = half * (0.25 + random() * 0.3)
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, 'rgba(255,255,255,0.22)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE)
  }
  // Clear the corners: a blob near the edge would show the square.
  ctx.globalCompositeOperation = 'destination-in'
  const mask = ctx.createRadialGradient(half, half, half * 0.35, half, half, half)
  mask.addColorStop(0, 'rgba(0,0,0,1)')
  mask.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = mask
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

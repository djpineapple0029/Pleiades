// dustRivers.js: grain tails by distance from the camera. Two linked stars
// near the origin, run until every grain's tail is full (16 samples at 0.1 s),
// then the same state written out for cameras at different distances.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createDustRivers } from '../../src/dustRivers.js'
import { TRAIL_POINTS } from '../../src/riverFlow.js'

function setup() {
  const nodes = new Map([
    ['a', { id: 'a', x: 0, y: 0, z: 0 }],
    ['b', { id: 'b', x: 100, y: 0, z: 0 }],
  ])
  const edges = new Map([['ab', { id: 'ab', from: 'a', to: 'b', directed: false }]])
  const graph = { nodes, edges, revision: 1 }
  const rivers = createDustRivers(graph, new THREE.Scene(), { radiusOf: () => 6 })
  for (let s = 0; s < 3; s += 1 / 30) rivers.update(1 / 30, [])
  return rivers
}

function cameraAt(x, y, z) {
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(x, y, z)
  return camera
}

// Vertices written, redrawn from the same state (a zero step moves nothing).
function tailVertices(rivers, camera) {
  rivers.update(0, [], camera)
  return rivers.streaks.geometry.drawRange.count
}

describe('dustRivers', () => {
  it('without a camera every grain draws its full tail', () => {
    const rivers = setup()
    const grains = rivers.object.geometry.drawRange.count
    expect(grains).toBeGreaterThan(0)
    expect(tailVertices(rivers)).toBe(grains * TRAIL_POINTS * 2)
  })

  it('close by, tails are exactly as without a camera', () => {
    const rivers = setup()
    expect(tailVertices(rivers, cameraAt(50, 0, 20))).toBe(tailVertices(rivers))
  })

  it('further off, tails keep every other sample, then every fourth, then eighth', () => {
    const rivers = setup()
    const full = tailVertices(rivers)
    // Every grain is within ~50 of the link, so these land in one band each.
    expect(tailVertices(rivers, cameraAt(50, 400, 0))).toBe(full / 2)
    expect(tailVertices(rivers, cameraAt(50, 620, 0))).toBe(full / 4)
    expect(tailVertices(rivers, cameraAt(50, 950, 0))).toBe(full / 8)
  })

  it('past the fog, grains draw no tails but are still drawn as points', () => {
    const rivers = setup()
    const grains = rivers.object.geometry.drawRange.count
    expect(tailVertices(rivers, cameraAt(50, 2000, 0))).toBe(0)
    expect(rivers.streaks.visible).toBe(false)
    expect(rivers.object.geometry.drawRange.count).toBe(grains)
    expect(rivers.object.visible).toBe(true)
  })
})

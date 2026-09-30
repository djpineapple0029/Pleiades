// dustRivers.js: what goes to the GPU each frame. The grains are worked out
// in the shader, so a frame should send the star table and only the few
// grains whose route moved on — never every grain, except when the map's
// structure changes — and never by a path that makes the page wait on the GPU.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createDustRivers } from '../../src/dustRivers.js'
import { GRAIN_TEXELS, TEX_WIDTH, TRAIL_POINTS } from '../../src/riverFlow.js'

function setup() {
  const nodes = new Map()
  const edges = new Map()
  for (let i = 0; i < 12; i++) nodes.set(`n${i}`, { id: `n${i}`, x: i * 90, y: (i % 3) * 60, z: 0 })
  for (let i = 1; i < 12; i++)
    edges.set(`e${i}`, { id: `e${i}`, from: `n${i}`, to: `n${i - 1}`, directed: false })
  const graph = { nodes, edges, revision: 1 }
  const rivers = createDustRivers(graph, new THREE.Scene(), { radiusOf: () => 6 })
  for (let s = 0; s < 5; s += 1 / 60) rivers.update(1 / 60, [])
  return { graph, rivers }
}

/**
 * Just enough of a WebGLRenderer for the rivers' draw hook: records every GL
 * call. `onGpu` says whether the grain texture has been sent yet.
 */
function fakeRenderer(onGpu = true) {
  const calls = []
  const gl = new Proxy(
    { TEXTURE_2D: 1, RGBA: 2, FLOAT: 3 },
    {
      get: (target, key) => (key in target ? target[key] : (...args) => calls.push([key, ...args])),
    },
  )
  return {
    calls,
    getSize: (v) => v.set(800, 600),
    getPixelRatio: () => 1,
    getContext: () => gl,
    properties: { get: () => (onGpu ? { __webglTexture: {} } : {}) },
    state: { bindTexture: (...args) => calls.push(['bindTexture', ...args]) },
  }
}

/** What three does once it has sent a texture whole. */
const sentWhole = (texture) => texture.onUpdate?.(texture)

/** One frame's draw: the rivers' hook runs just before the points draw. */
function draw(rivers, renderer) {
  rivers.object.onBeforeRender(renderer)
  return renderer.calls.filter(([name]) => name === 'texSubImage2D')
}

describe('dustRivers', () => {
  it('draws every grain as a point and a tail of TRAIL_POINTS segments', () => {
    const { rivers } = setup()
    const count = rivers.flow.count
    expect(count).toBeGreaterThan(100)
    expect(rivers.object.geometry.drawRange.count).toBe(count)
    const streaks = rivers.streaks.geometry
    expect(streaks.drawRange.count).toBe(count * TRAIL_POINTS * 2)
    // Grain 1's tail: its own points, i to i + 1, head to tail.
    const perTail = TRAIL_POINTS + 1
    const index = [...streaks.index.array.slice(TRAIL_POINTS * 2, TRAIL_POINTS * 4)]
    expect(index).toEqual(Array.from({ length: TRAIL_POINTS * 2 }, (_, i) => perTail + ((i + 1) >> 1)))
    expect(streaks.getAttribute('grain').getX(perTail)).toBe(1)
    expect(streaks.getAttribute('tail').getX(perTail + TRAIL_POINTS)).toBe(TRAIL_POINTS)
  })

  it('a steady frame sends only the grains that moved on, each to its own texels', () => {
    const { rivers } = setup()
    const grainTex = rivers.uniforms.grainTex.value
    sentWhole(grainTex)
    let sent = 0
    for (let frame = 0; frame < 60; frame++) {
      rivers.update(1 / 60, [])
      expect(rivers.flow.allDirty).toBe(false)
      const version = grainTex.version
      const moved = [...rivers.flow.dirty.subarray(0, rivers.flow.dirtyCount)]
      expect(rivers.pendingGrains).toEqual(moved)
      const renderer = fakeRenderer()
      const uploads = draw(rivers, renderer)
      expect(uploads.length).toBe(moved.length)
      uploads.forEach(([, , , x, y, width, height, , , data, offset], i) => {
        const texel = moved[i] * GRAIN_TEXELS
        expect([x, y, width, height]).toEqual([
          texel % TEX_WIDTH,
          Math.floor(texel / TEX_WIDTH),
          GRAIN_TEXELS,
          1,
        ])
        expect(data).toBe(rivers.flow.records)
        expect(offset).toBe(texel * 4)
      })
      // Nothing read back from GL, and three isn't asked to send anything.
      expect(renderer.calls.some(([name]) => name.startsWith('get'))).toBe(false)
      expect(grainTex.version).toBe(version)
      expect(rivers.pendingGrains).toEqual([])
      sent += uploads.length
    }
    // A handful a frame, not the whole map.
    expect(sent / 60).toBeLessThan(rivers.flow.count / 20)
  })

  it('a change to the map sends every grain once, whole', () => {
    const { graph, rivers } = setup()
    const grainTex = rivers.uniforms.grainTex.value
    sentWhole(grainTex)
    graph.nodes.set('extra', { id: 'extra', x: 0, y: 300, z: 0 })
    graph.revision++
    const version = grainTex.version
    rivers.update(1 / 60, [])
    expect(rivers.flow.allDirty).toBe(true)
    expect(rivers.sendsWhole).toBe(true)
    expect(grainTex.version).toBeGreaterThan(version)
    expect(draw(rivers, fakeRenderer())).toEqual([])
  })

  it('goes up whole until three has sent it whole, as after a context restore', () => {
    const { rivers } = setup()
    const grainTex = rivers.uniforms.grainTex.value
    // Never sent yet: however many frames go by, nothing goes up piecemeal.
    for (let frame = 0; frame < 30; frame++) {
      rivers.update(1 / 60, [])
      expect(rivers.sendsWhole).toBe(true)
      expect(draw(rivers, fakeRenderer())).toEqual([])
    }
    sentWhole(grainTex)
    rivers.update(1 / 60, [])
    expect(rivers.pendingGrains.length).toBe(rivers.flow.dirtyCount)
    rivers.restore()
    expect(rivers.sendsWhole).toBe(true)
    expect(rivers.pendingGrains).toEqual([])
    rivers.update(1 / 60, [])
    expect(draw(rivers, fakeRenderer())).toEqual([])
  })

  it('a texture three has lost goes up whole rather than piecemeal', () => {
    const { rivers } = setup()
    const grainTex = rivers.uniforms.grainTex.value
    sentWhole(grainTex)
    rivers.update(1 / 60, [])
    while (rivers.pendingGrains.length === 0) rivers.update(1 / 60, [])
    const version = grainTex.version
    expect(draw(rivers, fakeRenderer(false))).toEqual([])
    expect(rivers.sendsWhole).toBe(true)
    expect(grainTex.version).toBeGreaterThan(version)
  })

  it('grains from frames nobody drew pile up, then give way to one whole upload', () => {
    const { rivers } = setup()
    sentWhole(rivers.uniforms.grainTex.value)
    const moved = new Set()
    for (let frame = 0; frame < 5; frame++) {
      rivers.update(1 / 60, [])
      for (const g of rivers.flow.dirty.subarray(0, rivers.flow.dirtyCount)) moved.add(g)
    }
    expect(new Set(rivers.pendingGrains)).toEqual(moved)
    for (let frame = 0; frame < 900 && !rivers.sendsWhole; frame++) rivers.update(1 / 60, [])
    expect(rivers.sendsWhole).toBe(true)
    expect(rivers.pendingGrains).toEqual([])
  })

  it('hides without advancing, and shows again on update', () => {
    const { rivers } = setup()
    const time = rivers.uniforms.time.value
    rivers.hide()
    expect(rivers.object.visible).toBe(false)
    expect(rivers.streaks.visible).toBe(false)
    expect(rivers.uniforms.time.value).toBe(time)
    rivers.update(1 / 60, [])
    expect(rivers.object.visible).toBe(true)
    expect(rivers.streaks.visible).toBe(true)
  })
})

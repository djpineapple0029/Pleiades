// The dust rivers' two copies of one formula: the GLSL that draws every grain
// (dustRivers.js GRAIN_GLSL) and the JS that the tests and the delete-freeze
// read (riverFlow.js positionAt). Every grain, at its head and at two points
// back along its tail, is rendered through GRAIN_GLSL into a float target and
// read back against the JS — through orbits, rivers, a frozen grain, a star
// moved by hand, and a supernova shell.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, threeModuleUrl } from '../helpers/gestures.js'

test('the shader puts every grain where riverFlow.js says it is', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  const threeUrl = await threeModuleUrl(page)

  const out = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createDustRivers, GRAIN_GLSL, FORMULA_DEFINES } = await import('/src/dustRivers.js')

    const nodes = new Map()
    const edges = new Map()
    const addNode = (id, x, y, z) => nodes.set(id, { id, x, y, z, is_core: id === 'n0' })
    const addEdge = (id, from, to, directed = false) => edges.set(id, { id, from, to, directed })
    for (let i = 0; i < 8; i++) addNode(`n${i}`, i * 110, (i % 2) * 70, (i % 3) * 40)
    for (let i = 1; i < 8; i++) addEdge(`e${i}`, `n${i - 1}`, `n${i}`, i === 3)
    addNode('side', 200, 300, -80)
    addEdge('eside', 'n2', 'side')
    const graph = { nodes, edges, revision: 1 }
    const scene = new THREE.Scene()
    const rivers = createDustRivers(graph, scene, { radiusOf: (id) => (id === 'n0' ? 9 : 5) })

    const run = (seconds, shocks = []) => {
      for (let s = 0; s < seconds; s += 1 / 30) rivers.update(1 / 30, shocks)
    }
    run(6)
    // A shell goes off at n4 while grains are around it.
    const n4 = nodes.get('n4')
    const shock = { id: 1, x: n4.x, y: n4.y, z: n4.z, age: 0, starRadius: 5 }
    run(0.4, [shock])
    // n6 is deleted: its grains freeze where they are.
    nodes.delete('n6')
    edges.delete('e6')
    edges.delete('e7')
    graph.revision++
    run(0.2, [shock])
    // `side` is carried off by hand: its grains and their tails follow.
    nodes.get('side').x += 150
    run(0.3)

    const canvas = document.createElement('canvas')
    const renderer = new THREE.WebGLRenderer({ canvas })
    renderer.setSize(320, 240, false)
    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.5, 5000)
    camera.position.set(400, 100, 900)
    camera.lookAt(400, 0, 0)
    // The real points and tails, once: they have to compile and draw.
    renderer.render(scene, camera)

    const flow = rivers.flow
    const count = flow.count
    const agos = [0, 0.35, 1.1]
    const total = count * agos.length
    const W = 256
    const H = Math.ceil(total / W)
    const grain = new Float32Array(total)
    const ago = new Float32Array(total)
    for (let i = 0; i < total; i++) {
      grain[i] = Math.floor(i / agos.length)
      ago[i] = agos[i % agos.length]
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3))
    geometry.setAttribute('grain', new THREE.BufferAttribute(grain, 1))
    geometry.setAttribute('ago', new THREE.BufferAttribute(ago, 1))
    const material = new THREE.ShaderMaterial({
      uniforms: rivers.uniforms,
      defines: { ...FORMULA_DEFINES, OUT_W: String(W), OUT_H: String(H) },
      vertexShader: `
        ${GRAIN_GLSL}
        attribute float grain;
        attribute float ago;
        varying vec4 vOut;
        void main() {
          float heat;
          vec3 p = grainAt(int(grain + 0.5), time - ago, heat);
          vOut = vec4(p, heat);
          int i = gl_VertexID;
          vec2 at = (vec2(float(i % OUT_W), float(i / OUT_W)) + 0.5) / vec2(float(OUT_W), float(OUT_H));
          gl_Position = vec4(at * 2.0 - 1.0, 0.0, 1.0);
          gl_PointSize = 1.0;
        }`,
      fragmentShader: `
        varying vec4 vOut;
        void main() { gl_FragColor = vOut; }`,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    })
    const probe = new THREE.Points(geometry, material)
    probe.frustumCulled = false
    const probeScene = new THREE.Scene()
    probeScene.add(probe)
    const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType })
    renderer.setRenderTarget(target)
    renderer.render(probeScene, camera)
    const pixels = new Float32Array(W * H * 4)
    renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels)
    renderer.setRenderTarget(null)

    const expected = new Float64Array(4)
    let worst = 0
    let sum = 0
    let worstHeat = 0
    let worstAt = null
    for (let i = 0; i < total; i++) {
      flow.positionAt(grain[i], ago[i], expected)
      const o = i * 4
      const err = Math.hypot(
        pixels[o] - expected[0],
        pixels[o + 1] - expected[1],
        pixels[o + 2] - expected[2],
      )
      sum += err
      if (err > worst) {
        worst = err
        worstAt = { grain: grain[i], ago: ago[i], gpu: [...pixels.subarray(o, o + 4)], js: [...expected] }
      }
      worstHeat = Math.max(worstHeat, Math.abs(pixels[o + 3] - expected[3]))
    }
    const phases = { orbit: 0, transit: 0, frozen: 0 }
    for (let g = 0; g < count; g++) {
      const state = flow.grain(g)
      if (state.dying === 2) phases.frozen++
      else if (state.phase !== 'dead') phases[state.phase]++
    }
    return { count, mean: sum / total, worst, worstHeat, worstAt, phases }
  }, threeUrl)

  console.log('dust parity:', JSON.stringify(out))
  expect(errors).toEqual([])
  expect(out.count).toBeGreaterThan(200)
  // Every kind of segment was there to compare.
  expect(out.phases.orbit).toBeGreaterThan(0)
  expect(out.phases.transit).toBeGreaterThan(0)
  expect(out.phases.frozen).toBeGreaterThan(0)
  // float32 (and SwiftShader's trig) on the GPU against doubles in JS, on a
  // map ~800 units across: a few thousandths on average, the odd few
  // hundredths. A formula that has drifted is off by whole units.
  expect(out.mean).toBeLessThan(0.02)
  expect(out.worst).toBeLessThan(0.25)
  expect(out.worstHeat).toBeLessThan(0.01)
})

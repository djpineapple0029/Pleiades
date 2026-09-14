import * as THREE from 'three'

export const VOID_COLOR = 0x05060a
const FOV = 70
const NEAR = 0.5
const FAR = 20000

/**
 * Renderer + scene + camera, sized to the window and kept in sync with it.
 * Returns a `dispose` that tears down the resize listener and GPU resources.
 */
export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  // The skybox paints the whole frame; this only shows if it is missing. No
  // scene.background: the star pass would have to take it out again.
  renderer.setClearColor(VOID_COLOR)

  const scene = new THREE.Scene()

  // No lights: nodes are self-lit stars and nothing else is shaded.
  const camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR)
  scene.add(camera)

  function resize() {
    const { innerWidth: w, innerHeight: h } = window
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    // false: the canvas is sized by CSS, only the drawing buffer changes here.
    renderer.setSize(w, h, false)
  }
  resize()
  window.addEventListener('resize', resize)

  function dispose() {
    window.removeEventListener('resize', resize)
    renderer.dispose()
  }

  return { renderer, scene, camera, dispose }
}

import { defineConfig } from 'vite'

// Unit tests run in plain Node, never jsdom: everything under test here
// (graph.js, sizing.js, clustering.js) is DOM-free by design (V2.md §2.4.7),
// and `test_camera.mjs`'s import of 'three' works fine without a DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
  },
})

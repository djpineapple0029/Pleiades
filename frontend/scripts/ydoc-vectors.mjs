// Writes tests/fixtures/ydoc-vectors.json: payloads and the Yjs update JS
// encodes for each, so server/ydoc.py is tested against real yjs bytes.
// Generated, not golden: rerun after changing ydoc.js on purpose.
//
// Run with `node scripts/ydoc-vectors.mjs`. ydoc.js is loaded through Vite
// (its schema.js imports package.json, which plain Node won't without an
// import attribute), the same way the app and Vitest load it.
import { writeFileSync } from 'node:fs'
import { createServer } from 'vite'
import * as Y from 'yjs'

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, entries: [] },
})
const { payloadToDoc } = await vite.ssrLoadModule('/src/format/ydoc.js')

const payloads = {
  empty: { nodes: [], edges: [] },
  small: {
    camera: { position: [0, 0, 260] },
    nodes: [
      {
        id: 'n1',
        label: 'Sun',
        notes: 'hot\nvery',
        x: 1.5,
        y: -2,
        z: 0,
        cluster_color_id: 3,
        blend: [0.1, 0.2, 0.3],
        is_core: true,
        is_nexus: false,
        links: ['https://example.com'],
      },
      {
        id: 'n-k3f9x2q7ab',
        label: 'Ünïcødé 🌍',
        notes: '',
        x: 0,
        y: 0,
        z: 0,
        cluster_color_id: 0,
        blend: null,
        is_core: false,
        is_nexus: true,
        links: [],
      },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n-k3f9x2q7ab', directed: true, label: 'orbits' }],
  },
}
const out = {}
for (const [name, payload] of Object.entries(payloads)) {
  out[name] = {
    payload,
    update: Buffer.from(Y.encodeStateAsUpdate(payloadToDoc(payload))).toString('base64'),
  }
}
writeFileSync(
  new URL('../tests/fixtures/ydoc-vectors.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n',
)
await vite.close()

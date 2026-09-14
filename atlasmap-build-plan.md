# AtlasMap — Build Plan

3D galaxy-style mind mapping tool. First-person flight navigation, force-directed auto-clustering layout, encrypted local file format.

## Stack

- **Frontend:** Three.js (raw, not a wrapper), bundled with Vite
  - `PointerLockControls` — flight camera
  - `OrbitControls` — overview mode toggle
  - `d3-force-3d` — physics simulation math
  - `graphology` + `graphology-communities-louvain` — clustering
  - Selective glow: a custom pipeline in `bloom.js` (layers + a dual-filter bloom chain), not `EffectComposer` + `UnrealBloomPass` — see session 6 for why
  - `Line2`/`LineMaterial` (three/examples/jsm/lines) — thick lines with real raycasting support
- **Backend:** Flask — file I/O, encryption, and serving the built frontend. No graph logic lives here.
- **Crypto:** Python `cryptography` lib — PBKDF2HMAC(SHA256) key derivation, Fernet for encrypt/decrypt.

## `.atlasmap` File Format

```
bytes 0–3:    magic "ATLM"
byte 4:       version (0x01)
bytes 5–20:   salt (16 bytes, random per file, generated on first save)
bytes 21+:    Fernet token (encrypted JSON payload)
```

Decrypted JSON payload shape:
```json
{
  "nodes": [{ "id", "label", "notes", "links": [], "x", "y", "z", "cluster_color_id", "is_core": bool }],
  "edges": [{ "id", "from", "to", "directed": bool, "label": "" }],
  "camera": { "position": [x,y,z], "rotation": [x,y,z] }
}
```

## File Storage Model

No server-side folder. Standard browser download/upload, user owns the file location entirely:

- **New map:** frontend starts an empty in-memory graph, no file yet.
- **Save:** frontend sends the current graph JSON + password to Flask. Flask encrypts it and returns the bytes as a file download (`Content-Disposition: attachment`). Browser's native save dialog handles where it goes — user picks the folder/filename themselves, same as saving anything else.
- **Open:** frontend uses a normal `<input type="file">` to let the user pick a `.atlasmap` file from anywhere on disk, uploads the bytes to Flask along with the password, gets back decrypted JSON to render.

Trade-off: each save is technically a fresh download rather than a silent in-place overwrite — the user re-saves over the same filename themselves (browsers can prompt "replace existing file?" if they pick the same name). No desktop shell needed, works in any browser, matches what you described.

## Backend Endpoints

- `POST /api/open` → multipart upload (`.atlasmap` file) + `password` → decrypts, returns JSON payload (or 401 on bad password, 400 on corrupt/wrong-format file)
- `POST /api/save` → `{ password, payload }` → encrypts, responds with the `.atlasmap` file as a download

Password is held in a JS variable in the frontend session (never persisted, never sent anywhere but these two endpoints) after the initial open/first-save prompt.

## Node Sizing Rule

Two inputs feed final node size, combined rather than either alone:

1. **Degree-based size** (existing rule) — more connections = bigger.
2. **Core-influence size** — a node can be flagged `is_core`. Core nodes render at a large fixed size. Influence spreads outward via BFS from every core node: each hop away, the size boost decays (e.g. geometric falloff, cut off after a few hops so it doesn't spread across the whole graph). If a node sits within range of multiple core nodes, it takes the strongest (closest) influence, not a sum of all of them.

**Final size = max(degree-based size, core-influence size)** — whichever is larger wins, so a highly-connected non-core node and a node near a core topic can both end up prominent, but a core node's influence doesn't get diluted by also averaging in degree.

Recompute is a cheap BFS over the graph (O(V+E)) — rerun whenever a node's core flag is toggled or the graph structure changes, not on every frame.

## Known Technical Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Pointer lock means no real cursor — a normal right-click context menu can't work | Radial menu opens at screen center (crosshair); mouse-delta accumulation picks a wedge, like an FPS weapon wheel. Pointer lock never exits. |
| Chrome enforces a cooldown (~1.25s) before re-acquiring pointer lock after release | Avoid ever releasing lock for menus/interaction — see above. Only release lock for the overview-mode toggle, which is an intentional mode switch, not a per-click action. |
| Default `THREE.Line` has near-zero raycasting tolerance — right-clicking a connection would frequently miss | Use `Line2`/`LineMaterial` (supports raycast threshold), or pair each visible line with an invisible slightly-thicker cylinder as the real hit target. |
| Running force simulation to convergence in one call blocks the render thread | Chunk it: N ticks per animation frame via `requestAnimationFrame`, not all ticks at once. Produces a nice "settling" animation as a side effect. |
| Louvain gives cluster membership, not positions — nothing pulls nodes together by default | Custom force layered on `forceLink`/`forceManyBody`: each node gets extra attraction toward its cluster's centroid, recomputed each tick. |
| Louvain cluster IDs aren't stable between runs — re-balancing could reshuffle node colors | Before assigning colors to a new run's clusters, match new clusters to previous ones by node-overlap and keep the same color for the closest match. Only new/split clusters get a new color. |
| Bloom pass glows everything above a brightness threshold, including labels/UI | Three.js layers: only node meshes assigned to the bloom layer; render bloom pass on that layer alone, composite over the normal scene. |
| One mesh per node/edge won't scale to "no limit" node counts | `InstancedMesh` for nodes, merged/instanced geometry for edges — one draw call each. Per-node pulse animation needs a per-instance time-offset attribute (custom shader), not per-mesh material animation. |
| Getting lost in open 3D space with no landmarks | Overview mode (Tab) as an escape hatch — orbit camera, zoom-to-fit. Subtle nebula skybox gives orientation cues without being distracting. |

## Build Sessions (in order — each sized for one Claude Code session, `/clear` between them)

Each session is scoped to be self-contained: point a fresh session at this doc plus the current codebase and it has what it needs, without needing prior chat context. Don't start a session until the previous one's "Done when" is actually true.

When a session's "Done when" is actually true, mark its heading `— done` with the date and add a
`*Landed:*` line naming what to expect in the codebase, so the next session can pick up cold.

**Session 0 — Scaffold** — done (2026-09-10)
Flask app skeleton, static frontend serving, Vite build pipeline. Bare Three.js scene with `PointerLockControls` flight (WASD + Space/Shift), no game objects yet.
*Done when:* you can fly around an empty scene smoothly, mouse-locked.
*Landed:* `server/` — Flask `create_app()`, serves the Vite build from `server/static/`, `python -m server`
on port 5001. `frontend/` — Vite 7 + three 0.180, builds into `server/static/`, dev server proxies `/api` to
Flask. `frontend/src/`: `scene.js` (renderer/camera/resize), `flight.js` (`PointerLockControls` + damped 6DOF
WASD/Space/Shift movement, camera-relative forward/strafe, world-relative up), `starfield.js` (reference
points for motion parallax — session 6 replaces it with the nebula skybox), `main.js` (wiring, click-to-lock,
overlay, crosshair, pointer-lock-error notice). Run instructions in `README.md`.

**Session 1 — Core node/edge interaction** — done (2026-09-10)
Double-click spawns a node (placeholder sphere) at fixed crosshair distance. Crosshair raycasting against nodes. Radial menu (delta-wedge-select while locked) with Connect / Edit / Delete. Connection state machine (pending-connection line, right-click/Esc to cancel, left-click target to confirm). Edge hit-testing via `Line2` or collision cylinders, with its own Edit-label/Delete radial menu.
*Done when:* you can spawn, connect, edit, and delete nodes/edges entirely via mouse+keyboard while locked, no physics yet.
*Landed:* `graph.js` — model only, no Three.js/DOM; node and edge objects already
match the `.atlasmap` payload shape, so session 3 is a straight JSON round-trip.
Rejects self-loops and duplicate edges (either direction); `removeNode` cascades to
incident edges. `graphView.js` — one `Mesh` per node sharing geometry/material
(session 4 swaps this for `InstancedMesh`; nothing outside the module touches the
meshes), **all** edges in a single `LineSegments2` where segment index maps to
`edgeOrder[i]`, so `raycast` turns a hit's `faceIndex` straight into an edge id.
Position and color arrays are adopted by reference and mutated in place;
`updateEdgePositions()` is there for session 2 and **must** recompute both
bounding box and sphere — `LineSegments2.raycast` gates on them and only rebuilds
them when null, so a stale box silently makes edges unpickable. Hover/source state
is drawn as separate halo meshes rather than per-node materials, again so the
instanced swap does not have to redo it. Node picks beat edge picks within
`NODE_PICK_BIAS`, because edges run centre-to-centre and pass through their
endpoints. `radialMenu.js` — SVG wheel, opened on right-mousedown, fed raw mouse
deltas, committed on release; inside the deadzone it commits nothing, which is the
cancel gesture. `editor.js` — centred field panel returning a promise; pointer
lock only captures the mouse, so a focused input still takes keystrokes, and it
stops propagation so typing never reaches the flight keys. `interaction.js` — the
idle/connecting/menu/editing state machine, crosshair raycasting, HUD text, and
cascade-safe deletes; both modal surfaces suspend flight input and camera look via
`flight.setEnabled()` and `controls.enabled`, and pointer lock is never released.
`scene.js` gained a hemisphere fill plus a camera-parented directional key (no
distance falloff, so a node reads the same at any range). Controls table in
`README.md`.

**Session 2 — Physics** — done (2026-09-10)
`d3-force-3d` integrated, chunked-tick "Balance" button. No clustering yet.
*Done when:* pressing Balance visibly settles nodes into a non-overlapping layout without freezing the app.
*Landed:* `physics.js` — `createPhysics(graph, view)`, forces are link + manyBody +
collide + center. **`forceSimulation(nodes, numDimensions)` defaults to 2** — the 3
is not optional. Balance is a keypress (`B`), not a DOM button: pointer lock is
never released, so there is no cursor to click one with. The simulation runs on
proxy bodies keyed by node id, *not* on the model's nodes, because d3-force
stamps `index`/`vx`/`vy`/`vz` onto whatever it is handed and those node objects
are session 3's payload verbatim; positions are copied back after each chunk.
Two ordering traps inside `seed()`, both load-bearing: `forceLink` resolves
endpoints against the simulation's node list and **throws** on an id it cannot
find, so `simulation.nodes()` has to run before `linkForce.links()`, and the
previous run's links have to be cleared before that because they still hold
references to bodies the new seed may have dropped. `forceCenter` is retargeted
to the graph's current centroid on every seed — it recentres the layout onto its
target each tick, so a fixed origin would yank the whole map away from wherever
the user built it. Chunking is a 5 ms budget with a 4-tick ceiling and a floor of
one tick; one tick is the smallest indivisible unit, so the floor is the real
scaling limit. Measured per-frame cost during a run (Apple silicon, Node): ≤120
nodes p90 under 8 ms, 300 nodes p50 8 ms, 600 nodes ~17 ms, 1500 nodes ~52 ms —
past a few hundred nodes a run is visibly slow though still interactive, and
`theta` is already loosened to 1.3 and collide to one iteration to buy that.
Moving the sim to a worker is the next lever if it needs one; session 9's
cluster-centroid force drops into the same `simulation.force(...)` set and gets
re-seeded for free.
`interaction.js` takes `physics` as a dependency and calls `physics.invalidate()`
after **every** structural change — that re-seeds and reheats a run in flight so
a node added mid-settle gets placed; forget it on a new mutation and the layout
silently settles the old graph. HUD appends `balancing NN%`.
`graphView.js` — the hover/source halos were placed once at `setHover`/
`setSource` time, which detaches them from a node physics is moving; they now
record ids only and `placeHalos()` re-parks them inside `syncNodes()`. Physics
touches exactly two view methods, `syncNodes()` and `updateEdgePositions()` —
that pair is the whole contract session 4's `InstancedMesh` swap has to keep,
including `updateEdgePositions()`'s bounding box/sphere recompute (verified in a
headless browser: edges are still pickable at their midpoints after a settle).

**Session 3 — Persistence** — done (2026-09-10)
Flask crypto endpoints (`/api/open`, `/api/save`), password prompt flow (once per session, held in memory), download/upload wired to the current graph + node state.
*Done when:* you can save a map, close the tab, reopen, upload the file, and get the exact same graph back.
*Landed:* `server/atlasfile.py` — `encode`/`decode` plus `FormatError`/`PasswordError`.
PBKDF2-HMAC-SHA256, **600,000 iterations**, and the iteration count is *not* in
the header: `VERSION` is the only thing pinning it, so raising it without
bumping the version silently bricks every existing file, and the failure looks
exactly like a wrong password. A fresh salt per save, not per file — decrypt
reads the salt out of the header it was handed, so nothing needs the old one.
Fernet authenticates before it decrypts and cannot tell a wrong key from a
tampered token, so `PasswordError` covers both and its message says so.
`json.dumps(allow_nan=False)`: Python would happily write bare `NaN`, which the
browser then refuses to parse back.
`server/api.py` — blueprint at `/api`, `Cache-Control: no-store` on both
directions, JSON `{error}` bodies, 401 for a bad password and 400 for anything
malformed. `download_name()` sanitises the Content-Disposition filename (keeps
unicode, drops path separators and leading dots). `MAX_CONTENT_LENGTH` is 64 MB
with a blueprint 413 handler, so an oversized upload answers JSON like every
other failure. The payload is opaque JSON on the way through — the frontend
still owns the graph shape, so sessions 5 and 9 add fields without touching the
server.
`graph.js` — `toPayload()` returns **copies**, because physics rewrites x/y/z
every tick and a save should be a value rather than a view onto a layout still
in motion. `load()` validates everything into local maps and only then refills
the live ones, so a bad file leaves the map already open intact; `nodes`/`edges`
are handed out by reference, so they are refilled and never reassigned.
Position checks are deliberately strict — `Number(null)`, `Number('')` and
`Number(false)` are all `0`, so coercing would quietly park a damaged node at
the origin instead of refusing the file. Ids are minted past anything already
taken and the counters resume above the highest loaded suffix, so a file's own
ids can never be handed out twice.
`files.js` — payload assembly, the two calls, the download anchor and the file
input. The camera round-trips as `camera.rotation` x/y/z in the camera's own
euler order; `PointerLockControls` drives the quaternion through a **YXZ** euler
while `camera.rotation` is XYZ, and that mismatch is exact both ways (verified
at the pitch clamp). `applyPayload` calls `physics.reset()` **before**
`view.sync()`: a body kept under an id the new file happens to reuse would
otherwise hand a different node its old velocity. Credentials are adopted only
after an open actually succeeds. `open()` returns `{ ok, wrongPassword, error }`
rather than throwing — `wrongPassword` is the one failure worth re-prompting for.
`physics.js` gained `reset()` (clears links before nodes, same ordering trap as
`seed`). `editor.js` takes `type: 'password'` fields, which are never trimmed —
a trailing space is part of a password — plus a third `note` argument for the
retry message.
`interaction.js` owns the keybindings and both flows, not `files.js`, because
the password panel is a modal surface and only this module knows whether one is
already up. `Ctrl/Cmd+S`, `Ctrl/Cmd+Shift+S` (save as), `Ctrl/Cmd+O`, all
`preventDefault`-ed so the browser's own dialogs never see the chord, and keyed
on `event.code` since a held modifier changes what `key` reports. A `busy` flag
keeps two file flows from overlapping. The first save confirms the password: a
typo produces a file nobody can ever open. The open flow releases pointer lock
deliberately first — the file dialog is a native window and the browser would
take the lock anyway — so `#editor`/`#radial-menu` now sit above `#overlay`, and
`main.js` suppresses click-to-lock while a panel is up. HUD gained a 5-second
status line for save/open results.
Verified in headless Chromium against a live Flask: a map built in one tab,
saved, and opened in a fresh page comes back byte-identical with the camera
restored; a load lands correctly on top of a balance run in flight; loaded nodes
and edges are still pickable, before and after a settle. Not covered — pointer
lock itself does not work in `chrome-headless-shell`, so the locked-flight path
around these flows is still only exercised by hand.

**Deliberately not built:** there is no "new map" command and no unsaved-changes
warning — opening a file replaces the graph with no prompt.

**Session 4 — Instanced rendering + pulse shader** — done (2026-09-10)
Replace placeholder spheres with `InstancedMesh`, add per-instance emissive pulse (time-offset attribute per node so pulses aren't synced).
*Done when:* hundreds of nodes render as one draw call and visibly pulse independently.
*Landed:* all in `graphView.js`; the view's public surface is unchanged apart from a
new `update(seconds)`, which `main.js` calls every frame with `clock.elapsedTime`.
Every node is one instance of a single `InstancedMesh` named `'nodes'`. Slots are
contiguous (`slotIds[slot]` → id, `slotOf` id → slot); `syncNodes()` diffs against
the model, swap-removes deleted nodes (the last instance moves into the hole), and
appends new ones. `raycast` maps a hit's `instanceId` through `slotIds`, so slot
numbers never leave the module. **An `InstancedMesh` cannot be resized**:
`allocate()` starts at 256 slots and, once the map outgrows them, builds a
replacement at the next power of two (new geometry, new mesh, old pair disposed).
Capacity never shrinks. Anything a later session hangs on the node mesh (a bloom
layer, `instanceColor`) has to be set up inside `allocate()`, or it silently
disappears the first time the map crosses 256, 512, ... nodes.
**Same trap as the edges**: `InstancedMesh` caches `boundingSphere`, and both
raycasting and frustum culling gate on it and only recompute it when it is null.
`syncNodes()` nulls it (and `boundingBox`) after every write, so it is recomputed
lazily, at most once per frame. Leave that out and a node physics moves outside
the old bounds stops being pickable and gets culled while still on screen.
Instance matrices are `makeScale(NODE_RADIUS).setPosition(x, y, z)`, rewritten for
every slot on every sync. Session 5's per-node size goes in here: swap the
constant for the node's radius, and scale the halos (which still use
`NODE_RADIUS * 1.45`) and physics' `COLLIDE_RADIUS` to match. Halos are separate
meshes on their own geometry, positioned from the model, not from the instance.
Pulse: a Lambert material patched in `onBeforeCompile` (`inject()` throws if a
three.js upgrade renames a shader chunk, so it can't fail silently). A per-instance
attribute `instancePulse = [phase, rate]` lives on the mesh's geometry. The shader
mixes `totalEmissiveRadiance` from the material's `emissive` (trough,
`0x0d2a3d`, the old constant) toward the `pulseCrest` uniform (`0x3a9ee0`) by
`(0.5 − 0.5·cos 2π·fract(beat·rate + phase))²`, squared so a node rests dim and swells
briefly. Phase and rate are hashed from the **node id** (FNV-1a plus the murmur3
finaliser), not the slot: a node keeps its rhythm through swap-removes, growth,
and a save/reopen. Rates are quantised to k/8 for k ∈ 6..10 (0.75×–1.25× of a 3.6 s
period), so every node completes a whole number of cycles in 28.8 s. The clock
wraps there on the CPU (`pulseBeat = (t mod 28.8) / 3.6`) with no visible jump,
and the float32 uniform stays small however long the tab is open.
Verified in headless Chromium: 500 nodes plus 499 edges render in 2 draw calls and
3000 nodes in 1. With the lights removed, every instance's pixel matches the pulse
formula within 2/255 at 12 sample times. All 25 nodes in a patch pulse, spread
across 177/255 at a single instant, with 5 distinct rates. There is no jump
across the wrap and no drift 4 hours in. Instances pick correctly after a
mid-array delete; the node swapped into the hole keeps its pulse; growth to 1024
keeps one mesh; every node is still pickable after a full balance run; a file load
renders and picks; halos follow the instance. Session 3's load/render suite still
passes (14/14). Per-frame cost at 3000 nodes, measured: `syncNodes` ~0.14 ms,
bounds recompute ~0.1 ms, crosshair raycast ~0.17 ms. Physics remains the only
per-frame cost that matters. Not covered: locked-flight interaction around the
new mesh (pointer lock does not work headless). Spawning, connecting, and deleting
only reach the view through `syncNodes`/`syncEdges`/`raycast`, and those are
tested directly.

**Session 4b — Star nodes** — done (2026-09-10)
Nodes restyled from lit spheres to self-lit stars: a white-hot core, a tinted glow, and a dense sunburst of
fine rays with a slow shimmer. Glow and rays reach about 3–4× the node radius.
*Landed:* still all in `graphView.js`, still one `InstancedMesh` named `'nodes'`, and the public
surface is unchanged. Much of Session 4's detail above is superseded. Each instance is now a 2×2 `PlaneGeometry` quad that
the vertex shader billboards in view space (`ShaderMaterial`, additive, `depthWrite: false`); the
radius is read back as `length(instanceMatrix[0].xyz)`, so **the instance matrix scale is still the
only size input**. The Lambert material, `pulseCrest`, and every scene light are gone —
`scene.js` has no lights, and nothing in the scene is shaded. Per-instance attributes are
`instanceStar = [phase, rate, seed]` and `instanceTint` (linear RGB), both written by
`writeStar()` from hashes of the **node id**: pulse phase/rate are bit-for-bit the same as
before, and the seed and a blue→white→warm tint come from a second hash. Session 9 changes the tint
by writing different colours into `instanceTint` — no shader change needed.
**The rays are 3D and fixed in world space**, which keeps a star from reading as a flat card when
you fly around it: orbiting swings them round and foreshortens them, and rolling the camera turns
them with the world. `rayFamily()` cuts the sphere of directions into cube-map cells (G per face
edge). Each cell may throw one ray, with odds scaled by the cell's solid angle so rays are spread
evenly (about πG² per family), and each ray has its own direction jitter, brightness, length, and
flicker. Three families: G = 4 / 7 / 11, weighted 2.4 / 1.3 / 0.5 — a family's total light grows
with G, so the dense ones are weighted down or they add up to grey haze. How a pixel finds its
rays: a pixel at screen direction u can only be lit by rays on the half great circle through u
and the line of sight w. Written as `u + t·w`, that arc is a straight line, so the loop walks
exactly the cells it crosses, with exact, trig-free edge crossings in face-local coordinates. Only
one edge per face axis can ever be next. `t` is bounded by the foreshortening needed to reach the
pixel's radius. Rays sit in the middle half of their cell, so a ray in a cell the arc misses is
at least ~0.2/G rad off it. The ray cross-section is capped at `r/(12.5·G)` so it never needs
looking for. Where rays are under ~2–5 px apart, the family blends to its average light: a
closed-form fit, `0.1686·(1−ρ)^3.25·(1+0.4ρ)`, fitted offline by Monte Carlo to the
brightness/length/foreshortening distributions. **Change those distributions and the fit has to
be redone.** The quad stays square to the view plane, so stars near the screen edge stay round;
only the ray maths uses the true line of sight (`vToCamera`, world-space, from the vertex shader).
The flicker lattice wraps modulo `8 * shimmer` steps, so the 28.8 s `pulseBeat` wrap stays
seamless. Glow is a saturated core, a Gaussian skirt that carries it into the rays, and a faint
tail forced to zero well inside the billboard — after the sRGB encode, anything broad reads as a
hazy disc (this is what made an earlier version look like an orb again). The shader fades a star
out between 2.5 and 0.8 radii from the camera, so flying through one doesn't white out the screen.
**Cost** (Apple M3, Metal, 2560×1600): one star at spawn distance 0.4 ms; a 180-node map from
inside 3.5 ms, overview 2.7 ms; 3000 nodes overview 4.1 ms, flying inside 7.9 ms; one star
filling the whole screen 9 ms (the worst case). Nearly all of it is the ray walk — glow alone
is ~0.1 ms. The earlier 2D-ray version was far cheaper; if a slower GPU struggles, the levers are
dropping the G = 11 family or raising the `detail` threshold.
**Picking no longer touches the mesh.** `pickNode()` ray-tests a sphere of `NODE_RADIUS` per node
analytically (~0.05 ms at 3000 nodes), so the rays are never clickable. The mesh's bounding sphere
is now only for frustum culling. The geometry's bounds are **set by hand** to cover the whole
billboard in any orientation; computed, they would describe the flat plane and cull stars whose
rays are still on screen. `syncNodes()` still nulls the mesh bounds on every write. The mesh
has `renderOrder = 1`, set inside `allocate()`, so the normally blended edges draw first — an
edge drawn over a star lays a dark line across its core. Hover/source halos are now `Sprite`
rings (canvas texture) at 1.35 radii instead of back-face spheres.
Verified headless: 39/39 on a ported session 4 suite (draw calls, per-star pulse/seed/tint,
shimmer present, no jump across the wrap or after 4 h, clean billboard edges, orbiting changes a
star's look, a rolled view matches the unrolled one rotated, picking inside the radius hits and in
the rays misses, swap-remove, stale bounds, an off-screen centre with on-screen rays still drawn,
growth to 2048, settle, file load, halos), plus session 3's load suite 14/14. Orbiting in 0.25°
steps (yaw, pitch, roll) changes each frame by an even amount with no spikes, so no ray pops in or
out as a cell is entered.

**Session 5 — Core nodes** — done (2026-09-10)
Add `is_core` toggle to the radial menu. Implement the BFS decay sizing rule (see Node Sizing Rule) as an instance-scale attribute, recomputed on graph change.
Per-node size touches four places: the instance matrix scale in `syncNodes()` (the star shader
follows it automatically), the pick radius in `pickNode()`, the halo sprite scale, and physics'
`COLLIDE_RADIUS`. The halo sprites are sized once at creation, so they need re-scaling in
`placeHalos()`.
*Done when:* marking a node core visibly grows it and its neighbors, with the effect fading over 3–4 hops.
*Landed:* `sizing.js` is new, and pure (no Three.js). `computeSizes(nodes, incident, edges)`
returns a size **multiplier** of `NODE_RADIUS` per node id, not a radius, so the model stays
unit-free. It takes max(degree size, core size), never a blend. Degree size is
`min(2, 1 + 0.15·log2(1 + degree))`: 1.15× for 1 link, 1.24× for 2, 1.3× for 3, 1.6× for 15.
Core size is `1 + 2·0.62^hops` out to 4 hops: 3×, 2.24×, 1.77×, 1.48×, 1.3×. The BFS starts from
every core node at once, so its first visit to a node comes from the nearest core, which gives
the "closest influence wins" rule for free. It walks edges both ways whatever `directed` says.
The two curves are tuned against each other: under the max rule, a node's own degree size hides
any core boost smaller than it. Steepen the degree curve and the far hops of every fade disappear
(at 0.18 gain / 0.55 falloff, hop 4 was invisible in a chain).
`graph.js` owns a lazy size cache behind `sizeOf(id)` and a `revision` counter. Every mutation
calls `changed()`, which bumps the counter and drops the cache: add/remove node or edge, `load`,
and the new `setCore(id, value)`. **Flip `is_core` through `setCore`, never by assignment**,
or nothing resizes. Sizes are derived, never saved, and the payload shape is unchanged.
Recompute measured 0.2–0.3 ms at 3000 nodes and ~6 ms at 20k (cold).
`graphView.js` keeps `shown` (id → drawn multiplier). `update()` notices a `graph.revision` change
by itself and eases `shown` toward `sizeOf` (τ = 0.12 s, settled in ~0.5 s), so no caller has to
tell the view that sizes moved. A connect or a core toggle calls no view method at all.
`writeMatrices()` is now the single place that writes instance matrices, halo positions and halo
scales. `syncNodes()` and easing both go through it, and it still nulls the mesh bounds (a star
that grows past its old bounds would otherwise be culled). It skips ids that are not in the model,
since easing can run between a model edit and the caller's sync. New nodes appear at their target
size. **`sync()` now snaps sizes** and is meant only for wholesale replacement (`applyPayload`):
files reuse ids like `n1`, and a node that merely shares an id with the previous map must not
grow out of that map's size. Edits call `syncNodes()`/`syncEdges()` instead, and `deleteNode`
was switched to that so neighbours ease down. New `view.radiusOf(id)` returns the drawn radius
in world units. `pickNode` tests against it, and `NODE_PICK_BIAS` is now 2 of the hit node's own
radii rather than a fixed length, because a core hides more of its edges. Halos are 1.35 drawn
radii (`HALO_AT`).
`physics.js`: each body carries `collide = COLLIDE_RADIUS · sizeOf(id)`, set in `seed()` before
`simulation.nodes()`, which is when forceCollide reads and caches it. Link rest length is
`LINK_DISTANCE + collideA + collideB − 2·COLLIDE_RADIUS`, which keeps the same 34-unit gap between
collision shells for any pair; a flat 60 would have collide and the spring fighting around every
big node. Both use the target size, not the eased one. Both are only read at seed time, so
`toggleCore` calls `physics.invalidate()`, as does every structural edit.
`interaction.js`: the node menu is built per node, clockwise from the top: Connect, Edit,
Mark core / Unmark core, Delete. Core goes in the bottom wedge because the side wedges
(~60 px) are too narrow for "Unmark core", and Edit and Delete keep the sides they had.
The HUD appends `· core`. A double-click stacking onto a node offsets by
`view.radiusOf(anchor) + NODE_RADIUS`, so the new node still sits in front of a big one.
Verified: 33/33 Node unit tests on the rule and the invalidation paths. Headless, 33/33 against the
real view and physics, covering:
- instance scales equal `sizeOf` and are symmetric over hops;
- easing is partial after one frame and does not snap;
- same-pulse-instant renders show each star's lit footprint growing 2.5× at the core, then
  1.8×, 1.45×, 1.2× over the hops, with the hop-5 ends unchanged;
- a pick that missed a plain node hits the core, and the halo scales with the node;
- looking straight down a chain, the node still beats edges that pass through it;
- unmarking restores sizes, and an edge-only edit resizes with no view call;
- a load snaps a reused id, and a save round-trip keeps sizes;
- a core hub's neighbours settle ~106 vs ~74 units out, with no overlaps, and a core toggled
  mid-run is picked up;
- easing costs 0.17 ms/frame at 3000 nodes and idle costs nothing; still 1 draw call for nodes.

A full-app run, 17/17, drives the real input handlers with pointer lock faked. It spawns and links
a chain through the menu, checks the four wedge labels, arms and commits Mark core, checks
`· core` in the HUD, checks that the crosshair picks n1 at an offset that missed before, then
unmarks and balances. Sessions 4b (39/39) and 3 (14/14) still pass. Test harness gotcha:
SwiftShader frames can outlast a 150 ms wait, so wait on `requestAnimationFrame` counts,
not wall-clock time.
**Deliberately not built:** no colour or other visual marker for core nodes beyond size.
Session 9 owns colour, via `instanceTint`.

**Session 6 — Bloom + skybox** — done (2026-09-10)
Selective bloom via Three.js layers (nodes only, not labels/UI). Subtle nebula skybox.
Since 4b the stars already draw their own glow, and their cores saturate. Keep bloom light, or
the ray detail gets washed out. The layer goes on the mesh inside `allocate()`. The star shader
is the dominant GPU cost (see 4b), and three.js's stock selective-bloom example renders bloom
objects **twice** (darken-others pass, then the full scene). Render the star mesh once into its
own target and bloom/composite from that instead, or the worst case goes from ~9 ms to ~18 ms.
Since session 5 a core star is 3× the radius, so it covers 9× the pixels of a base star at the
same distance. The worst case, one star filling the screen, is unchanged, because the shader
fades stars out within 2.5 radii.
*Done when:* nodes glow, labels/UI don't, background reads as "expansive" without being distracting.
*Landed:* `bloom.js` is new and now draws the whole frame: `main.js` calls `bloom.render()`
where it used to call `renderer.render`. `createBloom(renderer, scene, camera, { strength,
scatter })`, plus `STAR_LAYER = 1`. **The star mesh is on `STAR_LAYER` only** (set in
`allocate()`), and the camera stays on layer 0, so anything that renders the scene outside
`bloom.render()` does not see the stars unless it calls `camera.layers.enable(STAR_LAYER)`. The
old test suites needed that one line. Picking is unaffected: `pickNode` is analytic, and the
edges are on layer 0. Each frame:
1. Camera to `STAR_LAYER` alone, `scene.background` lifted out, clear to transparent black,
   stars into `starTarget`.
2. Bloom down and back up the chain.
3. Layer 0 onto the canvas.
4. One full-screen composite adds stars + `strength` × bloom on top, additively.

The stars are drawn exactly once. **The split is exact only because nothing in the scene writes
depth and the stars are additive.** Adding them last equals drawing them in place, bit-for-bit
to within 2/255 (tested). So the star light is added over *everything* on layer 0; see the
session 8 note. The canvas is drawn last and in one go. It is multisampled, and the first
version (canvas first, then the offscreen passes, then back) cost ~0.9 ms more at 2560×1600
from storing and reloading the samples. `starTarget` is 8-bit sRGB at drawing-buffer size, with
no depth buffer, and it clips at white like the screen. Half-float measured ~0.3 ms slower,
since three full-screen passes touch it. The six bloom levels are half-float, starting at half
res: a 13-tap Jimenez downsample, then a 3×3 tent upsample blended as `mix(level, tent,
scatter)` via `ONE, ONE_MINUS_SRC_ALPHA`. The composite `texelFetch`es the star texel and
quantises to 8 bits with a per-pixel dither, which is exact and unbiased, and adds nothing where
there is no light. Otherwise bloom on a near-black ground bands. Targets follow
`renderer.getDrawingBufferSize()` every frame, so there is no resize wiring and pixel-ratio
changes are caught. Camera layers, clear colour/alpha, `autoClear` and `scene.background` are
all restored after the frame.
**No brightness threshold, on purpose.** `UnrealBloomPass` was not used: its blur truncates its
Gaussian at ~1σ, which gives square halos around point lights, and its high-pass is a hard gate.
A custom thresholded version bloomed a distant star with 17–25% flicker at 1 px radius, and it
switched on and off below that. The star's sub-pixel core makes its sampled peak swing with
every sub-pixel move, and a threshold amplifies that. Now all displayed star light blooms at
`STRENGTH = 0.3`, which looked the same as the thresholded version while flying. With
`SCATTER = 0.5`, anything past ~0.6 fills a dense map with grey haze. Bloom now varies no more
than the star itself under sub-pixel motion, and the test fails the thresholded version (40% vs
7%).
**Known limit, not bloom's:** the star shader point-samples a sub-pixel core, so a star's
*linear* light varies ~7% as it moves at 1.2 px radius. The display's clip at white hides most of
it. The fix belongs in the star shader: below a pixel, widen and dim the core the way `rayFamily`
already does for rays.
`skybox.js`: `createSkybox(renderer)` returns `{ object, dispose }`. The nebula is procedural
(domain-warped simplex fbm). It has a galactic band, the great circle square to `BAND_NORMAL`,
with dust lanes, a faint spine glow, and sparse wisps elsewhere, in blue/teal with rose patches.
It is baked **once at startup** by a `CubeCamera` into a 1024² sRGB cube, ~25 MB of GPU memory,
taking ~75–140 ms on an M3. A render-target cube is sampled with the plain world direction; only
image cube maps need three.js's x flip (verified to 0.55°). The sky is a unit box turned by the
view rotation only and pinned to the far plane with `.xyww`, with `depthTest` off. It is opaque,
so it draws first and paints every pixel, and it is dithered. Over it sit 6500 sky-star points,
crowded toward the band, with a point size of at least 2 device px (smaller points twinkle as
the view turns). The PRNG is seeded (`random.js`), so the sky is identical every session and
works as a compass. `scene.background` is now `null`, and `renderer.setClearColor(VOID_COLOR)`
is only the fallback. `scene.js` exports `VOID_COLOR`.
`dust.js` replaces `starfield.js` (deleted). A skybox at infinity shows turning but never
travel, and an empty map had nothing else to read motion from. It holds 1400 faint motes in one
1600-unit cell, which the vertex shader tiles around the camera (`mod`), so there is dust
anywhere in space. Motes fade in from 760 units, are full by 180, and fade out again inside 12.
Sky, sky stars and dust are all on layer 0, so none of them bloom.
**Cost**, measured on an Apple M3 with Metal at 2560×1600, single pass vs pipeline:

| Scene | Single pass | Pipeline |
|---|---|---|
| Empty map | 0.3 ms | 2.3 ms |
| Spawn distance | 0.7 ms | 3.0 ms |
| 180-node map, inside | 5.5 ms | 6.4 ms |
| 180-node map, overview | 4.9 ms | 6.1 ms |
| 3000-node overview | 4.9 ms | 5.7 ms |
| One star filling the screen (worst case) | 9.8 ms | 11.1 ms |

So there is a fixed ~2 ms in near-empty frames and ~1 ms in real ones. About 0.6 ms of the
fixed cost only appears with the MSAA canvas, inside ANGLE; fewer bloom levels and folding the
composite into the scene render both measured no better. Sky and dust cost ~0.25 ms. ANGLE's
Metal timer queries are useless here, reading ~12 ms per stage. Later runs on this machine were
up to 2× noisier (mediaanalysisd and Godot were sharing the GPU), so compare like with like.
Verified: a new headless suite passes 20/20. It covers:
- star layer only, including after growth past 256;
- the canvas pass leaves stars out;
- bloom off matches the old single pass within 2/255;
- stars drawn once per frame, and state restored afterwards;
- bloom lights the sky out to 8 radii, fades with distance, and is round, not boxy;
- edges, halos, the pending line and the sky give a bit-identical frame through the pipeline
  (nothing but stars blooms), and a scene background stays out of the star pass;
- resize and pixel-ratio changes;
- sub-pixel flicker;
- the sky samples the true world direction, not a mirror, and the brightest sky star lands at its
  projected pixel;
- the band is ~1.9× brighter than its poles;
- dust is present at 10⁶ units out;
- no console errors.

Sessions 5 (33 + 33), 4b (39) and 3 (14) still pass. The full-app run (17) passes on the Vite dev
server and on the production build served by Flask. The UI is HTML, so it was never in the
canvas.


**Session 7 — Edge visuals** — done (2026-09-11)
Dust-particle drift along connections, fog-based opacity fade with distance/depth.
Under the bloom pipeline (session 6): edges are on layer 0, so they are drawn in the
canvas pass and never bloom; fog or depth fades there work as usual. Anything moved onto
`STAR_LAYER` is drawn into `starTarget`, which has no depth buffer, and it must be additive.
Only put drift particles there if they are meant to glow.
*Done when:* dense connection areas stay readable instead of turning into a solid mess of lines.
*Landed:* `edges.js` is new and owns everything about edges. `graphView.js` builds it with
`createEdges(graph, root, renderer, radiusOf)` and delegates `syncEdges`, `updateEdgePositions`,
edge hover and edge picking to it, so the view's public surface is unchanged. Edges are one
`LineSegments2` named `'edges'` plus one `Points` named `'edge-drift'`, both on layer 0. Both are
instanced per edge. There are three draw calls for the whole graph: stars, edges and motes.
**The line material is a `LineMaterial` whose shaders are replaced by our own** (`EDGE_VERTEX`/
`EDGE_FRAGMENT`, derived from three's screen-space line shader). It stays a `LineMaterial` because
`LineSegments2.raycast` reads `material.linewidth`/`worldUnits`/`resolution`, and its
`onBeforeRender` keeps `resolution` current. `resolution` is **CSS px** (`renderer.getViewport`),
not device px, so every width here is CSS px. The old code seeded it with `getDrawingBufferSize`,
which was wrong by the pixel ratio until the first frame; both line materials are now seeded
from the viewport. The shader drops dashes, world units, vertex colours and caps.
Four things make dense areas readable, all in the shader:
- **Width follows distance.** It is the width a 1-unit-wide line would have at that depth,
  clamped to 1–2.5 px, with each end tapered separately. Below 1 px the line is drawn at 1 px,
  with its strength scaled by `sqrt(true width)`. The square root is deliberate: linear
  coverage faded a whole map seen from outside down to almost nothing.
- **Depth fog relative to the map.** The fog runs from the near side to the far side of the
  edges' bounding sphere as seen from the camera (`fogRange` uniform, set each frame in the
  lines' `onBeforeRender`). It never starts inside 200 units and always spans at least 800,
  and it bottoms out at 0.25. The first version used a fixed 220–1600 unit range, and that
  wiped out the overview. Relative fog shows near-over-far from inside the map and from
  outside it, so session 10's zoom-to-fit needs no fog work.
- **Endpoint fade.** Each end fades out from 2.4 to 1.1 drawn radii of its node, so edges
  emerge from the glow instead of meeting in the core. That knot at hubs was the worst clutter.
- **Hover.** The hovered edge ignores width falloff and fog, and is drawn 3.5 px wide in the
  hover colour.
Per-edge data is one `InstancedBufferAttribute` `instanceEdge` = [from radius, to radius, drift
phase, seed], shared by both geometries. The seed is a hash of the edge id, plus 1 if the edge is
`directed`. **The radii are the eased drawn radii.** `edges.writeRadii()` runs from `easeSizes`,
`snapSizes` and `sync`; forget it after a new size path and the fade zones stay at the old size.
The hover colour used to be painted into vertex colours. Now it is a `hovered` uniform (edge
index or −1) compared against `gl_InstanceID` in both shaders. The module holds the hovered
**id** and re-resolves the index on every `sync`, so hover survives a sync that renumbers
edges. Before, it was silently lost, because interaction only calls `setHover` on a change.
**Drift:** the motes read the lines' own `instanceStart`/`instanceEnd` interleaved buffer, so
physics uploads one buffer for both. The drift geometry is an `InstancedBufferGeometry` with 16
point slots per edge; `position.x` is the slot index. There is one mote per 40 units of length,
and the last one fades in with the fraction, so an edge that stretches gains motes smoothly.
An undirected edge carries a stream each way, on alternate slots, and the return stream has a
per-edge offset so paired motes don't all cross at the midpoint. A directed edge carries one
stream, from→to. There is no UI for `directed`; only files set it, and anything that flips it
must call `syncEdges`, because the flag lives in the seed. Speed is 9 world units/s whatever the
length, **so the phase is integrated on the CPU** (`phases`, Float64, `% 1`). A phase computed
as `clock·speed/length` would jump every mote whenever physics changed a length. Phases carry
across `sync` by edge id. Motes are 1.2 units wide (1.5–6 px, fainter by area below 1.5),
additive, `renderOrder` 0.5 (after the normally blended lines), and fog out between 150 and 700
units. A mote with no light is moved outside the clip volume, so it costs no fragments.
`hash32` moved from `graphView.js` to `random.js`, where both modules share it.
**Cost** (M3, Metal, 1280×800 at pixel ratio 2, full bloom pipeline): with 179 edges the edge
layer is within noise; with 4428 edges it is 0.1 ms in overview and 0.4 ms inside a cluster.
On the CPU at 3000 edges: `syncEdges` 2.9 ms, drift update 0.06 ms/frame, `updateEdgePositions`
0.15 ms. Unrelated to edges: 3000 unsettled nodes, viewed from inside a 100-node cluster, cost
38 ms/frame, and nearly all of it is overlapping star billboards (the 4b star shader).
Verified: a new headless suite, 28/28, covering:
- strength matches width × coverage × fog within 15% from 80 to 1400 units;
- fog range equals the sphere-based formula; the near side of a map seen from 2600+ units is
  barely fogged, and its far side sits at the floor;
- the end fade matches smoothstep(1.1r, 2.4r) within 0.12, and grows with a core's eased radius;
- hover is warm, wider and strong at 1400 units, survives a renumbering sync, and clears with
  its edge;
- a far 1 px edge is still pickable, and 119/119 edges pick at their midpoints after a settle;
- motes drift both ways (undirected) or from→to (directed), at 9 u/s for 200- and 400-unit
  edges; stretching an edge moves them continuously; syncing another edge leaves them in place;
- motes fog out by 800 units and take the hover colour;
- an edge through the camera plane is trimmed with nothing stray;
- widths are CSS px (twice the device px at pixel ratio 2);
- 2 layer-0 draw calls at 3000 edges; no console errors.

Earlier suites still pass: sizing 33, session 3 load 14, 4b stars 39, session 5 core 33,
session 6 bloom 20, and the full app 17 on both the dev server and the production build under
Flask. The stars and core suites' draw-call expectations went from 2 to 3 (the drift draw).
Visual tuning used before/after frames on the real GPU: a 40-spoke hub, and a 400-node,
754-edge clustered map from inside, from the overview and from far out.
The suites live in session scratchpads, not the repo. The latest full set, each file headed
with what it covers, is in
`/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/b78463be-4c5b-45c4-a351-66080c8aed10/scratchpad/`
(`e2e_*.mjs`, `sizing.test.mjs`, `edges_look.mjs`, `perf_edges.mjs`). They expect Vite on port
5180 and Playwright's Chromium builds under `~/Library/Caches/ms-playwright`. `/private/tmp`
does not survive a reboot.
**Deliberately not built:** no minimum visible length. An edge shorter than ~2.2 radii of its
ends draws nothing, and one shorter than ~4.8 never reaches full strength. Its two stars'
glows overlap there anyway, and the old line was hidden under their cores too. Motes do not
bloom.

**Session 8 — Labels** — done (2026-09-11)
In-scene sprite-based labels (not HTML overlay — get depth-occlusion and bloom-exclusion for free). Always-on for high-degree/core nodes, proximity-reveal for the rest.
`graph.sizeOf(id)` already combines degree and core influence into one number, which makes it the
natural always-on threshold. Offset each label by `view.radiusOf(id)` (the drawn, eased radius)
so it clears big stars.
Under the bloom pipeline (session 6): layer-0 labels are never bloomed, but the star
composite is added over everything after the canvas pass. A star's glow will therefore lie over
any label it overlaps, even one in front of it, and depth written by labels does not reach the
star pass. If that hurts legibility, draw labels as a fifth step in `bloom.render()`, on their
own layer, onto the canvas after the composite. That keeps the canvas in one pass, so it costs
no MSAA reload, and labels then sit above star light.
*Done when:* flying toward a small node reveals its label at a reasonable distance; big/core nodes are always legible.
*Landed:* `labels.js` is new. `graphView.js` builds it with `createLabels(graph, root, renderer,
{ radiusOf, baseRadius })`, the way it builds the edges. The view's surface changed in three ways:
- **`view.update(seconds, camera)`** now takes the camera about to draw the frame. Without one, no
  labels are drawn, which is what every older test suite gets.
- `setHover` passes the hovered node on to the labels.
- `sync()` resets them (a load that reuses an id must not inherit a mid-fade label).

`view.labelsShown()` lists what the last update put on screen: id, text, opacity, side, and the ink's
rect in CSS px. The tests use it, and search/jump-to could.
Label text is `node.label`, **read every frame** and compared by value, so an edit shows with no call
anywhere. Whitespace collapses to one line, and anything past 496 raster px (~28 characters) is cut
with `…`. A node with an empty label draws nothing; ids are never shown in the scene.

**The rule.** Size is the drawn (eased) radius over `NODE_RADIUS`, so it follows `graph.sizeOf`
as it eases. From `ALWAYS_ON_SIZE = 2` a label shows at any distance: every core (3×), each
core's direct neighbours (2.24×), and nodes at the degree cap. Below that, `revealRange(size) =
200·size³` world units, fading in across its outer quarter: 200 unlinked, 304 at one link, 440 at
three, 820 at fifteen, 1110 two hops from a core. The plan offered `sizeOf` as a plain threshold.
Continuous range is used instead because a threshold low enough to catch "high-degree" (1.6× is 15
links) also catches every node two hops from a core. The hovered node's label shows at any range,
in the hover amber. A label fades out between 3 and 1.5 drawn radii from the camera, i.e. while
flying through its star.

**On screen.** Font size is 0.45 drawn radii at the node's depth, clamped to 11–15 CSS px, or 12–17
for landmarks. So near labels grow with their star and far ones stay legible. Landmarks use a
brighter ink (`#eaf0fa` vs `#b4c0d2`). The ink's top sits 1.5 drawn radii + 3 px below the star's
projected centre, which clears the core, the glow and the hover ring. The offset is in screen px
from the projected centre, so labels are always upright and never roll with the camera.

**No overlaps (declutter).** Every frame, candidates are placed greedily into a 64 px bucket grid, in
this order:
1. the hovered node;
2. landmarks, **by size first** (so a core beats a closer core neighbour);
3. everything else;
4. ties by apparent size (drawn radius / depth), with ×1.3 for a label already on screen, as
   hysteresis.

A candidate that would overlap a placed rect (+4 px clearance) is not placed. Losers fade out
(τ 0.1 s) rather than vanish. **Only landmarks** may fall back to above their star. In dense patches
a small label above one star reads as belonging to the star over it (tried and seen). Sides are
sticky: a label on screen that loses its side fades out, and only from zero may it come back on the
other, so nothing ever jumps.

**Drawing.** One `Mesh` named `'labels'` over an `InstancedBufferGeometry` quad, one draw call,
`MAX_LABELS = 512`. The CPU computes each label's screen box; the vertex shader only projects the
node and adds the px offset, snapping the quad corner to a device pixel. Per instance:
`labelCentre`, `labelBox` (px offset + size, CSS px, y up), `labelRect` (atlas UV), and
`labelStyle` (sRGB ink + opacity). Instances are packed each frame with update ranges. Colours are
**sRGB, written without colour management**, with premultiplied `ONE, ONE_MINUS_SRC_ALPHA` blending,
so they match browser text's gamma-space blend. Session 9 can tint labels by writing
`labelStyle.rgb`. **The mesh is on `LABEL_LAYER = 2`** (exported from `bloom.js`), and
`bloom.render()` gained **step 5**: that layer is drawn onto the canvas after the star composite.
Still the canvas, so no MSAA store/reload. Star glow never lies over a label, and labels never
bloom (tested: fully covered glyph pixels keep the exact ink over a core star; nothing changes
outside the ink). Nothing writes depth, so a nearer star does not hide a farther label: labels
are always on top. The dark halo keeps them readable there.

**The atlas.** One 2048² `RGFormat` `DataTexture` (8 MB, plus mips). R holds glyph coverage and G the
halo's. It is allocated with `source.dataReady = false` and `data: null`, so WebGL zero-fills it
and no 8 MB zero buffer lives in JS; `renderer.initTexture` uploads it once at creation. Cells are
128×48; a label takes 1–4 side by side in one row, 16×42 cells in all. Cell edges fall on
multiples of 16, so mips 0–4 never bleed between cells. Text is rasterised at 32 px (500-weight
system sans) into one of four scratch canvases, one per span. The halo is stroked in green, then
glyphs are added in red with `'lighter'`. Each is copied into its cells with
`renderer.copyTextureToTexture`. Four traps here:
- **`copyTextureToTexture` only uses `texSubImage2D` from a canvas when the source texture has never
  been seen by the renderer** (`properties.has(src)` is false). The scratch `Texture`s must never be
  rendered with, or it silently takes a framebuffer-blit path instead.
- `atlas.premultiplyAlpha = true` is set **after** `initTexture`. The copies then take the
  canvas's premultiplied values as is, which are the coverages exactly. Unpremultiplied, the
  browser would divide both by alpha, and a partly covered halo pixel would read as fully covered.
- three regenerates the whole mip chain on every copy with `generateMipmaps` set. `flushRasters`
  clears it for every copy but the frame's last, then sets it back to true. It has to be true at
  the first upload, or only one level is allocated and mip sampling reads black.
- Rasterising is capped at 24 labels a frame, so flying into a dense patch spreads over frames.

When no run of cells fits, labels not drawn this frame are evicted, least recently shown first.
Tested: 2000 labels were cycled through (>400 of them distinct on screen, far beyond capacity),
and the first came back pixel-identical.

**Cost.** Measured on an M3 with Metal at 2560×1600, full pipeline, labels vs. every label blank.
The GPU difference is within noise on every scene, 149 labels included. CPU layout is 0.03 ms for a
180-node map and 0.12–0.4 ms at 3000 nodes. It is O(N) per frame over labelled nodes (one
projection each), plus a sort of the candidates.

**Verified:**
- A new headless suite, `e2e_labels.mjs`, passes 35/35. It covers:
  - the reveal curve against smoothstep, and the first sight when flying straight in (~200);
  - one link carrying the label further; a core and its hop-1 neighbour at 5000 units, hop 2 not;
  - glyph pixels inside the reported rect; the gap following the eased core radius both ways;
  - stacked labels showing one, apart labels showing both, and the loser fading;
  - hover beyond range in amber, beating a core, which goes above;
  - edits, whitespace, empty labels, truncation, deletes, and a load reusing ids;
  - drawing over a star; no bloom; one draw per frame; layers restored; pixel ratio 2 in CSS px;
  - no overlaps in a 300-node map; raster batches of 24; eviction; cost.
- The full-app run, now 22/22, names a node through the real Edit wedge and finds the amber label
  under the crosshair, on both the dev server and the production build under Flask.
- Earlier suites still pass: sizing 33, session 3 load 14, stars 39, core 33, bloom 20, edges 28.
- Look frames (`labels_look.mjs`, real GPU, dpr 2) were judged for a single node, a chain close
  and far, and a 400-node clustered map from inside, approaching, overview and far. All eight core
  labels show in overview and far.

The suites are in `/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/3f3fe800-929f-4f27-8a14-045408e6fbe9/scratchpad/`
(same conventions as session 7's; `perf_labels.mjs` is the cost script).
**Deliberately not built:**
- Edge labels are not drawn in the scene (the HUD still shows one on hover). The atlas and
  instancing would take them as another entry kind at the edge midpoint.
  **Superseded by session 11**, which did exactly that.
- No key to toggle labels.
- No occlusion of labels by nearer stars.
- No LCD/subpixel text: the atlas is grayscale coverage by construction.

Everything above about how a label **looks and is placed** (font, size range, the ink colours, the
gap under the star, one draw call) was replaced by the redesign below. The reveal rule, the
priority order, the fade, and the atlas machinery are still as described here.

**Session 8b — Label redesign, "star chart"** — done (2026-09-12)
The session-8 labels read as UI stuck on top of the scene: system sans in a hard dark outline,
centred under the star, and clamped to 11–15 px, so a near name and a far one looked the same
size and nothing said which star a name belonged to. Asked for a redesign that belongs to the
galaxy, and for **size to follow distance**. Four directions were drawn over real label-free
frames from the renderer (`label_directions.html` in the scratchpad, flip 1–5) and the star-chart
one was chosen, with one pale ink, angled callouts, dimming with distance, and a richer hover.
*Done when:* a name reads as belonging to its own star in a crowded field, and the lettering looks
like part of the map rather than an overlay.
*Landed:* `labels.js` only. `graphView.js` is untouched, and so is the view's surface, but
`view.labelsShown()` now also reports `tier`, `dim`, `fontPx`, `clean`, `align` and the leader's
three corners.

**The type.** Jost (a geometric, Futura-like face), bundled with `@fontsource/jost` and imported
**by `labels.js` itself**, so every entry point and every test gets the face without knowing about
it. Canvas 2D falls back silently, so the module waits on `document.fonts.load`, then re-reads its
metrics and drops every raster once, to redraw in the real face.
Three tiers, not two:
- **core** — `node.is_core`, read from the model and not from the eased size, so capitals never
  flicker while a star grows. Set in capitals, 500 weight, 0.26 em tracking, ink `#eef2fa`.
- **landmark** — drawn size ≥ `ALWAYS_ON_SIZE`. As typed, 0.09 em, ink `#dde5f2`.
- **plain** — as typed, 0.09 em, ink `#c2ccdb`.
Hover is still amber, and opens the tracking another 0.04 em (a re-raster, but only ever one
label). Capitals carry the top tier, so colour is left free for session 9's clusters.

**Size and strength follow distance.** Font size is 0.7 drawn radii at the node's depth, clamped
to 10–26 px plain, 11–28 landmark, 12–30 core. The range is wide on purpose: it is what pairs a
name to its star before the leader is even followed. Distance also drains a label, 1.0 down to
0.58 as the size falls from 18 px to the floor, with cores never under 0.75 — the same idea as the
edge fog, so far names sit behind near ones instead of competing.

**The callout.** A leader leaves the star at 45°, turns level for an 8 px shelf, and the name sits
5 px past the end of it, middle on the shelf. It starts 1.5 drawn radii + 3 px out (clear of the
core, the glow and the hover ring) and lengthens a little with the star. Quadrants are tried
down-right, up-right, down-left, up-left, and a label on screen **keeps its quadrant**: if it is
taken, the label fades out and may only pick another from zero, so a name never jumps.
Two passes:
1. a clean spot — the whole name on screen and clear of **every other star**;
2. failing that, the least bad quadrant, fewest stars under the name, edge overhang allowed.
Dropping the name instead would leave the biggest star on screen anonymous. `shown()` reports
which pass won as `clean`. Every star on screen is indexed each frame into the same 64 px buckets
as the labels (discs pooled, ≥ 3 px only, a stamp so one disc is not counted twice for one rect).
This was the one real defect the first cut had: without it, "QUARTERLY PLAN" lay straight across
its neighbour's star, which look frames showed immediately and no test would have.

**The halo** is no longer a stroked outline. The glyphs are drawn twice into the halo channel with
5 px and 12 px blurs and composited at 0.62, a soft fall-off that reads as the dark between stars.

**The atlas** grew for the bigger type: 40 px rasters, 128×80 cells (25×16 = 400 of them), up to 6
cells a label, 14 px of padding. 740 raster px of text before the `…`, about 30 characters at
plain tracking and fewer in capitals. Everything else — the copy path, the premultiply trap, the
one mip rebuild a frame, 24 rasters a frame, eviction by least-recently-shown — is unchanged.

**Drawing** is now two calls, not one. A second mesh, `'labelLeaders'`, instances one quad per
straight run (two per label) on the same `LABEL_LAYER`, with `renderOrder` 0 under the names' 1.
Both ends are CSS px from the projected node centre, so a leader keeps its shape at any distance;
the vertex shader builds the quad and overhangs each end by half a width to fill the elbow, and
the fragment shader feathers the edge, since this pass has no MSAA.

**Cost.** 3000 labelled nodes: 0.152 ms a frame against 0.147 ms with every label blank. Star
indexing means every node on screen is now projected, labelled or not, which is where the extra
work went; it is still far inside the 2 ms budget.

**Verified:**
- `e2e_labels.mjs`, rewritten for the redesign, passes 34/34: the reveal curve and first sight;
  tiers and their casing; size falling monotonically with distance to a floor, and the nearer of
  two stars carrying the bigger name; the dimming curve and the core floor; the callout's geometry
  (start distance, 45°, level shelf, name centred on it); stacked stars turning their callouts to
  different sides; a crowd where a name that loses its spot fades rather than vanishes; hover
  (amber, undimmed, wider, past range); edits, whitespace, empty, truncation, deletes, loads;
  exact ink over a bright star; no bloom; two draw calls; pixel ratio 2; a saturated 300-node map
  (nothing overlapping, clean names off every star) and an ordinary spread (nearly all clean);
  raster batches, eviction, cost.
- Every other suite still passes: app 22/22 (dev **and** the production build under Flask on
  :5001, where the bundled font loads with no failed requests), sizing 33, load 14, stars 39,
  core 33, bloom 20, edges 28.
- Look frames (`labels_look.mjs`, real GPU, dpr 2) judged across three rounds: a single node,
  hover, a chain close/mid/far, and a 400-node map from inside, approaching, cluster, overview
  and far.

The suites and the direction mock are in
`/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/d8f9f30e-c910-447c-a0fb-f4b3ee1df677/scratchpad/`
(`backdrop.mjs` captures label-free frames plus each star's screen position, which is what the
mock draws over).
**Deliberately not built:**
- A sticky quadrant is never re-judged: a name that landed on a least-bad spot keeps it until it
  fades for another reason, even if a clean one opens up. Re-picking risks the jitter the
  stickiness exists to prevent.
- A leader's bounding box is kept off other names and leaders, but it may still cross an edge.
- Leaders do not fade along their length, and nothing shortens them when a star is near the edge.

**Session 9 — Clustering** — done (2026-09-12)
Louvain integration, cluster-centroid attraction force, stable color mapping across re-balances.
*Done when:* re-pressing Balance regroups nodes by connection density without cluster colors jumping around randomly.
*Landed:* `clustering.js` is new and pure (no Three.js), like `sizing.js`. It adds
`graphology` + `graphology-communities-louvain` to `frontend/package.json`.
`computeClusters(nodes, edges)` returns `{ colors, count }`.

**What is stored on a node is a colour id, not a community id.** Louvain's community
ids are arbitrary and unstable — the same graph partitioned twice names the same
group 3 one run and 7 the next — so each run matches its new communities against
the colours the nodes are *already wearing*, by shared node count. Claims are
sorted strongest-first and taken greedily, one colour per group, which gives the
split rule for free: the larger piece has the larger overlap, claims the colour
first, and only the smaller piece has to take a new one. Leftover groups take the
lowest colour nobody claimed, so ids stay small however many re-balances a map has
been through. Because the previous colours are the input, calling it twice over an
unchanged graph is a **no-op that does not even bump the revision**.
Colour id **0 means no cluster**, and is not a palette entry: a lone node, and every
node in a map that has never been balanced. `MIN_CLUSTER_SIZE` is 2, so an isolated
node stays 0 rather than turning a sparse map into confetti. The rng is seeded
(`LOUVAIN_SEED`) and **built fresh inside each call** — a generator kept across runs
would make successive partitions of one graph drift apart.
The palette is 12 hues at S 0.70 / L 0.76, pastel because a cluster colour multiplies
a star's whole glow *and* is the label ink. The order is front-loaded for separation
between the first few, since most maps have a handful of clusters. **Sky blue (210)
is deliberately not first**: an unclustered star is already tinted blue→white→warm, so
a blue cluster reads as "no cluster", and up close, where the core saturates toward
white, it stops reading as a colour at all. Look frames showed cyan (180) surviving that
and 210 not. It is kept, but late.

`graph.js` — `recluster()` is the **only** writer of `cluster_color_id`, plus
`graph.clusterCount`. It is deliberately **not** wired into `changed()` the way sizes
are: Louvain is ~15 ms at 3000 nodes against the size BFS's 0.2 ms, and a partition
that shifted the instant a node was connected would recolour the map out from under
someone still building it. `load()` recovers `clusterCount` from the file's own
colours without re-partitioning — a reopened map keeps the clusters it was saved with.

`physics.js` — `forceCluster()`, `CLUSTER_STRENGTH` 0.12, registered as
`simulation.force('cluster', …)`. `start()` calls `graph.recluster()`, so **Balance is
what re-partitions**; `invalidate()` deliberately does not, or a node added mid-settle
would recolour everything at 40%. `body.cluster` is set in `seed()` but read *per tick*,
not cached at initialize the way `collide` is.
**The load-bearing detail is the single-cluster guard**: if fewer than two clusters have
bodies, the force returns without doing anything. With one group there is nothing to
separate and the pull only compacts the map, fighting `forceCenter` and squeezing every
link inside its rest length. Without it a core hub's neighbours settled 92.5 units out
against a 102.1 rest length and session 5's suite failed on it. With it, a map that is
one cluster — or none — lays out exactly as it did before clustering existed.

`graphView.js` — `writeStar` no longer writes the tint; `targetTint(id, colorId, out)`
does. **An unclustered node's tint is bit-identical to before** (same hash, same
blue→white→warm ramp), which is why session 4b's suite still passes untouched. A
clustered node takes its cluster's hue lifted toward `TINT_WHITE` by that same hash, so
stars inside one cluster still vary instead of reading as N copies of one dot.
`shownTint`/`targetTints` are keyed **by id, never by slot**, so a swap-remove cannot hand
a node another node's colour. `refreshTints()` rebuilds targets wholesale on any revision
change (a hash and a lerp per node — cheaper than working out who moved) and `writeTints()`
puts the drawn values in the attribute. `easeSizes`/`snapSizes` are now
`easeAppearance`/`snapAppearance` and carry the tint too, at `TINT_EASE` 0.3 — slower than
the size ease, because a recolour is a bigger change and drifting over a third of a second
reads as the map settling rather than a flicker. New `view.tintOf(id)`.

`labels.js` — `inkFor(tier, colorId)` mixes the cluster hue *into* the tier's ink at
`CLUSTER_INK_MIX` 0.45 rather than replacing it, so the tiers stay apart by brightness and
the ink stays readable over the soft dark halo. The leader is written from the same colour
and follows by itself. Hover stays amber, so the one label under the crosshair is never
mistaken for a cluster colour. `labelsShown()` gained `cluster`.
`interaction.js` — the HUD reads `balancing NN% · N clusters`. README updated.

**Cost:** re-partition 14–20 ms at 3000 nodes / 12k edges (10 ms on a second run), and it
finds all 60 planted communities. The tint retarget-and-ease frame is 1.1 ms at 3000 nodes.
GPU cost is unchanged — the star shader is untouched and only the values in `instanceTint`
differ.
**Verified:** `clusters.test.mjs` 37/37 (pure: the partition, stability across re-runs, a
real split of one clique into two and the merge back, isolated nodes, persistence, palette,
cost) and `e2e_clusters.mjs` 44/44 against the real view, physics and labels (clusters
separate with every node on its own side and no interpenetration; tints reach the instance
attribute and match the cluster's hue on screen; a recolour eases and lands; the
single-cluster guard; three groups keep every colour across three more Balances; a new node
joins a group without recolouring the others; label ink carries the cluster hue and is not
darkened against no cluster at all; save/reopen; cost). Every earlier suite still passes:
sizing 33, load 14, stars 39, core 33, bloom 20, edges 28, labels 34, app 22 on the dev
server **and** 22 on the production build under Flask on :5001.
Look frames (`clusters_look.mjs`, real GPU, dpr 2) judged over two rounds on a 132-node,
6-community map — overview, far, between two clusters, inside one, labels and hover. The
palette reorder above came out of round one.
Suites are in `/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/872efa37-50c3-4497-9872-41d95a7e9502/scratchpad/`.
**Two traps for whoever writes the next headless suite**, both of which cost a cycle here:
instance matrices are float32 while the model's positions are float64, so matching a node to
its slot by position needs a *nearest* test, never equality; and stars, edges and labels are
on layers 1, 0 and 2, so sampling a star's glow or a label's ink means rendering that layer
**alone** — an edge crossing the sample is more saturated than a glow and brighter than a glyph.
**Deliberately not built:**
- Edges take no cluster colour. Intra-cluster edges could, but `edges.js` dropped vertex
  colours in session 7 and its shader has no per-edge colour attribute.
- No manual colour override, and no UI for clustering at all beyond Balance.
- More than 12 clusters wrap the palette and share hues.
- A star's core saturates toward white at close range whatever its tint, so cluster colour
  reads in the glow and rays rather than in the core.

**Session 10 — Overview mode** — done (2026-09-12)
Tab toggles to `OrbitControls` with zoom-to-fit; toggles back to locked flight cleanly.
Under the bloom pipeline (session 6): `createBloom` captured the camera at
creation. Drive the same `PerspectiveCamera` with `OrbitControls`, or give the pipeline a way to
switch cameras. It sets and restores `camera.layers` every frame.
Edge fog (session 7) needs nothing here: it is recomputed every frame from whichever camera is
rendering and the edges' bounding sphere, so a zoom-to-fit view gets near-over-far shading of
the whole map by itself.
Labels (session 8) are laid out by `view.update(seconds, camera)` for whichever camera it is
handed, so pass the one that renders. `labels.js` assumes a **perspective** camera: depth is
view-space −z, and px per world unit is `0.5 · height · projectionMatrix[5]`. An orthographic
overview camera would need its own scale there. The hovered label follows `view.setHover`, so an
overview with no crosshair should clear it.
*Done when:* Tab reliably switches both directions with no camera glitches.
*Landed:* `overview.js` is new: `createOverview({ camera, canvas, graph, view, controls })` →
`toggle`, `update(dt)`, `refit`, `dispose`, `isActive`, `isOrbiting`, `target`, `distance`. It drives
the **same** `PerspectiveCamera` as flight, as the note above advises, so bloom, edge fog and labels
all needed no work at all. `interaction.js` owns the Tab binding, for the same reason it owns save
and open: only it knows whether a modal surface is up.

**Flight is never disabled on the way in, deliberately.** Every flight input path already gates on
`controls.isLocked`, and `releaseAll` runs on the unlock event, so flight is inert the moment the
lock goes. That also dodges an ordering trap: `pointerlockchange` arrives as its own task, so
`interaction.onUnlock` → `endModal()` re-enables flight *after* anything the enter path disabled.
For the same reason `mode` is set to `'entering'` **before** `controls.unlock()` — the overlay,
click-to-lock and the HUD all key on `isActive` and must already see the new mode when the unlock
event lands.

**A fresh `OrbitControls` per activation, disposed on exit.** Tab pressed mid-drag would otherwise
leave a captured pointer in its `_pointers` and a live damping delta for the next activation to act
on. Its constructor runs an `update()` of its own against a target of (0,0,0), which turns the
camera toward the origin; setting the real target and updating again puts it back, both well before
a frame is drawn. The orbit is held `POLAR_MARGIN` (0.12 rad) off both poles: `lookAt` with a world
up of +Y is degenerate looking straight down, and **`PointerLockControls` rebuilds the camera
orientation from a YXZ euler on every mouse move**, which silently discards any roll the orbit left
behind — that shows up as a snap on the first twitch of the mouse. The suite pins it with a
zero-delta `mousemove`: the quaternion must not move at all.

**The fit is of the silhouette, not a bounding sphere — and this is the one defect the look frames
caught that no assertion did.** A sphere's radius is set by the map's longest axis, and fitting that
against the *narrower* field angle is conservative twice over: a wide, flat map came out filling
under half the screen, and the first version of the suite called that "tight" at 0.45 of the half
frame. Now each node is a sphere of `STAR_REACH` (2) of its drawn radius, and the distance is the
max over nodes of the per-axis tangent conditions, ×1.12. Node centres land ~0.67 of the half frame
on purpose — a label hangs well outside its node's own reach, so driving centres to the edge would
push edge labels off screen. The cost, accepted: a long map can leave the frame once the orbit turns
away from the arrival direction; the wheel is there. The suite guards the regression by comparing
the fitted distance against what a sphere fit would have asked for (< 0.8×), not against the frame
edge. Direction is straight back from where the camera already is, so the map stays on the side of
the user it was on; pulling back along the *view* direction instead would swing them to the far side
of it whenever they happened to be looking away. Floors: never closer than 6× the largest drawn
reach, or 60 units, because the star shader fades a star out within 2.5 of its radii. An empty map
does not move the camera and orbits a point 260 ahead of it.

The flight out is 0.45 s, smoothstepped, position lerped and orientation slerped, in `update(dt)`
called from `main.js` **after** `flight.update` — it overwrites flight and any stray mouse move on
purpose, because the lock takes a moment to actually go. `refit()` runs on a successful open: the
payload restores a camera pose of its own, and an orbit still targeting the previous map would drag
it straight back off. `B` balances from the overview, which is the natural place to watch a layout
settle. The HUD reads `overview · N nodes · M edges · Tab to fly` — the overlay is hidden there, so
the HUD is the only thing saying how to get out. `main.js`: the unlock handler keeps the overlay
down while `isActive`, click-to-lock and Enter are suppressed there, and `pointerlockerror` now
unhides the overlay too, since the notice lives inside it. **Chrome's ~1.25 s re-lock cooldown is
the one failure left**: Tab back then lands unlocked on the notice and a click flies.
**Cost:** one `OrbitControls.update()` a frame while up; the fit is two O(V) passes, once per
activation.
**Verified:** `e2e_overview.mjs` 51/51 — the flight out and its partial first frame, the fit (every
node framed, tighter than a sphere fit, aimed at the target, no roll), orbit drag/dolly and both
distance clamps, the handoff back (camera steady, a zero-delta move that does not snap, then a
0.2 rad look for a 100 px move), straight overhead as the degenerate `lookAt`, Tab mid-drag, six
toggles in a row, labels and the bloom pipeline from the orbit camera, Balance from the overview,
re-framing on open, a single node, and an empty map. `e2e_app.mjs` is now 31/31 on the dev server
**and** on the production build under Flask — its pointer-lock fake was upgraded to a switchable
one, so Tab there really does release the lock and really does ask for it back. Every earlier suite
still passes: sizing 33, load 14, stars 39, core 33, bloom 20, edges 28, labels 34, clusters 37 + 44.
Look frames (`overview_look.mjs`, real GPU, dpr 2) judged over two rounds — the first round is what
showed the sphere fit was too loose. Suites are in
`/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/bc972ded-139e-48fd-b773-74843d6b77cb/scratchpad/`.
**Deliberately not built:**
- No key to re-frame while in the overview. Tab leaves; after arrival the orbit is yours.
- Nothing is pickable there — no crosshair, no hover, no radial menu. It is for seeing the map and
  getting somewhere, and `view.setHover(null)` falls out of the existing unlock path.
- The orbit target is fixed at the fit, so a Balance run that moves the map's centre does not
  re-centre it.
- No orthographic overview: `labels.js` assumes a perspective camera for both depth and its px
  scale.
- Tab does not remember where flight was. Coming back leaves the camera where the orbit ended,
  which is what makes the overview a way of travelling rather than just a look.

**Session 11 — Edge labels** — done (2026-09-12)
`edge.label` has been editable since session 1 and readable only in the HUD on hover ever since;
session 8 left it undrawn on purpose. Now a connection's name is set **along its own line**, so it
reads as belonging to the connection rather than to either star. Asked for: names on the lines,
revealed nearer than a star's.
*Done when:* a named connection reads as named, and a map of them is still a map of stars.
*Landed:* `labels.js`, plus one line of `graphView.js` (`setHover` hands labels the whole target,
not just a node id, so either kind under the crosshair is shown). `edges.js` is untouched.

**Two entry kinds in one module.** Names and connection names share the atlas, the raster cache,
the eviction, the fade, the declutter buckets and both draw calls. `entries` is keyed `'n:<id>'` /
`'e:<id>'` — **not** the bare id, because a loaded file's node and edge ids are whatever was in it
and need not come from two namespaces. Only a **labelled** edge is projected at all (a cheap string
test first): most edges carry no text and a map may hold thousands. 600 labelled edges cost
0.36 ms/frame, inside the 2 ms budget.

**A fourth tier, not a fourth rank.** `EDGE` sits alongside plain/landmark/core in every
tier-indexed array (`MIN_PX` 9, `MAX_PX` 18, ink `#9fb0c6`, tracking 0.12 em, weight 400). It is
quieter and smaller than any star's name because it labels the line *between* two things that are
already named. Tracking is a shade wider than a star's: a small, dim face needs it to stay readable
lying along a line.

**The reveal is deliberately tighter than a star's, and never always-on.** `edgeRevealRange(size) =
140 · size²`, `size` being the larger of the two endpoints' drawn sizes: 185 units for a plain
pair, 1260 for a core's connections. A core's *own* name shows at any distance; its connections do
not, or an overview turns into a page of prose. The look frames are what settle this: a hub at 230
units names 4 of its 8 spokes and a 6-link chain at 330 units names none. That is the rule working,
not failing — raise `EDGE_REVEAL_BASE` if more reach is wanted.

**Room along the line.** `edges.js` fades an edge out within 2.4 radii of each star, so only the run
between the two glows is available to write on; it must hold the ink plus 6 px of air at each end,
or the name is not drawn. This is what keeps a name off a connection seen nearly end-on, which is a
few pixels long however far apart its ends really are. **The hovered edge is exempt**, and that
exemption is load-bearing: without it a name came and went with the foreshortening, which reads as
a fault rather than a rule. Seen *exactly* end-on both ends land on one pixel and there is no
direction to set a name along — under the crosshair it is then set level, otherwise skipped.

**Never upside down.** The screen direction is flipped to `dirX >= 0`, so a line drawn either way
reads the same and a line straight up the screen is read bottom-to-top, as a chart sets a meridian.
Because `dirX >= 0` always holds, the perpendicular `(dirY, -dirX)` always points up the screen,
which is how the ink gets its 7 px offset to the upper side with no special cases.

**The shader turns the quad.** One new instance attribute, `labelTurn` = (cos, sin), `(1, 0)` for a
star's name. **That value takes the original code path untouched**, including the corner-snap to a
whole device pixel that lands text texel-for-pixel; the turned path skips the snap on purpose,
since a turned name has no pixel grid to land on. Session 8's 34 assertions pass unchanged, which
is the check that the star path really is bit-identical. The anchor is the edge's **world
midpoint**, so the GPU projects it and the CPU supplies only px offsets — exactly how a star's name
already worked.

**Declutter.** A connection's name reserves the axis-aligned box of its turned ink (a little more
than it covers — the buckets are axis-aligned) and goes into the same grid as the stars' names. It
has **one** placement, on its line, so there is no quadrant search and no stickiness: if the spot is
taken it waits. Priority is `0.5 × baseRadius / depth`, under every star's name, so a contested spot
goes to the star — visible in the hub frame, where the four unnamed spokes lost to star names.
`clean` means the same as for a star: whole on screen and off every star, its own two ends included.

**No leader** — the line is the leader, and `shown()` reports `kind`, the `angle` in degrees and the
ink's centre for an edge, the leader's corners and side for a star. **Two shapes from one array**:
whoever reads it next should branch on `kind`.
**No cluster hue**: `clustering.js` gives edges no colour, and a name in one cluster's colour on a
line between two clusters would be a lie. Hover stays amber, line and name together.

**Verified:** a new suite, `e2e_edge_labels.mjs`, 23/23 — riding the line (angle, the upper-side
offset, the ink really turned in pixels, glyphs inside the reserved box), never upside down in four
directions, the reveal curve and a core's longer reach, hover (past range, undimmed, and end-on),
the room gate, edits/whitespace/truncation/clears/deletes/a file reusing an edge id, no overlap
between the two kinds, one instance and no leader, one draw each per frame, and cost. Every earlier
suite still passes: labels 34, sizing 33, load 14, stars 39, core 33, bloom 20, edges 28,
clusters 37 + 44, overview 51, and app 31 on the dev server **and** 31 on the production build under
Flask on :5001. Look frames (`edge_labels_look.mjs`, real GPU, dpr 2): a pair plain and hovered, an
8-spoke hub head-on and angled, a chain at three distances, and a settled 90-node/6-cluster map from
overview, approach and inside.
Suites are in `/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/e8dfb082-146f-4063-b050-560f5f22d39e/scratchpad/`.
**Deliberately not built:**
- No toggle for connection names, and no way to show them all regardless of range.
- A name may still cross an edge *line* (only stars and other names are kept off it).
- Text does not curve or follow a bent line; there are no bent lines.
- A connection whose name will not fit is simply unnamed; nothing shortens or stacks it.

**Deferred (v2+):** search/jump-to-node, adjustable connection strength, manual color override, undo/redo.

## Non-negotiable across all phases

No filler/marketing copy anywhere in the UI — labels, buttons, empty states are functional text only.

## Added Features

Post-launch changes made in response to real usage rather than the original session plan above.

**Edge repulsion (declutter)** — done (2026-09-12)
Reported against `too-close-example.png`: a small, densely-interconnected group (8 people, 15
connections) read as a tangle after Balance — lines crossing through the middle, no way to tell
which connection went where. The existing cluster-centroid force (session 9) could not touch this:
it only pulls a cluster's *own* nodes together, and does nothing when the problem is a handful of
nodes that are already one cluster (or none) but too densely cross-linked to read.
*Asked for:* nodes still want to be close; the *lines* repel.
*Done when:* the too-close case opens up into something a connection can be traced through, without
clusters that were already reading fine coming apart.

*Landed:* one new force in `physics.js`, `forceEdgeRepel()`, registered alongside `forceCluster` in
the same `simulation.force(...)` set. An edge has no body of its own in the simulation, so what
actually repels is a phantom point at each edge's midpoint, recomputed every tick from its live
endpoints. Phantoms are run through a real `forceManyBody` — **the same Barnes-Hut octree the node
charge force already uses**, not a hand-rolled spatial structure — and each phantom's resulting push
lands on *both* of its edge's real endpoints equally, so a repulsion between two edges translates
each line bodily rather than stretching it. A dense cluster's own edges cover the space it occupies,
so their combined repulsion also happens to push a rival cluster's edges out of that space, but that
falls out of edge density; nothing here reasons about cluster membership. `EDGE_REPEL_STRENGTH`
(-40), `EDGE_REPEL_RANGE` (220 units) and the softening floor `EDGE_REPEL_MIN` (4) sit at the top of
`physics.js` next to `CLUSTER_STRENGTH`; it reuses `CHARGE_THETA` for its own Barnes-Hut opening
angle rather than adding a fourth.

**The false start, kept as the reason it's built the way it is:** the first version used a uniform
spatial grid (bucket by `EDGE_REPEL_RANGE`, check the 26 neighbouring cells) reasoning that
rebuilding an octree every tick cost more than it saved. It didn't hold up: fed the exact transient
this force exists to fix — many edges' midpoints landing in the same small region — a flat grid
degrades toward brute force exactly when it's needed most, since it doesn't adapt to density the way
Barnes-Hut does. Caught with a synthetic 3000-node/12,059-edge cost run: per-frame cost climbed
frame over frame (80 ms → 204 ms → 459 ms → 979 ms) instead of settling. Rebuilt on `forceManyBody`
itself (phantom bodies through the same octree, `.distanceMin`/`.distanceMax`/`.theta` already
built in) and the same run went flat at 48–80 ms instead of climbing — still the most expensive
scenario tried, but bounded, and one nobody has actually asked this app to hold (12k edges over
3000 nodes only ever existed before as a Louvain-cost fixture, never run through physics).

**Verified:** an 8-node/15-edge fixture matching the reported shape — minimum real 3D gap between
any two non-adjacent edges went 2.0 → 51.8 units, edges reading as touching or crossing (< 5, < 20
units) 2 → 0 and 1 → 0. A 6-cluster/180-node map did not regress (minimum inter-cluster gap
320 → 345 units) and its own tangle count fell too (22 → 3 crossing-like, 149 → 20 near). A 12-spoke
hub still settles spokes at even distances (79.9–81.1 units), comfortably past the link's own rest
length (69.2), so a sibling pair at a hub repelling each other under this force reads as the spokes
fanning out more evenly rather than fighting `forceLink`. Realistic-scale cost, nodes spawned near
existing neighbours rather than uniformly at random (the shape a map actually grows in): 180 nodes
2.3→3.3 ms/frame, 800 nodes 7.1→7.7 ms, 1500 nodes 8.1→22.0 ms — all well short of a freeze.
Session 9's own suite, `e2e_clusters.mjs`, still passes 43/44 unchanged; the one exception is a
pixel-brightness sample in a synthetic two-complete-8-node-clique fixture whose hardcoded 90-unit
camera distance was tuned against the old, tighter clique geometry — a fully-interconnected clique
legitimately spreads out more now (there is no 3D arrangement of a complete graph that removes all
edge crossing, so this force just gives it more room), confirmed by a direct screenshot the star is
still lit and correctly coloured, and confirmed the same assertion passes again at 140 units.
Suites are in
`/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/7f98f91b-63fd-491a-ae75-a69ca0c97ca5/scratchpad/`.
**Deliberately not built:**
- No exemption for edges sharing an endpoint — tried, measured no need for one.
- No UI or toggle for this; it runs whenever Balance does, same as clustering.
- Does not attempt to fully untangle a complete graph (a clique's edges cannot all avoid each other
  in any straight-line drawing); it only gives such a knot more room to sit in.

**HTML export (`Ctrl+E`)** — done (2026-09-12)
*Asked for:* a key that writes the map out as a `.html` file with no password, which someone else can
fly around and `Tab` through exactly as normal, with every editing option gone. View only.
*Done when:* a file lands on the desktop, opens by double-clicking with no server anywhere, reads as
the same map, and cannot be edited.

**The feature rests on one fact that was checked before anything was built:** Chrome grants pointer
lock to a `file://` document. Flight is the whole point and it is pointer-locked, so if that had
failed the answer would have been drag-to-look, not this. Measured on the identical page from
`file://` and over http, and all four came back the same: pointer lock **granted**, WebGL2, a
data-URI woff2 through `document.fonts`, and an inline `<script type="module">` that runs. That last
one is why the build ships an ES module rather than an IIFE.

*Landed:* `viewer.js` is a second entry point — `main.js` with everything that can change a graph
left out. It does not import `interaction.js`, `editor.js`, `radialMenu.js`, `files.js` or
`physics.js`, so **an export is view-only by construction rather than by a flag**: there is no
setting to switch back on, because the code is not in the file. `viewerInteraction.js` is the
read-only half of `interaction.js` — crosshair targeting, the HUD readout and `Tab`, and nothing
else. It is a separate module for the same reason; a `readOnly` flag on `interaction.js` would have
shipped every edit path inside every exported file.

`palette.js` is new and is the one change the *app* needed. `graphView.js` and `labels.js` want
`clusterInk` to draw a colour, but it lived in `clustering.js`, which imports `graphology` and
`graphology-communities-louvain` — so reading a cluster's colour dragged Louvain into the render
path. The palette moved out whole (it imports nothing); `clustering.js` keeps `computeClusters`.

**`graph.js` still imports `computeClusters` statically and hands it out as `recluster()`, so it
cannot be tree-shaken**, and the viewer never re-partitions anything. `vite.viewer.config.js`
therefore aliases `./clustering.js` to `clustering.stub.js`, whose `computeClusters` throws — it is
unreachable by construction, and if it ever fires, something in the viewer has started trying to
re-partition a map it is only meant to display. Worth the six lines: it is **135 kB** of a 592 kB
bundle. Bundle shares, attributed from the sourcemap by *generated* bytes rather than by
`sourcesContent` length: three.js 471 kB (66.5%), AtlasMap's own src 85 kB, the graphology stack
~97 kB, the d3-force stack ~49 kB.

The build is now three steps (`npm run build`): the app, then the viewer into `.viewer-build/`, then
`scripts/build-viewer.mjs`, which folds that into one self-contained
`server/static/viewer-template.html` with two `__ATLASMAP_*__` holes in it. The assembler inlines the
script and the stylesheet and turns every remaining `url()` into a data URI, then **fails the build
if any outward reference survives** — a template that quietly reaches for a server would otherwise
be discovered by whoever received the file, offline, with no way to report it.

`Ctrl+E` (`interaction.js`, beside `Ctrl+S`/`Ctrl+O` and `preventDefault`-ed the same way) calls
`files.exportHtml`, which fetches that template, fills the two holes and downloads the result through
the existing `triggerDownload`. No new Flask endpoint: `static_url_path=""` already serves it, and
`vite.config.js` proxies the one path through in dev. Exporting is deliberately **not** a save — it
adopts no filename and no password, and touches no session state.

**Four traps, all of which cost something here:**
- **`String.replace` with a string pattern honours `$&`, `$'` and `` $` `` in the *replacement*.** The
  minified bundle and the map's own JSON are both full of those sequences. Every splice, in
  `files.js` and in the assembler, passes a replacement **function** instead.
- `viewer.js` originally held the marker as an `UNFILLED` constant to detect a template that was
  built but never exported. That put a **second** copy of `__ATLASMAP_PAYLOAD__` in the bundle, and
  `replace` fills only the first — which happened to be the right one only because of tag order in
  `viewer.html`. The constant is gone: an unfilled template is not JSON, so it already reads as "no
  map" through `JSON.parse` failing.
- `<` in a label would close the JSON's `<script>` tag early; it goes out as `<`, which is the
  same string to any parser. The bundle's own `</script` occurrences are escaped as `<\/script`,
  which is safe because the sequence can only legally occur inside a string, a regex or a comment.
- @fontsource names a woff2 **and** a woff for every face and the build inlines both. That is
  **75.2 kB** of base64 per exported file for a fallback no WebGL2-capable browser will ever read;
  the assembler drops the alternative and keeps the primary.

**An export opens in the overview**, zoomed to fit, rather than at the author's camera — whoever
opens it did not build it, and the author's last position can perfectly well be pointed at empty
space. The saved pose is still where the opening 0.45 s move starts, so it still says where the map
was being looked at from. **Node `notes` are stripped from the payload** (`files.exportPayload`):
the file is plaintext by necessity, the viewer has no editor panel to show notes in, and private
working text is the wrong thing to put in a file meant for sending. Everything else travels — labels,
structure, positions, core flags, cluster colours and connection names.

**Cost:** the template is 638 kB (js 578.5, css+fonts 58.6); a real 24-node map exports to 644 kB.
The app bundle grew 726.2 → 727.3 kB.

**Verified:**
- `export_e2e.mjs` 28/28 — drives the live app on Flask with real pointer lock, spawns a map, presses
  `Ctrl+E`, captures the download, then reopens that exact file from `file://`. It asserts both
  markers were filled, no `/assets/`, no external script or stylesheet, `notes` absent from every
  node while label/position/core survive, the title taken from the map name, that it opens in the
  overview, that `Tab` hands over to locked flight — and that double-click, the right-hold menu
  gesture, `Ctrl+S`, `Ctrl+O` and `B` all do nothing at all. Crucially it also asserts the page makes
  **zero network requests of any kind**, which is the real claim the feature makes.
- `save_open_regression.mjs` 13/13 — `files.js` was rewritten wholesale to add the export, and it
  owns the only persistence the app has, which no export test touches. Full round trip against the
  real crypto endpoints: `Ctrl+S` through the password panel, the bytes checked for the `ATLM` magic
  and version byte, then `Ctrl+O` the same file back and the graph returns.
- `viewer_render.mjs` — a synthetic 24-node/42-edge map in three clusters, spliced in the same way,
  judged from real frames at dpr 2 (`rich_overview.png`, `rich_flight.png`). Stars, rays, bloom, the
  nebula, three cluster hues, cores drawn larger with capitalised names, angled leader callouts,
  depth-fogged edges and edge labels riding their lines all render from `file://`, with 0 page errors
  and 0 external requests. The app-driven suite only ever managed four bare nodes, so this is what
  actually covers edges, labels and colour in the viewer.

**Trap for the next suite, and it cost a cycle here:** Chrome refuses pointer lock to a document that
is **not frontmost**, and throws `WrongDocumentError: The root document of this element is not valid
for pointer lock` doing it. It looks exactly like an app bug. Headed Playwright needs
`page.bringToFront()` before the click that locks. Confirmed by control: the same gestures with no
`Ctrl+E` anywhere reproduced it unfocused and were clean focused.
Suites are in
`/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/5432f80e-6e72-4451-9445-fa57a40f9a47/scratchpad/`
(`filetest.mjs` is the `file://` capability probe; `mapsize.mjs` attributes bundle bytes to packages).
**Deliberately not built:**
- No Balance in the viewer. The layout is frozen exactly as exported, which is what lets the whole
  physics and clustering stack stay out of the file.
- No password and no encryption on an export — that is what makes it openable by double-clicking, and
  it is why notes are dropped. The `.atlasmap` file remains the thing that keeps everything.
- The viewer cannot export, open or save anything, so an export is a leaf: it never makes another.
- No way to read notes, no search, and no option to open at the author's camera instead of the fit.
- The template is a build artefact, so `Ctrl+E` needs the server the app is already being served
  from; it is not an offline action in the editor, only in the result.
- Nothing reduces an exported file's size for a large map beyond the JSON itself — three.js is 471 kB
  of every export whether the map holds four nodes or four thousand.

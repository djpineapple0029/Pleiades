# AtlasMap

3D galaxy-style mind mapping tool. Design and build order: `atlasmap-build-plan.md`.

## Setup

```
uv sync
cd frontend && npm install
```

## Development

Two processes. Flask serves the API, Vite serves the frontend with hot reload and
proxies `/api` through to Flask:

```
uv run python -m server        # http://127.0.0.1:5001
cd frontend && npm run dev     # http://localhost:5173  ← open this one
```

## Production-style run

```
cd frontend && npm run build   # writes server/static/
uv run python -m server        # http://127.0.0.1:5001
```

`ATLASMAP_HOST` and `ATLASMAP_PORT` override the Flask bind address. Port 5000 is
taken by AirPlay Receiver on macOS, hence 5001.

## Controls

Click the viewport to take pointer lock. Everything below happens while locked —
the lock is never released for a menu or an edit.

| | |
|---|---|
| `W` `A` `S` `D` / `Space` / `Shift` | fly |
| mouse | look |
| double-click in open space | new node at the crosshair |
| hold right button | radial menu on the targeted node or edge; move the mouse to pick a wedge, release to run it |
| left-click a node while connecting | link it |
| right-click / `Esc` while connecting | cancel |
| `B` | balance: re-group the map by connection density and run the force layout until it settles, or stop a run in progress |
| `Tab` | overview: fly out until the whole map is in frame and orbit it with the mouse; press again to fly from where the orbit left off |
| `Ctrl`/`Cmd` `S` | save to a `.atlasmap` file |
| `Ctrl`/`Cmd` `Shift` `S` | save under a different name or password |
| `Ctrl`/`Cmd` `O` | open a `.atlasmap` file |
| `Ctrl`/`Cmd` `E` | export a view-only `.html` anyone can open |
| `Tab` / `Enter` / `Esc` in the editor | next field / save / cancel |

`Esc` also drops pointer lock, since browsers reserve it; click to fly again.
Opening a file drops it too: the file dialog is a native window, so the browser
would take the lock away regardless.

`Tab` is the way out of being lost. The camera flies back until the whole map is
in frame, then the mouse orbits it: drag to turn, right-drag to pan, scroll to
zoom. It pulls straight back from wherever you were, so the map stays on the
side of you it was already on. This is the one mode that gives the pointer back,
so there is no crosshair and no radial menu in it — `Tab` again takes the lock
and flies on from wherever the orbit left the camera, which is how the overview
gets you somewhere rather than just showing you where you are. Balance still runs
from here, which is the natural place to watch a layout settle. If the browser
refuses the pointer straight away it is the re-lock cooldown; click to fly.

Balancing runs in the render loop a few ticks at a time, so flying, targeting and
editing all keep working while the layout settles; the HUD shows how far along it
is. Editing the graph mid-run reheats the simulation so the change gets settled
in too.

The node menu is Connect (up), Edit (right), Mark core / Unmark core (down) and
Delete (left). A node's size is the larger of two things: its link count (more
links, bigger, up to 2×) and its distance from the nearest core node. A core
node is 3×, and the boost fades over the next four hops (2.24×, 1.77×, 1.48×,
1.3×). Sizes update as soon as the graph changes, and Balance spaces bigger
nodes further apart.

Balance also groups the map. It looks for communities — sets of nodes that link
to each other more than to the rest — pulls each one together toward its own
centre, and gives it a colour that its stars and their labels carry. The HUD says
how many it found.

Those colours are stable. A cluster that is still recognisably the same cluster
keeps the colour it had, so re-balancing doesn't reshuffle the map; only a
genuinely new cluster, or the smaller half of one that split, takes a new
colour. Nodes that belong to nothing — anything unconnected — keep the plain
star colour, and a map that has never been balanced has no cluster colours at
all. Colours are saved in the file, so a reopened map looks the way you left it.

Edges thin with distance and fade toward the far side of the map, so nearby
connections read over the ones behind them. Each edge fades out into the glow of
the nodes it joins. Motes drift along every edge: both ways on an undirected
edge, from → to on a directed one. The edge under the crosshair is drawn wider,
in amber, at full strength whatever its distance.

A node's label (set with Edit) is drawn under its star. The bigger the star, the
further its label carries: an unlinked node's shows within 200 units, one with a
link within 300, three links 440, fifteen 820. Core nodes, their direct
neighbours and nodes at the degree cap are labelled at any distance, a little
brighter and larger. The node under the crosshair always shows its label, in
amber. Labels never overlap. Where two would, the nearer or more important one
stays and the other fades out; a core's label moves above its star rather than
lose its place. A node with no label shows nothing.

A connection's label (set with Edit on the line) is written along the line
itself, at its midpoint, turned to follow it and never upside down — a line
running straight up the screen reads bottom to top. It is smaller and quieter
than a star's name and has no leader, because the line is one. It also carries
less far: a plain pair show theirs within 185 units, a core's connections within
1260, and none of them show from an overview. The connection under the crosshair
always shows its label, in amber, even out of range. Where a connection's name
and a node's would collide the node's wins and the connection's waits, and a
connection with no room left between its two stars is left unnamed.

## Files

Maps are encrypted `.atlasmap` files that live wherever you put them — there is
no server-side folder and nothing is stored between sessions.

The first `Ctrl+S` asks for a filename and a password, twice; after that saving
is one keystroke. **The password is the only key.** It is held in memory for the
session, never written anywhere, and there is no recovery path — a file whose
password is lost is lost, which is why the first save asks you to confirm it.

Saving is a download and opening is an upload, so the browser's own dialogs
decide where files go. Re-saving writes a new file rather than overwriting in
place; save over the same name to keep one copy.

```
bytes 0-3    magic "ATLM"
byte  4      format version
bytes 5-20   salt, 16 random bytes, fresh on every save
bytes 21+    Fernet token over the JSON payload
```

The key is PBKDF2-HMAC-SHA256 over the password, 600,000 iterations. Those
parameters are pinned by the version byte, not stored in the header: changing
them means bumping the version, or every existing file stops opening.

## Exporting a map to share

`Ctrl+E` writes the map as a single `.html` file. Whoever you send it to opens it
by double-clicking: no server, no install, no password, and nothing fetched from
the network. It is one self-contained file of about 640 kB plus the map itself.

They get the map as you see it — stars, sizes, cluster colours, labels, edges and
their drift motes, the nebula — and the same two ways of moving: click to fly with
`W` `A` `S` `D`, `Space`, `Shift` and the mouse, and `Tab` to orbit the whole map.
It opens on the overview so the first thing they see is all of it.

They cannot change it. The export is view-only by construction rather than by a
setting: the code that can spawn, connect, edit, delete, re-balance, save or open
is not in the file at all, so there is nothing to switch back on. The layout is
frozen exactly as exported — there is no physics in it to move anything.

**Two things worth knowing before you send one.** The map inside is plain text,
readable by anyone who has the file; there is no password and no encryption, which
is what makes it openable at all. And **node notes are left out of the export** —
they are the one field that never leaves your `.atlasmap`. Labels, structure,
positions, sizes, cluster colours and connection names all travel.

Exporting changes nothing about the session: it is not a save, and it does not
take the filename or the password. The `.atlasmap` file is still the thing that
keeps everything.

## Layout

```
server/               Flask — file I/O, encryption, static serving. No graph logic.
server/atlasfile.py   the .atlasmap container: framing, PBKDF2, Fernet
server/api.py         POST /api/save, POST /api/open
server/static/        Vite build output (generated, gitignored)
frontend/src/         Three.js frontend — owns the graph entirely
frontend/src/files.js payload assembly, the two calls, download and upload
frontend/src/sizing.js node size rule: degree size, core-influence BFS
frontend/src/clustering.js  Louvain communities, and the colour that stays with a cluster
frontend/src/edges.js  edges and drift motes: distance width, depth fog, endpoint fade
frontend/src/labels.js names on stars and along lines: reveal rules, glyph atlas, no-overlap placement
frontend/src/overview.js  Tab: zoom-to-fit, the orbit camera, and the way back to flight
frontend/src/bloom.js  the frame: stars drawn once into their own target, bloomed, added last
frontend/src/skybox.js nebula baked into a cube map at startup, distant stars
frontend/src/dust.js   faint motes around the camera, so motion reads in empty space
frontend/src/palette.js     the cluster colours, split off so drawing one needs no Louvain
frontend/src/viewer.js      entry point for an exported map: the renderer, none of the editor
frontend/src/viewerInteraction.js  the read-only half of interaction.js: hover, HUD, Tab
frontend/viewer.html            the exported page, with two markers files.js fills in
frontend/vite.viewer.config.js  the second build: one chunk, everything inlined
frontend/scripts/build-viewer.mjs  folds that build into server/static/viewer-template.html
```

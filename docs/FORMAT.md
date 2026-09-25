# The `.atlasmap` payload

An `.atlasmap` file is a container around a JSON payload. There are two
separate version numbers, and they never stand in for each other:

| Number                   | Where                                                     | Changes when                                             |
| ------------------------ | --------------------------------------------------------- | -------------------------------------------------------- |
| container `VERSION` byte | `server/atlasfile.py`, `frontend/src/format/container.js` | crypto or framing changes: KDF, cipher, header layout    |
| payload `schema`         | `frontend/src/format/schema.js` (`CURRENT_SCHEMA`)        | the JSON's shape changes in a way that needs a migration |

The byte layout of the container lives in `server/atlasfile.py`'s docstring.
This document is about what's inside once it's decrypted. A machine-readable
version is in [`atlasmap-payload.schema.json`](atlasmap-payload.schema.json).

## Schema 1

```jsonc
{
  "format": "atlasmap", // absent in files written before schema.js existed
  "schema": 1, // absent ⇒ 1
  "app": "0.1.0", // version of the build that wrote it; informational
  "nodes": [
    {
      "id": "n1", // never rewritten: looks and motion are hashed from it
      "label": "",
      "notes": "",
      "links": [], // strings; nothing reads or writes these yet (see below)
      "x": 0,
      "y": 0,
      "z": 0, // finite numbers; a non-finite one refuses the file
      "cluster_color_id": 0, // 0 = unclustered; authoritative on load, never recomputed
      "blend": null, // [r, g, b] faded colour from the last Balance, or null
      "is_core": false,
    },
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "directed": false, "label": "" },
  ],
  "camera": { "position": [0, 0, 260], "rotation": [0, 0, 0] }, // optional
}
```

`modified` is reserved in the envelope but not written. A timestamp inside an
encrypted file is harmless, but nothing needs it yet.

## Rules

1. **New fields are optional, with a stated default.** A reader that finds one
   missing uses the default; it never refuses the file for it.
2. **A field is never repurposed.** A name keeps its meaning forever. A
   different meaning gets a new name.
3. **Renames and restructures go through a migration.** Bump `CURRENT_SCHEMA`
   and add `MIGRATIONS[n]` (schema n → n + 1) in `schema.js`. `migrate()` runs
   before anything is built, so a refusal commits nothing.
4. **Readers keep what they don't understand.** Unknown keys on a node, an edge
   or the top level are carried through load and written back on save
   (`graph.js`'s `passThrough`, `files.js`'s `passedThrough`). Known,
   validated fields always win over a same-named raw value. d3-force's
   `index`/`vx`…`fz` stamps are dropped.
5. **A newer schema is refused**, with "made by a newer AtlasMap (schema N)",
   rather than half-read.
6. **HTML exports are an allowlist** (`format/exportPayload.js`): nodes carry
   `id, label, x, y, z, cluster_color_id, blend, is_core`, and edges carry
   `id, from, to, directed, label`. Notes, links and passed-through fields
   never leave the `.atlasmap`. A new field joins the list only in the same
   change that makes the viewer draw it.

The viewer loads exports through the same `graph.load` → `migrate()` path.

## Open decisions

V2.md §2.3.1 point 5: settle these before V2 features build on them. Until
then, both round-trip exactly as stored.

- **`links`**: always `[]` from this app, read by nothing. The intended use is
  F25 (references with safe opening).
- **`directed`**: rendered (it switches an edge's drift motes to one-way), but
  there's no UI to set it. The intended use is F23.

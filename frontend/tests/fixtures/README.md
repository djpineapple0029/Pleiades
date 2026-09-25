# Golden `.atlasmap` files — never regenerate

Each file here was written once, by the code named below, and committed with
its decoded payload beside it (`<name>.json`). The tests in
`server/tests/test_golden.py` and `tests/unit/golden.test.js` decrypt them and
compare against that JSON. **If one of those tests fails, the format broke** —
fix the code, not the fixture. A missing fixture fails the tests, it never
skips them.

| File | Container | Written by | Password |
|---|---|---|---|
| `twelve.atlasmap` | v1 (Fernet) | the original session-3 app (rescued 2026-09-14) | `open sesame` |
| `v1-known-password.atlasmap` | v1 (Fernet) | `server/atlasfile.encode`, 2026-09-25 | `correct horse ✦ battery` |
| `v2-encrypted.atlasmap` | v2, mode 1 (PBKDF2 + AES-GCM) | `frontend/src/format/container.js` under Node WebCrypto, 2026-09-25 | `correct horse ✦ battery` |
| `v2-no-password.atlasmap` | v2, mode 0 (plain) | same | none (empty string) |

The 2026-09-25 files share one payload: a core node with unicode and emoji
notes, a `blend` colour, a node with notes but no label, a directed labelled
edge, and a camera. The v2 files carry the schema-1 envelope
(`format`/`schema`/`app`); the v1 ones predate it and have none.

This folder is in `.prettierignore` so the JSON stays byte-for-byte as
written. The `.gitignore` negation `!**/tests/fixtures/*.atlasmap` is what lets
the `.atlasmap` files be committed.

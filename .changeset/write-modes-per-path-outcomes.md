---
'@bevel-software/platform-core-backend': minor
---

`write_file` and `write_files` now take a `mode` — `create`, `overwrite` or `update` — and **the default is `create`**, so a write no longer replaces a file by accident. `create` on a path that already exists is refused with `code: 'exists'`, the path, and the argument that would have made it deliberate ("pass mode: overwrite to replace it"); `update` on a path that holds nothing is refused with `code: 'missing'`. A refused path is left exactly as it was, and a successful `write_file` now answers `outcome: 'created' | 'replaced' | 'updated'` beside `path` and `bytes`.

`write_files` answers `{ count, files }`, with one entry per REQUESTED path in the order they were given: `{ path, outcome }` for a path it wrote, or `{ path, outcome: 'refused', error, message }` for one it could not, `count` being how many landed. A path it refuses no longer stops the rest of the batch — the document-format refusal (Office/PDF/email) and the mode refusals are reported per path, with the same explanations as before. A restricted run or a cross-ontology batch is still refused as a whole, because that is a call that should not have been made at all.

The mode is judged with the path's LOCK HELD, so it is a verdict about the state the write really lands on: a `create` cannot replace a file a human editor saved a moment earlier and call it `created`, and an `update` cannot recreate one somebody just deleted. In a batch, a path whose verdict changes under the lock is reported `refused` and left alone while the rest of the batch still lands.

**Behaviour change for existing callers:** a `write_file`/`write_files` call that means to replace a file must now say `mode: 'overwrite'`. A caller that does not is refused rather than silently overwriting, and the refusal names the argument to add.

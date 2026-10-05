---
'@bevel-software/platform-core-backend': minor
---

An overlay seals its own tables with the backfill core uses for its own.

A deployment built on this package declares `encryptedText` and `blindIndexText` columns in its own schema, and until now had to write for itself the step that seals the rows already there. That step is where the encryption can go wrong for good: a first run that takes a typed value for a sealed one leaves it in clear, a run under the wrong key indexes everything under it, a half-finished one is neither. It is now one implementation, exported:

- `runEnterpriseMigrations(db, folder, { piiBackfill })` applies the overlay's history and then seals the tables the spec names, under the same lock.
- `runPiiBackfill(db, spec)` is the step alone, for a database migrated under a lock of the caller's own.
- A `PiiBackfillSpec` names the tables (`PiiBackfillTable`: the key, the sealed columns, the blind indexes and what each is the index of), a `marker` (an index column the SQL history adds nullable), the statements that close it (`finalize`: `SET NOT NULL`, the unique indexes that move onto the index columns) and, when the constraints need room made first, an `afterSealing` step.

The rules are core's own and are not the spec's to choose: one transaction; a first run that trusts no shape; a later run that first checks the key opens what is sealed, and refuses naming the key as the spec calls it (`keyName`); columns read as stored; writes that pin what they read. A spec that would leave its marker nullable is refused and nothing is committed, because the next start would then seal the sealed rows again.

Three things a table of core's never needed. A table may have several blind indexes (`bidx` takes one or a list). An index is there exactly where its source is: a NULL source has no index, where it used to get the index of the empty string, and an index left beside a source that was emptied to NULL is taken away. An empty string is a value and keeps the index the handle itself writes for one. And the key is tried on a sealed value of every sealed column, not of one column per table, so a column that holds nothing cannot let a wrong key through.

Core's own backfill runs through the same function; nothing changes for a deployment that has no sealed columns of its own.

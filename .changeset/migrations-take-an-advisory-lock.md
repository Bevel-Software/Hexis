---
'@bevel-software/platform-core-backend': patch
---

Database migrations now hold a Postgres advisory lock, so two processes starting at once no longer race each other through the same migration history. Drizzle's migrator takes no lock of its own: it reads the newest applied migration and then applies everything after it, so both processes read the same starting point and both apply. With an unguarded migration the second one fails on an already-applied `ALTER TABLE` and its container crash-loops until the first has finished; with a guarded one it instead records a second ledger row for a migration that ran once.

Two processes starting at once is the ordinary case, not an unusual one. A deployment behind a reverse proxy starts the replacement container while the outgoing one is still serving, so every redeploy that carries a new migration has this window.

The lock is held on its own connection for as long as the migration runs, and is released by ending that transaction however the run finishes. A process that cannot take the lock within a minute fails its boot with an error naming the lock, rather than waiting indefinitely — the container's restart policy is the retry, and an upgrade that stalled silently is worse than one that says why.

Nothing about the migration history itself changes, and no schema or exported signature changes: an existing deployment upgrades with no action.

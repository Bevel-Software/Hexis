---
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-core-frontend": patch
"@bevel-software/platform-shared": patch
---

Make failing pushes visible without making them fatal.

A push that fails behind a save used to be a log line at best: the autosave
path swallowed it entirely, and the release path's typed error only reached an
editor that was still mounted. A deployment whose git credential was broken
therefore looked healthy while every commit piled up locally.

The backend now emits a workspace-scoped `git-sync-failed` event whenever a
commit lands locally but its push fails (any path — autosave, release, the
pending-commit worker), and `git-sync-recovered` once when a later push
succeeds. Nothing about the failure handling changes: saves still succeed,
retries and the agent hand-off still run — the events are visibility only.

The frontend shows a banner on `git-sync-failed`: work is saved locally, an
administrator should check the server logs, plus the sanitised git error. It
clears on `git-sync-recovered`.

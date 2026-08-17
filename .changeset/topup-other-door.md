---
'@bevel-software/platform-core-backend': patch
---

Offer the scaffolding top-up on id-addressed workspace resolution too.

`resolveWorkspaceDir`'s on-disk probe registered a previous process's clone
into the branch cache without offering the scaffolding top-up, and the
registration pins the fast path — so a deployment whose boot preflight (or any
direct `/api/workspace/:id` request) resolved the workspace before the first
branch-addressed load sat out every migration for the process lifetime. The
Groups→Plugins rename missed exactly such a deployment. Both doors now make
the same once-per-process offer.

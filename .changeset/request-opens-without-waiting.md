---
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
---

Opening a change request shows it at once. The check against the latest shared version now runs behind the files instead of in place of them, and only when the shared version changed one of the files the request itself changes.

A request used to be brought up to date whenever the shared version held any change it did not — which, on a knowledge base where every save lands there, was true again within minutes of the last time. Opening a twenty-file request that way cost several seconds of merging before a single line appeared, for a change to a file the request did not contain. Now a shared version that moved elsewhere costs nothing, and the files are on screen from the first render. When the two really do overlap, the note "Checking against the latest version…" sits above the files while the merge runs, Approve and Apply wait for it, and afterwards only the files the merge actually changed are read again. Conflicts are reported exactly as before.

Two ways a request could stay behind for good are closed with it. The update now decides whether to push from what the workspace actually holds, so a push that failed is retried the next time rather than skipped as "already up to date"; and the pull it runs first preserves an unpushed merge instead of flattening it, which used to drop the shared version back out of the request's history.

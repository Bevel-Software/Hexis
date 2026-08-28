---
'@bevel-software/platform-core-backend': patch
---

Approving a proposed skill now puts it in the library straight away, instead of making it disappear for up to a minute first. The two halves of the catalog went stale at different speeds: the moment the merge landed the change request closed, so the skill dropped off the review shelf at once, while the released catalog kept serving its pre-merge scan until a 60-second TTL ran out — leaving the card the reviewer had just approved in neither list, and no amount of refreshing brought it back any sooner.

The cause was that a pull rewrites a working tree without going through the write routes or the commit pipeline, so it announced nothing, and a merge lands its result with a pull. Every pull of the default workspace now says so — the merge, the recovery ladder after a push that could not fast-forward, and a plain sync from the remote alike — and the skill, tool-manual and plugin-index caches all listen for that one fact rather than for a list of occasions. A skill pushed from a developer's machine and pulled in appears as promptly as one approved in the UI, and a workspace that had diverged from origin refreshes them when it is reconciled.

These caches also no longer lose a drop that lands mid-read. Each one is filled across an `await`, so an invalidation arriving while a scan was in flight was overwritten by that scan a moment later, restoring the pre-merge list for a further full TTL — which defeated the refresh above in exactly the case it was meant for. A scan that straddles an invalidation now serves its result to the caller who asked for it without storing it, and the next reader re-scans.

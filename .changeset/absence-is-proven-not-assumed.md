---
'@bevel-software/platform-core-backend': patch
---

Absence is proven, never assumed. The deleted-branch sweep now demands a provably fresh branch list (`strictFetch`): the listing's degrade-to-stale behaviour is right for a UI and exactly wrong for an absence proof, where a clone that last fetched before a branch was created would report it missing and close a live change request. A failed fetch now aborts the sweep instead of feeding it stale refs. Deleting a change request whose base branch cannot be resolved answers 409 with the real condition instead of accusing the caller's role. And the connection probe no longer reads a `401`/`403` inside a URL as a credential rejection — a status number in a path proves nothing.

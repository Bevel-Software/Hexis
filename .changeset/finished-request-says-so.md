---
"@bevel-software/platform-shared": patch
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-core-frontend": patch
---

A change request that was applied or closed opens in a finished view: one status line saying how it ended ("Applied by <name> on <date>.", "Closed on <date>. Nothing from it was applied."), no review controls, and for an applied request each file's change as it was applied, read-only from its own verified merge commit, with Open page to the page as it is now. The detail carries a new optional `finished` object (when, the applier's display name, the close reason, the verified merge commit). An open view switches to the finished view when the request is applied or closed. A finished request's detail carries no email address, and an applied request whose apply made no commit of its own still lists the files it proposed (from the source head its apply recorded), without an "as applied" diff. A HEAD on the raw file route answers from a stat behind the same read gate, never reading the file.

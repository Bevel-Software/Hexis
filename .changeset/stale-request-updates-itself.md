---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-core-backend': patch
---

A change request that has fallen behind now brings itself up to date when you open it, and never tells a business user a branch name. Opening an open request whose target has moved on, as its author, an admin, or anyone who may apply it, runs the update by itself — no button, no confirmation. While it runs the dialog says "Bringing this up to date with what everyone sees…" and shows no file content; afterwards it shows the updated files and one neutral line, "Brought up to date with what everyone sees." The update runs at most once per open, never while an apply or another update is in progress, and never on a request that is not open. When it conflicts the dialog says, in plain words, that what everyone sees has changed and the two can't be combined automatically, with the existing prompt for the author's agent, and does not retry. A viewer who may not update the request is told who can.

Updating no longer costs the reviewers their approvals. `POST /workflow/change-requests/:number/update-from-target` now carries every per-file approval forward onto the merge commit for each file whose bytes the merge left alone — git's own diff between the two heads decides which those are — so only the files the update actually changed go stale. This holds for every caller of the route, the dialog, an agent or an older client, and the approval rule itself is unchanged: an approval still counts only against the current head, and the author's own later commit still resets it.

No text in the change-request dialog names the default branch by its git name any more; the deleted-file note reads "Below is the version everyone sees today, which would go." The request's own draft name in the header row is the author's and stays.

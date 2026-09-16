---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

A change request now shows only what its author changed, and says when it needs updating. The request dialog used to read every file's "before" side from the target branch as it stands now, so an edit someone made directly on the target after the proposal appeared inside the proposal as a red deletion — a reader saw another person's edit "removed" by a request whose author never touched it, and feared applying it would undo that edit. The dialog now reads the before side at the request's fork point (the merge base of the proposal and its target), through a new `GET /api/workflow/change-requests/:number/fork-point-file`, which only serves commits on the target's history and checks read access on the target's tree.

When the target holds commits the proposal does not, the dialog says "<target> has changed since this was proposed" and offers Update, which merges the target into the proposal branch on the server and pushes it; the dialog then refreshes and the notice clears. A conflicting Update is aborted with nothing committed or pushed, and the dialog shows the same "ask your agent" conflict help, with the prompt, that a conflicting apply shows. Update is offered to the request's author and to anyone who may apply it; others see the notice alone, and `POST /api/workflow/change-requests/:number/update-from-target` now refuses them with 403 (it previously checked nothing beyond sign-in).

The change-request detail carries three new fields: `mergeBaseSha`, `behind` and `viewerCanUpdate`. The request helpers now resolve both branches on the freshly fetched `origin/<branch>` before any local copy, as `resolvePrShas` always documented: a proposal's own clone holds a local target frozen at the fork, which made every request look up to date. Applying is unchanged.

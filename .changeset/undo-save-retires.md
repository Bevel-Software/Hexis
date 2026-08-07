---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Remove "Undo this save" from the file history view, and the revert
machinery behind it: the `POST /workflow/changes/:sha/revert` endpoint,
`IWorkflowService.revertChange`, and `GitService.revertCommit`. The
history panel is now purely a reading surface — a timeline with each
save's changes rendered beside it.

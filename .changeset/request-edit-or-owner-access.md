---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

A person who can only read a file or folder can now ask for Can edit or Owner from its Manage access dialog, and the people who can already edit it answer in the same dialog.

On the live workspace, the read-only dialog no longer ends at "Ask an owner". It offers the two levels, an optional note of up to 500 characters and a Request access button; sending it opens a change request titled "Access request: <item name>" and the control gives way to "Requested: <level>. Waiting on <names>." There is one open request per person per item: a second send, a double click or a second tab answers with the request the first one opened. The control is not offered to someone who can already edit the item, on a draft, for a file that exists only in a change request, or for a file that cannot carry rules of its own, which keeps pointing at its folder.

Editors see one line per open request at the top of the dialog, with the note under it, and Accept and Decline. Accept is an ordinary grant, through the same check, lock and commit as a manual one, and the request's branch is never merged. Decline closes the request and grants nothing. A request closes itself once the person holds the level it asked for however they came by it: the accepted grant, a direct grant, a higher level, a parent folder, or a role or group they joined. A request whose branch cannot be read — or whose rules cannot be parsed — is left open rather than closed on a reading that failed.

The skill page's "Request write access" is now the same request: asking there and asking for Can edit on the skill's folder open one request, shown in both places. `AccessRequestsBanner` moved from the library module to the access module and takes `itemName` in place of `plugin`.

For integrators: `IWorkflowService` gains a required method, `latestClosedChangeRequest(authorEmail, sourceBranch)`, which anything implementing the interface must add. `JoinRequestsService` takes the access-control service as a fourth constructor argument, and its `list` and `reconcile` take an `AccessRequestTarget` (`folderTarget(folder)` for a folder) where they took a folder path. `pendingProposals` takes a fourth argument saying which grammar the rules are written in — `'folder'` for an `access.md`, `'file'` for a node's own frontmatter — and returns `null`, rather than an empty list, when the branch's copy is missing or unreadable. New routes: `POST` and `GET /api/workspace/:id/access/request`, `GET /api/workspace/:id/access/requests`, and `POST /api/workspace/:id/access/requests/:number/reconcile`, all refused on any workspace but the live one.

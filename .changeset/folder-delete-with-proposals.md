---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-shared': minor
---

Deleting a folder that holds proposed files asks what to do with the proposals. The delete dialog names the open change requests proposing files in the folder and offers **Delete folder only** (the requests stay open), **Delete folder and its proposed changes** (the folder is deleted first; then every file under it leaves every request proposing it, and a request left with nothing is withdrawn), and **Cancel**. The second option is offered only when the caller may act on every listed request — their own, any as an admin, or one whose every proposed file under the folder they may write — and is otherwise disabled with the reason. A request that proposes another file under the folder between that check and the removal stops the removal, with nothing taken out of any request. A folder delete no longer fails on files that exist only as proposals, and neither delete path leaves stale pending markers in the tree. New endpoints: `GET /workflow/change-requests/under-folder` and `POST /workflow/change-requests/under-folder/remove`; `@bevel-software/platform-shared` adds `FolderChangeRequest` and `FolderChangeRequestRemoval`.

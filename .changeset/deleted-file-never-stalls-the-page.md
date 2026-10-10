---
'@bevel-software/platform-core-frontend': patch
---

Deleting the open file lands on the tab that is left, and a file deleted by someone else says so.

Deleting the file you are viewing, from the sidebar or by deleting a folder that holds it, used to leave the page on "Opening <file>…" for good: the tab closed, but the address kept naming the deleted file. The page now lands where closing the tab would — the tab that is left, or Knowledge home on the same branch — and replaces the history entry, so Back does not return to the deleted file. A delete that is cancelled, refused or fails leaves the file open and the address as it was; deleting a tab that is not on screen leaves the page alone.

When someone else deletes the file you are viewing (a teammate, an agent, a merged change request, a pull from the git host), its content is replaced by "This file was deleted", naming the file, the branch and, when the change event named one, the person. Close closes the tab and lands as above. Unsaved edits stay on screen with Copy edits. A background tab deleted meanwhile shows the same notice when switched to. A link to a file that no longer exists still says "File not found".

The same holds on a skill's page and a tool's page in Skills & Tools: when someone else deletes the skill or the tool on screen, the page shows the same notice (one `DeletedFileNotice` component for both apps), with the skill editor's unsaved text and Copy edits when there is any, and Close lands on Skills & Tools. Before, the page kept the old content until a reload.

A commit pulled from the git host onto a file with unsaved edits — the one write the file lock cannot stop — now merges the edits onto the new content (a line-based three-way merge, `node-diff3`) and keeps the result unsaved, with a banner saying so. When the two collide the edits are discarded, as before, and the banner says that instead.

For downstream frontends: `deleteEntry` resolves `{ closedActive, newActivePath }` on success (still `false` when called off); `OpenTab` gains the optional `deletedBy`, `changedOnBranch` and `remoteRevision`; the workspace context gains `clearChangedOnBranch` and the optional `isPendingDelete`.

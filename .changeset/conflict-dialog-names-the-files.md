---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-shared': patch
---

A change request that conflicts with its target now names the conflicting files in its dialog. The names come from the server's refusal: the update that opening the request runs, or this tab's own apply (whose refusal names the files only to a clicker who may read every one of them). The banner names up to three files, one per line, by the name the file tree shows (with the folder beside two names that would read the same, and the full path on hover); clicking one opens that file, and the rest are counted ("and 5 more files"). The tree marks the rows of those files, in a colour that reads at 3:1 or more. The banner and the files now scroll as one, so a long banner no longer squeezes the files out of the dialog.

The prompt for the person's agent now sits behind a "Copy prompt for your agent" button, wherever it is offered (this dialog, the file page's change boxes, the skill page). "Show prompt" opens it, and a copy the browser refuses opens it with its text selected. It lists the full path of every conflicting file the server named, in a data block of its own, and keeps a backtick in a branch or file name as it is.

The server now reads git's list of conflicting files NUL-separated, by one reader. Before, the list a merge reported held a name with a space in quotes, and every list held a non-ASCII letter as an octal escape: names no file has. The same list is what a sync conflict reports (`PullRebaseConflictError.conflictedPaths`), so the sync-conflict banner gets the corrected names too.

`@bevel-software/platform-shared` exports `markdownCodeSpan` (moved from core-backend, so the agent instructions and the prompt quote names by one rule; the instructions' text is unchanged) and `namedConflictFiles` / `moreConflictFiles` (the "three, then and N more" rule the server's sync-conflict sentence used, now shared with the dialog; that sentence is unchanged). `change-request-merge-failed` carries `conflictedPaths` on a conflict, under the read check above.

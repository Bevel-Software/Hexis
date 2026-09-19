---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-shared': patch
---

A rename or a move onto a name that is already taken is refused instead of replacing what is there. Renaming an entry was a plain `fs.rename` with no look at the destination, and `rename` replaces an existing file on every platform: a tester renamed a `.docx` to the exact name of an existing `.md`, the markdown file silently became Word bytes, and the page broke.

The destination is now checked in the one place every surface goes through, so the refusal reads the same wherever it is met: "A file named Notes.md already exists in Sales." — or "A folder named …", named for whatever is in the way rather than for what was being moved. Nothing is overwritten and nothing is merged: a folder moved onto an existing folder is refused too. To replace a file, upload a new version by the same name, which is still the path for that.

In the sidebar the rename box shows the sentence under the name you typed and stays open, so the name is there to fix; a refused drag says so under the row it was dropped on and leaves both entries where they were. Neither is a popup any more. The agent's `move_file` and `copy_file` answer the same sentence with a 409 — `copy_file` never overwrote silently before either, and now says why.

A case-only rename is not a clash with the entry itself: the check compares file identity rather than spelling, so `notes.md` → `Notes.md` is the rename it looks like on a case-insensitive filesystem, and an ordinary rename onto a free name is unchanged.

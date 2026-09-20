---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-shared': patch
---

A rename or a move onto a name that is already taken is refused instead of replacing what is there. Renaming an entry was a plain `fs.rename` with no look at the destination, and `rename` replaces an existing file on every platform: a tester renamed a `.docx` to the exact name of an existing `.md`, the markdown file silently became Word bytes, and the page broke.

The destination is now checked in the one place every surface goes through, so the refusal reads the same wherever it is met: "A file named Notes.md already exists in Sales." — or "A folder named …", named for whatever is in the way rather than for what was being moved. Nothing is overwritten and nothing is merged: a folder moved onto an existing folder is refused too. To replace a file, upload a new version by the same name, which is still the path for that.

In the sidebar the rename box shows the sentence under the name you typed and stays open, so the name is there to fix; a refused drag says so under the row it was dropped on and leaves both entries where they were. Neither is a popup any more. The agent's `move_file` and `copy_file` answer the same sentence with a 409. For `copy_file` this is a change of behaviour: a copy onto an existing path used to replace that file, and is now refused; to replace a file's content, write it with `write_file`.

The sentence names what is in a folder, so it is only ever said to someone who may write there: both tools settle the write verdict first, and a caller a protected branch denies gets the same refusal whether the name they asked for is taken or free.

A case-only rename is not a clash with the entry itself: `notes.md` → `Notes.md` finds the source's own file at the destination on a case-insensitive filesystem, and that is the rename it looks like. What tells that apart from two hard links to one file is the folder listing: a filesystem that folds the two spellings shows a single entry, while one that keeps them apart shows two. A move onto a second name of the same file is therefore refused like any other clash. An ordinary rename onto a free name is unchanged.

Looking at the destination is what produces the sentence; it is not what makes the refusal true. The move and the copy themselves now land exclusively — a file moves as `link` + `unlink`, a folder claims its name with `mkdir` first, a copy uses `COPYFILE_EXCL`, and a filesystem without hard links claims the name with an exclusive create rather than falling back to a replacing rename — so a destination created in the moment between the look and the landing is refused by the filesystem rather than quietly replaced.

And the refusal costs no one else their file. Releasing a lock after a failed operation resets that path to its last committed state — it has no way to tell one writer's dirty bytes from another's — while the commit for a save that has just landed runs out of band, moments later. Put those together at the destination of a lost race and the loser's refusal deleted the winner's file on its way to reporting the clash: one name contested, two files gone. A refusal writes nothing, so it now releases the lock leaving the disk and the commit queue exactly as they are, which is the release the rest of the system already used for an operation that touched nothing.

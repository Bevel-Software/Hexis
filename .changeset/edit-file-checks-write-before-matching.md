---
'@bevel-software/platform-core-backend': patch
---

`edit_file` refuses a file the caller may not change before it looks for `old_string`, so its answer reveals nothing about the file (hx-edit-file-checks-write-before-matching).

The tool used to compare `old_string` with the file once before taking the path's lock and once again under it. Taking the lock is where access is judged: write on a protected branch, read on every branch. A caller the lock refuses therefore got the write refusal when the string was in the file and `old_string not found in the file.` when it was not, which told them whether a file they could not read held a given text.

The comparison now happens only with the lock held. A caller it refuses gets the same `write-denied` answer whatever `old_string` is. A caller who may change the file gets the same answers as before, `not found` and `appears N times` included, with one difference: those answers now also wait for the lock, so while someone else holds it the caller is told the file is locked rather than whether the text is there.

No tool, argument or answer shape changes, so the agent guide is not edited.

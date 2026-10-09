---
'@bevel-software/platform-core-frontend': patch
---

New page in the Get set up list never overwrites a page.

It still picks the first free `Untitled N.md` from the file tree, but now creates it with an exclusive write, so a page made elsewhere since the tree loaded is refused (409) rather than replaced with an empty one, and New page moves on to the next free name, up to five tries. Any other refusal shows on the step as before.

- `useWorkspace().createFile(path, content, { ifAbsent: true })` passes the workspace API's exclusive create through. Without the option it writes unconditionally, as the file explorer's New file always has.

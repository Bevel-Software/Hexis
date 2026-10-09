---
'@bevel-software/platform-core-frontend': minor
---

"Write your first page" in the Get set up list has a New page button.

It creates `Untitled.md` in the knowledge folder (or the next free `Untitled N.md`) and opens it already in edit mode, with the cursor under the title. `openWorkspacePath(path, { edit: true })` asks for that through router state, the same `startEditing` key the skill pages already use; the page viewer enters edit mode the way the Edit button does, once, and drops the request so a refresh or Back opens the page for reading. A refusal to create the file shows on the step.

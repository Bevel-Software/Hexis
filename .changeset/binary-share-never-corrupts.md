---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Sharing a file that cannot carry frontmatter no longer corrupts it. A file-level grant, revoke or restriction used to splice a YAML block into the file itself, so sharing a PDF or a presentation left it with a blank preview (and the grant never applied). Per-file rules now exist for Markdown notes only: on any other file grant, revoke and deny-here answer 422 with `{ error: "This file's access comes from its folder. Manage access on <folder> instead.", kind: "folder-governs-access", folder }`, and the file is never opened. `GET /workspace/:id/access` reports `governedByFolder` for such a file, and Manage access on it shows the same sentence with a button that opens the folder's sheet, while still listing who can open the file. Which files carry frontmatter is decided by `canCarryFrontmatter` from platform-shared. Files already damaged are not repaired; restore them from history.

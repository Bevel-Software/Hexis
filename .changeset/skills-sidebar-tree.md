---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The Skills & Tools sidebar shows the shared `Skills/` root as a file tree, above the plugins. It is the same tree as the Knowledge app's — upload by drag and drop, create files and folders, rename, move, delete and manage access from the right-click menu — and clicking a skill file opens it on its skill page. The plugin list below it is now headed "Plugins".

Because the sidebar reads that tree from the workspace, the `Skills/` root is no longer hidden by `.bevelignore`: the packaged template drops the rule, and the maintenance step on the first start removes the line an earlier release appended to existing knowledge bases (only that line and its comment; every other rule stays). The Knowledge explorer never rendered the root and still does not.

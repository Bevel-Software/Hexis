---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-shared': minor
'@bevel-software/platform-mcp-core': minor
---

Groundwork for serving several knowledge bases from one process. The server no longer reads the branch model, the folder layout or the checkout folder name from process-wide values: they travel together as one knowledge-base context that the composition root builds once and hands to every service, and a lint rule keeps the server off the shared package's live bindings from now on. Nothing changes for a running deployment; the setup screen's completing save still applies the admin's folder names and branch model to the running server without a restart.

For overlay authors: the shared helpers that answer questions about the layout or the branch model now take it as an argument (`isPlatformFile(path, layout)`, `reservedRootDirNames(layout)`, `isProtectedBranch(model, name)`, `agentsFilePointerSentence(agentsFile)` and the rest); pass `core.kb.layout` or `core.kb.branchModel` on the server and `currentKbLayout()` or `currentBranchModel()` in the browser. Services that took a `kbDirName` string now take the context in that slot. The composition root keeps mirroring the context onto the shared bindings for code that still reads them (`CorePorts.mirrorSharedBindings`, on by default).

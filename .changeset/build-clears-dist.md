---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-mcp-core': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/hexis-mcp': patch
---

A published package holds only the modules its source declares. `tsc` writes new output into `dist` and never removes old output, so a working copy that had built earlier releases carried the compiled files of modules since deleted (`shared/fs-walk`, `modules/workflow/workflow.errors`, `modules/groups/*`, some thirty in 0.19.0) into every publish. A consumer that imported one of them by path kept compiling against dead code. Each build now clears `dist` before it runs.

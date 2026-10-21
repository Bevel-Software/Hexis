---
'@bevel-software/platform-core-frontend': patch
---

An HTML page inside a skill gets its tools on the skill page, as it does on the file page: the skill page's file pane provides the page-tool bridge under the file's knowledge-base path, so `window.bevel.tools` answers there, a call that may write asks once per page view with the same card, and the Audit log records the call under the same path the file page would. The "only available in the platform" card stays for the embed and the MCP App pane. `PageToolsContext` is exported from the workspace module's entry point, and its contract lists the hosts that provide it.

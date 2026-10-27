---
'@bevel-software/platform-core-backend': patch
---

The agent guide's HTML views section gains "Live data: a page that stays still while it loads": how a page that reads through `window.bevel.tools` renders its final shell before any data, publishes one consistent dataset at a time, keeps the current board through a refresh, fails a load visibly with a Retry, reads in bounded parallel through `callTool` as the viewer, and links to what the tools named by a root-relative path. A complete plain-HTML reference page follows the rules, and core-frontend's `liveDataReferencePage.test.ts` runs that page, taken out of the guide, through the real sanitizer, sandbox and tool bridge. The link rules now name the root-relative form, `/<checkout folder>/<path>`, the sanitizer already kept and the bridge already resolved.

---
'@bevel-software/platform-core-frontend': patch
---

A tool's page now shows the file the platform actually runs — its `.tool` manual, or the plugin's `mcp.json` entry — behind a closed-by-default "Source" disclosure. It is read-only and loads lazily from the default branch when opened, so someone checking what a tool does can see it without leaving the page or being handed a way to edit it.

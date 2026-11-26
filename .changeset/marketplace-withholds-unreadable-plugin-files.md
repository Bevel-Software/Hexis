---
'@bevel-software/platform-core-backend': patch
---

The plugin marketplace compiled for a person carries only the plugin files that person may read. A plugin whose manifest (`plugin.json`) they may not read is left out entirely: its folder, its compiled manifests, its `mcp.json` servers and its catalogue entries. Its linked skills they may read still ship, in the skills plugin. Inside a plugin they may read, each file of the folder (a `CONVENTIONS.md`, reference material) and the `mcp.json` its servers come from ship only when that file is readable. Before, a person with no read on a plugin still received its `CONVENTIONS.md` and its portable MCP servers.

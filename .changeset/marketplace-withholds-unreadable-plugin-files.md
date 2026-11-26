---
'@bevel-software/platform-core-backend': patch
---

The plugin marketplace compiled for a person carries only the plugin and skill files that person may read. A plugin whose manifest (`plugin.json`) they may not read is left out entirely: its folder, its compiled manifests, its `mcp.json` servers and its catalogue entries. The skills it links are not withheld with it: one they may read is judged like any other readable skill. Inside a plugin they may read, each file of the folder (a `CONVENTIONS.md`, reference material) and the `mcp.json` its servers come from ship only when that file is readable; inside a skill they may read, each of its files ships only when that file is readable. Before, a person with no read on a plugin still received its `CONVENTIONS.md` and its portable MCP servers, and a readable skill was copied with every file in its folder.

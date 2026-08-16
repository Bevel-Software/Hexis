---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/hexis-mcp': minor
---

`mcp.json` is now authoritative for MCP servers, and stdio servers run locally.

MCP servers are declared in each plugin's `mcp.json` — the Agent Plugins fixed location — not in `.tool` files. Discovery synthesizes the same manual descriptors from it, so call templates, vault variable scoping, OAuth auto-discovery and `list_tool_setup` are unchanged; the `mcpServers` key is the manual name, which is the namespace secrets bind to. What the portable file cannot carry (auth headers with `${VAR}` vault references, `variables` declarations, descriptions, `local: true`) lives in `plugin.json` under `extensions["software.bevel.hexis"].mcpServers[<name>]`. The boot migration now CONVERTS mcp-type `.tool` files into entries — keyed by their manual id so configured secrets and completed OAuth grants stay bound — splits their headers between the two files, deletes the `.tool`, and also converts ones a previous run parked in the extension directory. Merging never clobbers: an entry already present under a key wins. `http`/`inline` manuals still move as `.tool` files, which remain the only way to express them.

`type: "stdio"` entries are supported and inherently local: the hosted proxy never spawns them, and `@bevel-software/hexis-mcp` now implements the Agent Plugins runtime contract for them — it materializes the plugin's files into `~/.hexis/plugins/<host>/<plugin>` (fetched over the same key-authenticated tools any agent uses), provides `PLUGIN_ROOT`/`PLUGIN_DATA`, expands exactly those two placeholders in `args`/`env`/`cwd`, resolves `./` commands with symlink-aware containment inside the plugin root, and refuses a server `env` that shadows the runtime variables. Known limitation: files are fetched over a text surface, so binary assets do not materialize.

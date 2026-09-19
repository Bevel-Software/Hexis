---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-core-backend': patch
---

A skill whose `allowed-tools` names a platform tool that does not exist now gets a warning. Saving a SKILL.md from the skill page, or with `write_file`, `write_files` or `edit_file`, checks each entry that looks like a platform tool against the tools the saving user can see. That means a manual name (`hubspot`), a manual-qualified name (`hubspot.search`), or an MCP-style name (`mcp__hexis__hubspot_search`). An unknown entry, including one under a manual that was removed, comes back as a warning that names the entry and suggests the closest tool name when one is near. The save always goes through. The skill page shows the warnings in a status notice under its heading. Client tool names such as Bash, Read, Edit, Write, Glob, Grep and WebFetch, permission rules like `Bash(git:*)`, and other MCP servers' tools are never flagged. `get_skill` returns the same list under `warnings`, so an agent knows about a missing tool before it relies on it.

---
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-mcp-core": patch
"@bevel-software/hexis-mcp": patch
---

Take `@utcp/mcp` 1.1.6, which fixes a regression 1.1.5 introduced: closing
any UTCP client permanently disabled MCP tooling for every other client in
the same process (the shared protocol instance treated one client's close
as terminal). 1.1.6 also classifies session errors from structured SDK
metadata, so a tool error whose message merely mentions authorization no
longer tears down a healthy MCP session or discards a valid OAuth token.

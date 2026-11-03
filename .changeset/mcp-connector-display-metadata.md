---
'@bevel-software/platform-mcp-core': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/hexis-mcp': patch
---

MCP tool listings include human-readable display titles and an explicit
`annotations.readOnlyHint` on every tool, as required for Microsoft's federated
connector submission. Tools with unknown effects advertise `false`, matching
MCP's default when the hint is omitted. Existing platform hints and administrator
overrides are preserved. Callable names, arguments, and execution are unchanged.

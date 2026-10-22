---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-mcp-core': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/hexis-mcp': minor
---

Platform tools tell MCP clients which of them only read. Every platform tool the hosted MCP endpoint and `hexis-mcp` list carries `annotations.readOnlyHint`: `true` for a tool that declares no write, `false` for one that does; `list_tools` and `tools_info` carry `true`, `call_tool_chain` `false`. A client that gates approval on the hint, such as Claude Cowork, no longer asks before every read. An admin can override any of these hints on the Tools page (`/tools`), with a warning before a writing tool is marked read-only and a reset back to the built-in value; the override is a deployment setting, and both servers list it on their next `tools/list`. The code-mode meta-tools appear on the Tools page in a section of their own. Tools from the knowledge base (`.tool` manuals, plugin MCP servers) are listed as before, with no annotation.

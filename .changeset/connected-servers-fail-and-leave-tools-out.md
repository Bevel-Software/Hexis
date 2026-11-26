---
'@bevel-software/platform-mcp-core': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/hexis-mcp': patch
'@bevel-software/platform-shared': patch
---

Connected MCP servers and drafts:

- A connected MCP server that answers a call with `isError: true` now fails the call. `@utcp/mcp` dropped the flag, so the call read as a success whose text was the error; the proxy now passes the server's own content on, marked `isError`, and a chain sees a rejected call. The hosted surface and `hexis-mcp` both install this. Such an answer is never taken for a rejected token: its words can say "401" or "Unauthorized" without a token refresh, a retry or a disconnected sign-in.
- A server in a plugin's `mcp.json` can leave tools out: `excludeTools: ["<tool>", ...]` on its entry in `plugin.json`'s Hexis extension, by the name the server lists them under. `registerManual` takes them off the client every time the server registers, a session recovery included, so they are not in `tools/list`, `list_tools` or the chain's interfaces, and a call to one by name, through the chain's tool bridge too, is refused. A malformed list keeps the server offline. Saving the server in the editor keeps the list.
- A routed call to a connected server reaches only a tool the request's surface still holds, so a tool hidden for an invalid schema can no longer be called by name through the chain's tool bridge.
- `create_branch` gives a bare draft name that the caller could not delete their own prefix (`<email-localpart>/`, or their `suggestions/` prefix when the address has no usable localpart), and answers the name it created. A protected name is not prefixed, so it is still refused.

---
'@bevel-software/platform-mcp-core': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-shared': minor
---

Connected MCP servers and drafts:

- A connected MCP server that answers a call with `isError: true` now fails the call. `@utcp/mcp` dropped the flag, so the call read as a success whose text was the error; the proxy now passes the server's own content on, marked `isError`, and a chain sees a rejected call. The hosted surface and `hexis-mcp` both install this. Such an answer is never taken for a rejected token: its words can say "401" or "Unauthorized" without a token refresh, a retry or a disconnected sign-in. Its words are passed on with every credential the call carried taken out (a value substituted into the call, or a credential-named header, query parameter, environment variable or auth field spelled out in full), so a server that echoes a shared key does not hand it to the caller.
- `SecretRedactor`, the connection probe's redactor, is now `platform-mcp-core`'s and serves both. It also takes out a masked head of a value it has already taken out whole in the same text, which it used to leave printed, and reads a credential query parameter the way `URLSearchParams` does, in both spellings. The substitutor's reference grammar moves into `platform-mcp-core` as `VARIABLE_REFERENCE_PATTERN` (not global); core-backend's `VARIABLE_REFERENCE_RE` is built from it.
- A server in a plugin's `mcp.json` can leave tools out: `excludeTools: ["<tool>", ...]` on its entry in `plugin.json`'s Hexis extension, by the name the server lists them under. `registerManual` takes them off the client every time the server registers, a session recovery included, so they are not in `tools/list`, `list_tools` or the chain's interfaces, and a call to one by name, through the chain's tool bridge too, is refused. A malformed list keeps the server offline. Saving the server in the editor keeps the list.
- A routed call to a connected server reaches only a tool the request's surface still holds, so a tool hidden for an invalid schema can no longer be called by name through the chain's tool bridge.
- `create_branch` gives a bare draft name that the caller could not delete their own prefix (`<email-localpart>/`, or their `suggestions/` prefix when the address has no usable localpart), and answers the name it created. A protected name is not prefixed, so it is still refused.

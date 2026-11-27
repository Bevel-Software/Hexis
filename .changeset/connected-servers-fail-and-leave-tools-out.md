---
'@bevel-software/platform-mcp-core': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-frontend': minor
---

Connected MCP servers and drafts:

- A connected MCP server's failure now fails the call:
  - An answer with `isError: true` fails the call. `@utcp/mcp` dropped the flag, so the call read as a success whose text was the error. A direct call now answers the result it answered before, marked `isError`: the same content, only the flag added. A `call_tool_chain` sees a rejected call whose message is that result's text, where it saw a value. The audit log records such a call as `error`, where it recorded `ok`. `installDownstreamToolErrors()` wraps the `mcp` protocol factory a surface has registered; the hosted surface and `hexis-mcp` both call it. In `hexis-mcp` the deployment is such a server too, so the platform's own tool failures now reach the local client marked `isError`.
  - Such an answer is never taken for a rejected token: its words can say "401" or "Unauthorized" without a token refresh, a retry or a disconnected sign-in.
- A server in a plugin's `mcp.json` can leave tools out: `excludeTools: ["<tool>", ...]` on its entry in `plugin.json`'s Hexis extension, by the name the server lists them under. `registerManual` takes them off the client's tool repository every time the server registers, a session recovery included; `tools/list`, `list_tools` and the chain's interfaces are built from that repository, and a call to one by name, through the chain's tool bridge too, is refused. A list that is not a list of tool names keeps the server offline, at discovery and at registration (one reader, `excludeListOf`, new in `platform-mcp-core`); a name the server does not list removes nothing, and a `plugin.json` that does not parse reads as no list (its warning now names `excludeTools`). Saving the server in the editor keeps the list. `hexis-mcp` hands a local stdio server's protocol the prepared spawn spec and this list, and no other key of the entry.
- A call is routed to a connected server's pooled connection only for a tool the request's surface still holds; any other is refused as a tool the client does not have. So a tool hidden for an invalid schema can no longer be called by name through the chain's tool bridge, and neither can one the pooled connection found after the surface was built, until the surface is rebuilt.
- `create_branch`, and the route the app creates a branch through, prefix a bare draft name the caller could not delete with their own prefix (`<email-localpart>/`, or their `suggestions/` prefix when the address has no usable localpart), and answer the name created. A protected name is not prefixed, so it is still refused. The branch switcher names a new draft with the same prefix, so a person whose address has no usable localpart now gets a `suggestions/...` draft where they got `user/...`, and offers to delete a person's own `suggestions/` drafts. `isOwnBranch` (new in `platform-shared`) is the one reading of "is this branch theirs" for the server's delete rule and the switcher's delete button.

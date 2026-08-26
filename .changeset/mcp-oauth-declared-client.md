---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Sign-ins with an owner-registered OAuth app now work against MCP servers — HubSpot included.

**PKCE by default.** A hand-declared sign-in provider never sent PKCE, so every MCP-spec server (which requires it) rejected the authorization request; only the zero-config path had it. Declared providers now use PKCE S256 unless the declaration says `pkce: false`. Providers that never implemented PKCE ignore the extra parameters, so nothing that worked stops working. The standalone OAuth secret form on the Secrets page has the same switch, on by default. An existing declared provider picks this up when its owner next saves the client secret.

**Bring your own client id.** A provider that publishes its OAuth metadata but does not allow automatic client registration (HubSpot, Google) used to need every endpoint copied by hand. For an `mcp.json` server the sign-in declaration is now just the client id of the app the owner registered — `oauth: { clientId }` on a user-scoped variable in the plugin.json extensions entry. The endpoints, PKCE, and the resource indicator are discovered from the server's own metadata at scan time and pinned with the client secret. `authorizationUrl`/`tokenUrl` remain available (both or neither) for providers that publish nothing, and `resource` can be declared for the same case. A `.tool` still needs both endpoints: it has no server to ask.

**The server editor shows what the files say.** The tool page's read-only server facts now list everything mcp.json and plugin.json store — headers, auth headers, description, every declared variable, and a sign-in's client id, endpoint source, scopes and PKCE — so what is configured is visible without opening either file. The editor's variables rows gained the same sign-in fields (client id, discovered-or-manual endpoints, scopes, PKCE), and switching a sign-in on pre-fills the `Authorization: Bearer ${VAR}` header where the writer can see it.

**Clearer next steps.** The "sign-in setup needed" banners no longer point every server at "the `.tool` file": an mcp.json server is edited under "Edit server" on its own page, and a declared-but-unfinished sign-in asks only for the client secret. Discovery's `setup.reason` names the redirect URI to register with the provider, and the client-secret route refuses with that same reason while the endpoints are still unknown instead of pinning a provider with none. The knowledge-base `AGENTS.md` documents the `oauth` block, the mcp.json shape, and the walkthrough an agent follows to set a provider up end to end.

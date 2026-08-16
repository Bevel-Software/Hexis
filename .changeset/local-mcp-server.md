---
'@bevel-software/platform-mcp-core': minor
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-core-backend': minor
---

Add `@bevel-software/hexis-mcp`: run a workspace as a local MCP server, so the tools the hosted endpoint cannot reach become usable.

A `.tool` marked `remote: false` — an MCP server on `localhost`, a service that only answers inside a network — is skipped by the hosted proxy, which can only name it through `list_local_tools`. `npx @bevel-software/hexis-mcp --url <workspace> --key <key>` runs where those tools are, and serves them alongside everything the hosted endpoint serves.

It gets the remote half by registering the deployment's own MCP endpoint as a single UTCP manual rather than reimplementing it, which is what keeps credentials where they belong: remote tools still execute on the server and still resolve their `${VAR}`s from the Secrets Vault, so shared keys and completed OAuth sign-ins are untouched. Only local-only tools run locally, on variables from the launching process's environment. No endpoint exposes vault values, and none is added here.

The endpoint itself is asked for, not computed — `/api/config`'s `mcpUrl`, the same value the OAuth metadata publishes — with a fallback to `<url>/api/mcp` for deployments that predate it.

`@bevel-software/platform-mcp-core` is new and internal: the half of the MCP surface both servers share (tool-name flattening, the schema/name guards that stop one bad tool blanking a client's whole toolset, streaming dispatch, the code-mode meta-tools, and the seeding rule that decides which manuals may see the caller's bearer). `platform-core-backend` now consumes it instead of owning it; its behaviour is unchanged, and its existing MCP suite is what proves that.

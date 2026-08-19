---
'@bevel-software/hexis-mcp': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The local MCP server signs in through the browser. Run
`npx @bevel-software/hexis-mcp` with just the workspace URL and it
walks the deployment's own OAuth flow — discovery via the RFC 9728
challenge, dynamic client registration, PKCE with a loopback callback —
then exchanges the access token at the new `POST /api/mcp/local-token`
endpoint for the same short-lived internal credential the hosted proxy
mints for its OAuth sessions. Refresh tokens persist per host under
`~/.hexis/oauth/`, mid-run 401s renew once, and `--key` remains the
autonomous/CI mode. The connect surfaces drop the mint-a-key-first
step: desktop-agent snippets are keyless, with the key variant kept in
the key-reveal modal for pipelines.

---
'@bevel-software/platform-core-backend': patch
'@bevel-software/hexis-mcp': patch
---

A bearer shaped like a connection key that is invalid or revoked is now answered with HTTP 401, `WWW-Authenticate: Bearer error="invalid_token", error_description="Invalid or revoked connection key"` (no `resource_metadata`) and `{ "error": "Invalid or revoked connection key. Mint a new one in External agent access." }` on the MCP endpoint and every agent REST endpoint, so an MCP client holding a bad key is no longer invited into a browser sign-in. A missing bearer or an invalid OAuth access token keeps the discovery challenge. `hexis-mcp` with a rejected key prints "The connection key was rejected by <deployment>. Mint a new one in External agent access." (with a note on where Claude Code hides it) and exits non-zero; a 403 on a valid key no longer tells the person to mint a new one.

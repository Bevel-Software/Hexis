---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-mcp-core': patch
'@bevel-software/hexis-mcp': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Take the upstream UTCP fixes: `@utcp/cli` 1.1.3, `@utcp/mcp` 1.1.7, `@utcp/http` 1.1.12. The one that matters most here: the cli protocol now answers a streaming call with its full result as a single chunk instead of throwing "Streaming is not supported" — the local MCP server dispatches every tool through the streaming path, so a local `.tool`'s cli tools (`git_push` among them) failed at call time even after they registered. With this, an agent session's `git.push` actually pushes.

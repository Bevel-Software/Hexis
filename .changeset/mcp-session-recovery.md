---
'@bevel-software/platform-mcp-core': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/hexis-mcp': patch
---

MCP tool calls survive a server restart. A restarted server answers the next call on an old session with the spec's 404 / `Session not found`, and our clients used to hand that straight to the caller — a platform redeploy left every connected agent erroring until someone reconnected it by hand. The client now re-registers the affected manual and retries the call once, so the restart shows up as a single log line instead of a broken toolset. This covers third-party MCP servers the workspace proxies as well as the platform itself, and the local `hexis-mcp` server as well as the hosted endpoint. Only that one failure — the session miss, which the server decides before it dispatches to a tool — is retried: a tool error, an auth refusal, a timeout or a dropped connection surfaces exactly as before, so nothing that could have already run is ever run twice.

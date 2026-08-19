---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-mcp-core': patch
'@bevel-software/hexis-mcp': patch
---

Take @utcp/mcp 1.1.4: the Streamable HTTP transport no longer
reconnects its notification stream by default, ending the abort-listener
accumulation (MaxListenersExceededWarning) that long-lived deployments
with hosted MCP tool servers showed. A per-server
notification_stream_max_retries knob opts back in where server-initiated
notifications are actually consumed.

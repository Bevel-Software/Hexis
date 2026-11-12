---
"@bevel-software/platform-core-backend": minor
---

The MCP endpoint lets a deployment wrap each caller's tool client. `McpProxyOptions.prepareClient`, set through the new `CorePorts.prepareMcpClient`, runs on the tool client built for a caller, with their user id, before any tool is registered on it. A deployment wraps the calls its MCP callers make there, the way it wraps its own in-process agent's client: for example, sending the bytes of a file as the body of a tool that declares its body a file path, read as the caller. The argument checks are installed after the hook and stay outermost, so they check the call as the agent made it. The `McpClientHook` type is exported from `modules/mcp`. Without the port, nothing changes.

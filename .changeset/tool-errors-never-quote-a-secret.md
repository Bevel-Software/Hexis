---
'@bevel-software/platform-mcp-core': patch
---

A failing tool call no longer quotes a value the tool client substituted into it. The client fills a tool's `${NAME}`s (a vault secret in a URL's query, a header) just before the call, and every check after that point saw the filled-in text: the URL scheme check refused a plain-http URL by quoting it whole, secret included, and an upstream that echoed the key in its refusal was quoted the same way. The call guards now record each value the client resolves for a call and replace it, in the error that call throws, with the `${NAME}` it was written as. That covers the message, the stack, the upstream's answer and the causes, on MCP dispatch, `call_tool_chain` and a direct `callTool`, whoever is calling. A manual that fails to register is reported the same way. Values shorter than four characters are left as they are, since replacing them would garble the message and they are not credentials.

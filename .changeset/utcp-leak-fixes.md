---
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-mcp-core": patch
"@bevel-software/hexis-mcp": patch
---

Pick up the upstream UTCP fixes for two resource leaks behind the agent's
tool calls.

`@utcp/code-mode` 1.2.13: a bridged tool call that never settled — a hung
HTTP request, an MCP server that stopped answering — pinned one of the
sandbox's OS threads forever, with almost no memory attached. Task counts
climbed while memory looked flat, until the process could no longer spawn a
git subprocess. Every call is now bounded by its chain's lifetime, and an
out-of-memory in the sandbox reports as such instead of as a timeout.

`@utcp/mcp` 1.1.5: an MCP session whose credential was rejected stayed cached
and was reused on every later call, each one leaking an abort listener; a
revoked OAuth token was resent until its local expiry. Dead sessions are now
evicted, rejected tokens dropped, and the SDK's own request timeout is
recognised as a wedged session.

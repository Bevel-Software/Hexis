---
"@bevel-software/platform-mcp-core": patch
---

A failed http tool call no longer writes its credentials to the server log. The stock `@utcp/http` protocol printed the whole axios error, whose request config and socket header carry `Authorization: Bearer <key>`; the `http` protocol Hexis installs now logs a failure by tool name, error class, code and HTTP status only.

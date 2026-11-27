---
"@bevel-software/platform-mcp-core": patch
---

An http tool call no longer writes its credentials to the server log. The stock `@utcp/http` protocol printed the whole axios error on a failure, whose request config and socket header carry `Authorization: Bearer <key>`, and printed every call's full URL, where a key written into the query or the path travels. The `http` protocol Hexis installs now logs a URL by its origin only, and a failure by its message (the tool, provider or OAuth client it concerns), error class, code and HTTP status only.

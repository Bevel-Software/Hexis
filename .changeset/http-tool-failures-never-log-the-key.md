---
"@bevel-software/platform-mcp-core": patch
---

An http tool call no longer writes its credentials to the server log. The stock `@utcp/http` protocol printed the whole axios error on a failure, whose request config and socket header carry `Authorization: Bearer <key>`, and printed every call's full URL, where a key written into the host, the path or the query travels. The `http` protocol Hexis installs now logs no URL at all (the line is cut at it), and a failure by its message (the tool, provider or OAuth client it concerns), error class, code and HTTP status only. Each logged message is escaped as one token, so a name holding a newline or a terminal escape cannot forge or colour a log line.

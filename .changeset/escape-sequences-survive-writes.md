---
'@bevel-software/platform-core-backend': patch
---

`write_file`, `write_files` and `edit_file` now say what happens to escape sequences in the content they are given. Content written through the knowledge base is stored exactly as the request's JSON string value decodes once — on the MCP endpoint, on the tool route and inside `call_tool_chain` alike — so an escape that arrives already decoded was decoded by the client that built the request, and nothing here can tell such content from content that was meant to be decoded. The three descriptions now warn about that and point at the upload route, which carries bytes rather than a JSON string and lands such content unchanged. No behaviour changed.

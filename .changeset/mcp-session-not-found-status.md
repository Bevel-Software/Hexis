---
'@bevel-software/platform-core-backend': patch
---

`/api/mcp` now answers a request naming a session it no longer holds with HTTP 404 and JSON-RPC `-32001 Session not found`, instead of a 400 that read as "malformed request". Streamable HTTP makes that 404 the signal a client re-initializes on, so every connected agent used to strand itself whenever the server restarted (the session map is in-process) or the idle sweep evicted its session — a person had to reconnect each client by hand. A request that carries no session id at all is still a 400, now `-32000` and distinguishable from the miss above; both bodies are real JSON-RPC error objects, since these answers are produced before the request reaches an SDK transport. An `initialize` is no longer refused for still carrying a stale session id, which is exactly the shape the recovering client sends.

A request bearing a live session id that belongs to a different user is still refused with 403; its JSON-RPC body now carries its own code, `-32003`, so a client reading only `error.code` cannot confuse the refusal with a malformed request (`-32000`) or a session to re-initialize (`-32001`).

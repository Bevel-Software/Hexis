---
'@bevel-software/platform-core-backend': patch
---

A search pattern can never freeze the server for everyone. `grep` — the REST search, the agent's `grep` tool and `call_tool_chain`, one handler — runs the caller's regular expression in a pooled worker thread with a five-second matching budget per search, summed over every file it reads. Past the budget the worker is stopped and the call answers 400 `pattern_too_expensive` ("Pattern too expensive"); the event loop is never held, so every other request, the health check included, keeps answering. A directory walk that finds no worker free answers 503 rather than queueing without bound. Ordinary patterns match exactly as before.

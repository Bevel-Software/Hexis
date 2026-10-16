---
'@bevel-software/platform-core-backend': patch
---

A search pattern can no longer freeze the server for everyone. `grep` — the REST search, the agent's `grep` tool and `call_tool_chain`, one handler — runs the caller's regular expression in a pooled worker thread with a five-second matching budget per search, summed over every file it reads. Past the budget the worker is stopped and the call answers 400 `pattern_too_expensive` ("Pattern too expensive"). The matching never holds the event loop, which is where a catastrophic pattern used to stop every other request, the health check included; reading and preparing each file's text still runs in the request, as it did. Searches queue while every worker is busy, and a directory walk answers 503 only once that bounded queue is full. Ordinary patterns match exactly as before.

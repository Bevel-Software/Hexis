---
'@bevel-software/hexis-mcp': patch
'@bevel-software/platform-core-backend': patch
---

The local server survives its own orphans. A plugin root held by a
still-running stdio server from an earlier instance (EBUSY on Windows)
no longer costs the whole local server: materialization falls back to a
fresh sibling root and sweeps stale fallbacks age-gated. Shutdown is
deterministic — stdin EOF, SIGINT and SIGTERM close the UTCP client,
which terminates every spawned server, instead of trusting the pipe-EOF
cascade. The runtime contract doc now says a stdio server SHOULD exit
on stdin EOF.

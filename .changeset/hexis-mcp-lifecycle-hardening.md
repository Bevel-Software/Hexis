---
'@bevel-software/hexis-mcp': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The local server survives its own orphans. A plugin root held by a
still-running stdio server from an earlier instance (EBUSY on Windows)
no longer costs the whole local server: materialization falls back to a
fresh sibling root and sweeps stale fallbacks age-gated. Shutdown is
deterministic — stdin EOF, SIGINT and SIGTERM close the UTCP client,
which terminates every spawned server, instead of trusting the pipe-EOF
cascade. The runtime contract doc now says a stdio server SHOULD exit
on stdin EOF.

Review hardening on top: the MCP endpoint admits only externally-proxied
internal tokens (and a malformed token can no longer throw past
verification); OAuth discovery refuses non-HTTPS, non-loopback endpoints
and follows no redirects; exchanged local tokens are capped to the
OAuth grant's own remaining lifetime, and the local server renews them
proactively with single-flight refresh and a live remote-manual
credential swap; fallback plugin roots live in a reserved
`.hexis-fallbacks` namespace no plugin can name; mcp.json tool routes
match exactly one path segment and keep their query through the OAuth
fragment.

---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The connection probe tests the request a real call would send, and the tool page's verdict belongs to one tool. An auto-discovered OAuth sign-in now reaches a declared `healthCheck` (it froze its headers before the bearer was injected, and read its own 401 as a rejected credential); an `sse` server's probe speaks sse instead of being rebuilt as `http`; an `inline` manual's probe no longer inherits top-level headers its execution never sends; and probe variables fall back to `process.env` the way UTCP's own resolution does. On the page: the connection section is keyed by tool (no verdict survives navigation to another tool), a definition change releases an in-flight probe's hold on the Test button, a clean probe clears a stale transport-error banner, and a failed same-slug reload degrades the description instead of keeping the previous one.

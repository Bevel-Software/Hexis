---
'@bevel-software/platform-core-backend': minor
---

The agents' `grep` tool searches with ripgrep. A search over a workspace of 11,000 files no longer reads every file through the server's main thread: one `rg` child process walks the tree, sorted by path, and stops once `max_results` readable lines are found, so a search takes a fraction of a second and the server keeps answering everyone else while it runs. The answer keeps its shape and caps (`{ matches: [{ path, line, text }], truncated, note }`, 1-based lines cut to 300 characters, `max_results` default 200), and its matches now come in path-then-line order. It covers every text file under `path` that the caller may read, hidden and git-ignored files included. It never enters `.git` and never follows a symbolic link, and a file the caller may not read never contributes a line. Office, OpenDocument, PDF and email files are still searched through their extracted text, under the same per-call extraction budget.

Patterns are ripgrep's default engine's: RE2-style, with no look-around and no backreferences. A pattern the engine refuses is answered with a 400 (`invalid_pattern`) quoting its reason, and the tool's description says which patterns it takes. A search still stops at 5 seconds with the 400 `pattern_too_expensive`.

**New runtime requirement:** `rg` must be on the server's PATH. The server refuses to start without it, the way it refuses a git that is too old. The Hexis Dockerfile installs Debian's `ripgrep`; an image built from another Dockerfile must add it (`apt-get install ripgrep`).

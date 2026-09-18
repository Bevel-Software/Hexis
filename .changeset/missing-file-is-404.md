---
'@bevel-software/platform-core-backend': patch
---

A path with nothing at it now answers 404 on every file tool, with a stable error code. It used to depend on which tool was asked: `file_stat`, `grep` and `move_file` each answered 404 in their own wording, while `read_file`, `edit_file`, `delete_file` and `copy_file` let the filesystem's own `ENOENT` escape as a 500, and `unzip` called a missing archive unreadable (422) because the zip reader cannot tell "not there" from "not a zip". An agent could not tell "your path is wrong" from "this deployment is broken" — and a direct tool call hides the status entirely, so the 500s went unnoticed until a `call_tool_chain` run reported them.

All eight now give one answer: HTTP 404, `kind: "not_found"` beside the message, the requested path echoed back (sanitized, never the path on disk), and one sentence of next steps — "Check the path with list_files." The mapping lives in a single helper (`modules/workspace/not-found.ts`) that every tool routes its filesystem calls through, so a tool added later inherits it instead of re-deciding.

Two things deliberately do not change. A path the caller may not read still answers the read gate's 403, before absence is ever considered: a 404 there would confirm that nothing is at a path the caller was not allowed to ask about, and the absence of a name discloses as much as its presence. And a filesystem error that is not absence — a permission error, an I/O error, a symlink loop — is still a 500, with its raw code written to the operator log only; folding those into 404 would tell a caller to go and fix a name that was never the problem while an outage went unreported.

`scripts/missing-path-map.mjs` is the table this was built from: it calls every file tool against a missing path through `call_tool_chain` (the only surface that reports each tool's HTTP status) and exits non-zero unless all of them answer 404 `not_found`.

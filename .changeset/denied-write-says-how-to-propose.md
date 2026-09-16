---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-mcp-core': patch
---

When write_file, write_files, edit_file, move_file, delete_file, copy_file or mkdir is refused for permissions, the tool now returns a `write-denied` error instead of just the refusal text. The error has `path`, `reason` (who may write, or which role is excluded), and `canPropose`. If the caller can read the path and the branch accepts change requests, `proposal` lists three steps: create a branch from this one, repeat the same call on it, then `open_change_request` back into this branch. Otherwise, one sentence says why proposing is not possible. The refusal creates nothing. The descriptions of these tools now mention this route. Over MCP, a tool error with a `code` is passed on whole as JSON, so the agent receives these fields.

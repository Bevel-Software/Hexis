---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-mcp-core': minor
---

When write_file, write_files, edit_file, move_file, delete_file, delete_folder, copy_file or mkdir is refused for permissions, the tool now returns a `write-denied` error instead of just the refusal text. The error has `path`, `reason` (who may write, or which role is excluded), and `canPropose`. If the caller can read the path and the branch accepts change requests, `proposal` lists three steps: create a branch from this one, repeat the same call on it, then `open_change_request` back into this branch. Otherwise, one sentence says why proposing is not possible. The refusal creates no branch and no change request. The descriptions of these tools now mention this route. Over MCP, a typed refusal keeps its machine-readable fields: the message is followed by the rest of the body as JSON, so the agent can branch on `kind` and read the steps.

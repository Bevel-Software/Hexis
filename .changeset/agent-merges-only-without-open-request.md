---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
'@bevel-software/platform-mcp-core': minor
'@bevel-software/hexis-mcp': patch
'@bevel-software/platform-core-frontend': patch
---

An agent proposes and syncs; a person merges. The agent tool `merge_change_request` is removed from every agent tool set (hosted MCP, local `hexis-mcp`, in-app chat); calling the old name answers that a change request is merged by a person in the app. The new `merge_branch` tool (`source`, `target`) merges one branch into another as the caller, returning `merged` or `conflicts-need-resolution` with the conflicting paths. It refuses — naming the request — when a change request from `source` into `target` is open, and refuses a protected `target` unless the caller could commit every changed file directly to it — and always when the merge would change the protected branch's `roles.yaml`, as a change request's merge already never lets it (roles are changed in the app). Merging the target into the draft (the sync path) stays allowed while the draft's request is open. The knowledge-base guide (`AGENTS.md`) says the same.

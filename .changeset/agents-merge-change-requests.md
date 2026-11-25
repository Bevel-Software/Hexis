---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-mcp-core': minor
'@bevel-software/hexis-mcp': minor
---

Agents can apply a change request. `merge_change_request` is back in every agent tool set: it records the caller's approval on each file they may approve, then merges, exactly as Apply does in the app. The merge gate is unchanged, so an agent lands only what its user could land, and is refused, with the reasons, while a file waits on another owner. `merge_branch` still refuses a draft whose request is open and now points at the tool. The retired-tool answer ("a change request is merged by a person in the app") and the `RETIRED_TOOL_*` exports of `platform-mcp-core` are removed.

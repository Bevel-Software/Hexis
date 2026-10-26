---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
---

A branch listing no longer counts commits. `listBranches` — the `GET /api/workspace/:id/workflow/branches` route, the `list_branches` tool, the branch switcher, `switch_branch`'s check, the access-request and join-request flows and the workflow service's own uses — used to run one to three `git rev-list` per branch to say how far each was ahead of and behind its upstream, about 120 git processes a listing on a knowledge base with 121 branches, for numbers no listing reader showed. It now runs only its fetch and the two reads of the repository's refs, whatever the number of branches. `BranchInfo` loses `ahead` and `behind`, and the `list_branches` tool's output schema loses them with it; `createBranch`'s answer carries no counts either.

`branch_status` still answers `ahead`, `behind` and `behindRemote` for the branch it is asked about, with the same values and the same nulls: it counts that one branch, through the new `branchCounts(workspaceId)` on `IGitService` and `IWorkflowService` (the workspace's own branch against its upstream, or the protected branch on origin it is fewest commits ahead of; null when neither resolves). Code that read `ahead` or `behind` from a listed branch reads `branchCounts` for that branch instead.

---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

A write whose push the repository host refuses now says so and stays saved locally, on every operation.

Reverting a file in a change request, opening a change request, updating one from its target, the roles.yaml preservation before a merge, and sharing a branch used to push with the bare push, which rethrew git's own error — and the route turned that into 500 "Internal server error". They now go through the same recovery path a save uses: the local result stays (the file is reverted, the request exists, the merge is applied), the answer is 409 with the saved-locally sentence naming the branch, and the branch's sync banner goes up. The next push of the branch that lands carries the commits and clears the banner. A non-fast-forward still takes the cooperative pull-rebase first, now replaying merges for the two operations that push one.

When the host refused rather than diverged, the sentence says so: "Saved locally on "<branch>" but couldn't share with the team automatically — the repository host refused the push. The next save on this branch shares it."

Deleting a branch is the exception: the remote deletion now runs first, and when the host refuses it nothing is deleted — the answer is 409, "The repository host refused to delete "<branch>"; it is still there. Try again later."

Git's output no longer reaches the browser for a failed push. The 409 payload drops `originalDetail` and `recoveryDetail` (both stay on the error for the server log), and the `git-sync-failed` event's `reason` is a fixed sentence naming the kind of failure — credentials, an unreachable host, a divergence, or a refusal — rather than sanitised git stderr.

The change-request view watches its source branch's workspace while open and shows that branch's sync banner, which clears there when the push lands. `GitSyncFailedBanner` takes an optional `workspaceId` for a surface about a branch other than the focused one.

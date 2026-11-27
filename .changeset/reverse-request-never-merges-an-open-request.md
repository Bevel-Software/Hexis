---
'@bevel-software/platform-core-backend': patch
---

Refreshing a change request from its target no longer merges an open request's source into its target. While a request from x into y is open:

- opening one from y into x skips the usual refresh of y from x, which would have landed the open request's unreviewed changes on y and emptied it. The new request opens, and the open one keeps its files and stays open;
- Update on a request from y into x (the request dialog runs it by itself when the request is behind) is refused with the same `open-change-request-blocks-merge` answer `merge_branch` and `update_branch` give, and nothing is merged.

Both go through one refresh that asks the guard under both branches' lifecycle keys, and merges and pushes in one reservation of the branch's workspace, so no save lands between the two.

The `open_change_request` tool description says so. The agent guide's drafts-and-change-requests section no longer says opening a request always brings the latest target into the draft; the tool description is the one place that says when it does.

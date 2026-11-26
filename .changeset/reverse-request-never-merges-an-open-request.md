---
'@bevel-software/platform-core-backend': patch
---

Opening a change request no longer merges an open request's source into its target. While a request from x into y is open, opening one from y into x skips the usual refresh of y from x, which would have landed the open request's unreviewed changes on y and emptied it. The new request opens, and the open one keeps its files and stays open.

The `open_change_request` tool description says so. The agent guide's drafts-and-change-requests section no longer says opening a request always brings the latest target into the draft; the tool description is the one place that says when it does.

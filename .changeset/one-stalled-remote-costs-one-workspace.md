---
'@bevel-software/platform-core-backend': patch
---

The commit worker now drains up to four workspaces at once instead of one at a time across the whole deployment. Within a workspace nothing changes: its rows still land in order, one commit in flight, because they share a clone. Across workspaces the change is containment. A git host that has stopped answering used to park every other user's save behind the one stalled push, since the worker moved through workspaces strictly in sequence; now it costs that one workspace the git deadline and nobody else anything.

Two spellings of the same workspace — the decoded form a route hands over and the encoded form a directory listing reports — are recognised as one clone before any draining starts side by side, so the concurrency can never put two drains into one working tree.

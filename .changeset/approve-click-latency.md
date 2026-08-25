---
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-shared": patch
---

Approving or withdrawing a file in a change request answers in a fraction of the time it took. The access model read at a git ref is now built once per commit and shared by every permission check that lands on that commit (one click used to rebuild it six times); a change-request detail fetches its two refs once and pins its file list to the commits it resolved; and the internal detail an approve, withdraw, or revert reads skips per-file patches (the detail served to clients keeps them). A git read failure while building the access model now fails the operation closed with a 503 instead of answering from a partial tree.

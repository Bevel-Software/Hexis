---
'@bevel-software/platform-core-backend': patch
---

A write tool's `write-denied` answer now gives "you cannot read this path" as its `cannotProposeReason` whenever the caller cannot read the path, on every branch. Before, on a branch that takes no change requests it named the branch instead, which sent the agent to another branch for the same refusal. A caller who can read the path on such a branch still gets the branch sentence, and so does one whose read access could not be determined there.

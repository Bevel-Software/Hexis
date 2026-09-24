---
'@bevel-software/platform-core-backend': patch
---

The agent filesystems judge a path against the repository's git folder in one pass instead of two. They used to ask the rule twice per read — once for the caller's spelling and once for the place they put it — so the root was resolved twice and a place both name was probed twice on every read. One call now judges both: every reading of the spelling is still probed, and so is the resolved place, with the root walked once and each place once.

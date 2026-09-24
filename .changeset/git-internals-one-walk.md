---
'@bevel-software/platform-core-backend': patch
---

The agent filesystems judge a path against the repository's git folder with one walk of the disk, not two to four. They used to ask the rule twice per read — once for the caller's spelling, which probes every way that spelling could land, and once for the place they put it — so a listing- or grep-heavy session paid several `realpath` chains per path on top of the one that decides. One call now judges every spelling lexically and probes the resolved place once.

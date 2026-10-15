---
'@bevel-software/platform-core-backend': patch
---

A change-request listing starts no git process when nothing has moved. Where a branch tip points is read from the repository's own ref files (the loose ref, or `packed-refs`, a symbolic ref followed, a worktree's shared refs included) instead of a `git rev-parse` per tip; git is asked only for what the files cannot decide, such as a tag it would have to peel. The files a request changes are read from git once per pair of commits and remembered under that pair: a push moves a tip, the pair changes, and that one request is diffed again. The own access entries of a path at a commit are remembered the same way, so the access gates a listing runs at every open request's two refs read each path once per commit. On a knowledge base with a hundred open requests a listing started three to four git processes per request on every read; now it starts none until someone pushes.

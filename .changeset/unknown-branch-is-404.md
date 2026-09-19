---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Naming a branch that never existed now answers 404, and 410 is kept for a branch that was deleted. Origin refusing a clone with "no such ref" is one git failure with two very different stories behind it, and the platform told both of them the same way: a tester who asked for a branch nobody ever created was informed it "no longer exists on the remote", which states that it once did.

Which story it is depends on whether the platform has ever heard of the name. A branch it cloned — registered in this process or sitting on disk from an earlier one — or a branch any listing of origin's branches has shown it, is a branch that was deleted: 410 `remote-branch-gone`, exactly as before. A name nothing has ever shown it is not a branch at all: 404 `branch-not-found`, saying "There is no branch named &lt;name&gt;." and nothing else — no git output, no remote URL.

The memory of listed names accumulates rather than being replaced by each listing, because the listing that proves a branch is gone is precisely the one that no longer names it. It lives in memory only: a restart forgets a deleted branch whose clone was already swept off disk, and that name then reads as unknown — which is exactly what the platform then knows about it.

In the browser, the file page keeps its deleted-branch screen for 410 and shows a "Branch not found" screen for 404, in the shape the missing-file screen already uses. On the agent surface, a tool refusal now carries the domain payload beside its message the way the HTTP routes always have, so a caller can switch on `branch-not-found` versus `remote-branch-gone` instead of reading the prose. An unreachable host or a refused credential is untouched by all of this: it stays our failure, not the branch's.

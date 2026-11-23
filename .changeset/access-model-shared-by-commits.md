---
'@bevel-software/platform-core-backend': patch
---

Commits with the same access files share one access model. The at-ref gates (change-request approvals, pushes, writes on a protected branch) build a model per commit they are asked at; the model is now keyed by what it is derived from (roles.yaml, the groups sources, every `access.md` and plugin manifest, each by path and object id), so a branch head that moves without changing any of them costs one `git ls-tree` and no read or parse of the access files, and the commits it moved through hold one model between them. A commit that changes an access file is read as before, and one that puts earlier rules back takes the model still held for them. What the gates answer is unchanged.

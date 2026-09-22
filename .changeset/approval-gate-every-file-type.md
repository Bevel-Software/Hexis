---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': patch
---

The change request merge gate now counts every touched file that has an eligible approver, whatever its type: extensionless and binary files need an approval just as Markdown notes do. A missing approval is a blocking reason on the request detail (`mergeBlockedReasons`) and keeps `mergeableInBevel` false until it is resolved; `mergeWarnings` still lists the missing approvals, and an admin may merge past them with the bypass flag exactly as before, with the bypassed files recorded in the merge commit. The `merge_change_request` agent tool, whose description limited the gate to `.md` files, is retired: a change request is merged by a person in the app.

---
'@bevel-software/platform-core-backend': minor
---

Applying a change request lands the commit its approvals were checked against, or nothing.

Apply reads a request (its head and the approvals on that head), asks the gate, and then fetches the branch again to merge it. A push that landed between the reading and that fetch was merged with the rest, on approvals given to the commit before it. The app's Apply had this gap; the agent `merge_change_request` tool made it easy to hit, since an agent edits a draft and applies it in the next call.

`GitService.mergeChangeRequest` takes `expectedSourceHead`. On every attempt, after its fetch and after it has reset the clone to the published target, the merge reads the source's published commit once. When `expectedSourceHead` is given and that commit is another one, it refuses with the new `SourceHeadMovedError` (409, `{ kind: 'source-head-moved' }`): nothing is merged or pushed, and the clone is left on the published target with nothing uncommitted, also when an earlier attempt's push was rejected. The commit it read is the one it merges, by its id, and the one whose paths it hands `authorize`. Before this change the merge and `authorize` each read the source's ref for themselves.

`ChangeRequestReviewService.mergePr` passes the head its gate judged and answers a moved head as a gate refusal (422, `mergeBlockedReasons`): "This request changed after its approvals were checked, so it was not applied. Open it again to see what changed, then apply it once more." The reason names no file. Applying again reads the new head, and the gate then says which approvals it still waits on.

After a merge, the request's branch is deleted only while it is still at the merged head (`expectTip`). A commit pushed to the branch after the merge read it keeps its branch; before, the branch was deleted by name and that commit with it.

Upgrade note: `mergeChangeRequest` gains one optional option and `shared/domain-errors.ts` one error class. Nothing is removed or renamed, and a caller that passes no `expectedSourceHead` merges as before.

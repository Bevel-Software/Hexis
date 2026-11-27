---
'@bevel-software/platform-core-backend': patch
---

Applying a change request lands the commit its approvals were checked against, or nothing.

Apply reads a request (its head and the approvals on that head), asks the gate, and then fetches the branch again to merge it. A push that landed between the reading and that fetch was merged with the rest, on approvals given to the commit before it. The app's Apply had this gap; the agent `merge_change_request` tool made it easy to hit, since an agent edits a draft and applies it in the next call.

`GitService.mergeChangeRequest` takes `expectedSourceHead`. When it is given, the merge reads the source's published commit once after its fetch and refuses with the new `SourceHeadMovedError` (409, `{ kind: 'source-head-moved' }`) unless it is that commit, before anything is checked out, merged or pushed. It also merges that commit by its id, and hands `authorize` the paths of that same commit, where both read the branch's ref a second time. `ChangeRequestReviewService.mergePr` passes the head its gate judged and answers a moved head as a gate refusal (422, `mergeBlockedReasons`): "This request changed after its approvals were checked, so it was not applied. Open it again to see what changed, then apply it once more." The reason names no file. Applying again reads the new head, and the gate then says which approvals it still waits on.

Upgrade note: `mergeChangeRequest` gains one optional option and `shared/domain-errors.ts` one error class. Nothing is removed or renamed, and a caller that passes no `expectedSourceHead` merges as before.

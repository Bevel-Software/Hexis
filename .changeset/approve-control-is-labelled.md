---
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
---

Approving a file in a change request no longer means finding an unlabelled green check in the file tree. The selected file's header now ends with a labelled button — "Approve this file", or "Approved – Undo" once your approval is on it — and nothing for a file you cannot approve. The tree keeps its check as a status mark only, named "Approved by you" or "Waiting on your approval". Above the Apply button the footer says "Your approval is needed on N files", with "Approve all mine" when more than one waits on you (approved one after another, one error banner if any fails), or "Waiting on <names>" when none of it is yours.

Each file in a change request's approvals now carries `inMergeGate`, the server's verdict on whether the merge gate binds it (markdown and access config with an eligible approver). The review screen reads that flag instead of re-deriving the rule, so files the gate ignores are never counted as waiting on anyone.

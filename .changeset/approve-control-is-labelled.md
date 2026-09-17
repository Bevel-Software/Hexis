---
'@bevel-software/platform-core-frontend': patch
---

Approving a file in a change request no longer means finding an unlabelled green check in the file tree. The selected file's header now ends with a labelled button — "Approve this file", or "Approved – Undo" once your approval is on it — and nothing for a file you cannot approve. The tree keeps its check as a status mark only, named "Approved by you" or "Waiting on your approval". Above the Apply button the footer says "Your approval is needed on N files", with "Approve all mine" when more than one waits on you (approved one after another, one error banner if any fails), or "Waiting on <names>" when none of it is yours.

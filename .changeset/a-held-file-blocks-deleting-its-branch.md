---
'@bevel-software/platform-core-backend': patch
---

A file held for editing in the app is now seen on every branch by the deletion paths that check for one: an agent's `delete_branch` refuses the branch, and the background close of empty change requests and the cleanup of branches left over from merged requests leave it.

The app takes its file locks under the workspace id the route decoded (`alice/draft`), while those checks asked under the encoded one (`alice%2Fdraft`), so on any `<name>/…` branch a held file went unseen and the branch could be removed with a file on it held. The lock store now keys every lock on one canonical workspace id, the same one queued saves use, so both spellings find it. A lock taken before the upgrade, under the decoded id, is still seen, refreshed and released until it expires.

This also changes who a held file is held against. On a `<name>/…` branch, a file held in the app and the same file taken by an agent's edit used to be two separate locks, so each could write over the other. They are now one lock: an agent's edit of a file someone holds in the app retries briefly and is then refused, naming who holds it, and the app shows a file an agent holds as locked. Likewise, merging a request whose source branch changes `roles.yaml` is now refused while someone is editing that file on the branch in the app, as it already was on branches without a `/`.

Unchanged: deleting a branch in the app's branch switcher and removing a request's source branch when the request is merged do not check for held files, as before. A held file on a request's source branch does keep the switcher from closing that request as empty.

---
'@bevel-software/platform-core-frontend': patch
---

What lands for everyone reads as published, never as pushed or merged. An applied change request's notice is "Published: the file now reads with that change." (was "Applied: …"), and access edited on a change request "takes effect when the request is published". The reviewer's own action keeps its name.

The server's merge messages are translated where the app shows them (a refused or failed apply, the stored reason other viewers see, the "waiting on" line): "Merge gate rejected: …" becomes "Can't publish this yet. …", "Merge failed" becomes "Couldn't publish this change.", "already been merged" becomes "already published", "after the latest push" becomes "after the latest changes", and the admin-bypass refusal becomes "Only an admin can publish a change before everyone has approved it." `friendlyGitMessage(raw)` is the string form of `friendlyGitError` for messages that arrive as text.

A link to a deleted draft says "Anything published from it lives on …", a missing one "It may never have been published", the save-first screen no longer explains locks, commits and pushes, and the repository-move warning in Settings talks about work that "hasn't reached your git host yet".

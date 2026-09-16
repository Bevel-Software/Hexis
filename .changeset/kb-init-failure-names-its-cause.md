---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A failed knowledge-base initialization at the end of setup now says what went wrong — credentials rejected, repository not found, host unreachable, a token that cannot push, a branch protection rule or hook that refused the push, a failed startup step (named), or an unlisted reason — with one sentence on what to do, and offers a "Retry initialization" button. The raw error stays in the server log, with the token in effect scrubbed whether it came from the environment or the setup screen.

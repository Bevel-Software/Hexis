---
'@bevel-software/platform-core-backend': patch
---

Opening a change request that proposes nothing closes it, as before, and the server log line for that close now names the person by user id instead of email address, like every other branch-deletion and close line. Before, this one line still carried the opener's email address.

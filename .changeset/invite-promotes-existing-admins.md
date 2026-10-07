---
'@bevel-software/platform-core-frontend': patch
---

Inviting someone who already has an account as Admin makes them an Admin.

The invite dialog used to promote only the accounts it created. Now an existing account invited as Admin is added to the Admin role too, and its row says "now an admin"; someone who is already an Admin, including a deployment admin fixed by the server configuration, is left as they are and reported as such.

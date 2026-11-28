---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Set password and Reset password on the User accounts page change the account on that row and never make one. The dialog used to send the address to `POST /api/admin/accounts`, which makes an account when none has that address, so a Reset confirmed after another admin had deleted the account made a new account with that password. The dialog now sends the account's id to the new `POST /api/admin/accounts/:userId/password`, which writes by id only. An account deleted before the write lands, also between the server reading it and writing the password, is refused with 404 and "This account no longer exists." and nothing is created; the dialog shows those words and reads the list again. The new route keeps the refusals the old path had for a password: the platform's own accounts, the deployment admin, the owner when another admin asks, and the password policy. `POST /api/admin/accounts` keeps its upsert by address for invitations and the API.

---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The App roles page now shows the deployment admin. The account the server configuration names (`ADMIN_EMAIL`) is an Admin whatever `roles.yaml` says — the rescue path for a roles file that has lost its last admin — but the page never showed it, so removing that account from Admin looked like it should work and silently did nothing.

Admin now lists that address as a fixed member, with the note "Deployment admin, set in the server configuration; cannot be removed here" and no remove control. Adding it as a regular member is refused with the same explanation, and so is removing it. An address the roles file names as well is listed once, as fixed; every other Admin membership is unchanged and still takes effect on the member's next request. The agent guide's roles paragraph now says the deployment admin is always an admin.

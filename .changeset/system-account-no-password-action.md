---
'@bevel-software/platform-core-frontend': patch
---

User accounts: an account the platform runs its own work as (such as the recovery bot) is labelled "System account — nobody signs in with it" instead of "signs in with single sign-on", and no longer offers Set password or Reset password, which the server refuses for it. One whose address is also the deployment admin (`ADMIN_EMAIL` with `ADMIN_PASSWORD` set while password login is enabled) still reads as the deployment admin, since it does sign in with the environment password.

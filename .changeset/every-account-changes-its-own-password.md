---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-shared': patch
---

Every account except the deployment admin changes its own password from the Account page, and the deployment admin is told theirs is set in the environment.

The report was that an administrator could not change their password where a business user could. The Admin role turned out to have nothing to do with it: it is a `roles.yaml` fact read by the admin screens, and it never reached the password change, so an Admin-role account and a business user always took byte-identical paths — reproduced on both, current password required, same policy, old password refused afterwards.

The account that really could not was the deployment admin, the one whose email is `ADMIN_EMAIL` while `ADMIN_PASSWORD` is set. That credential is checked against the environment before any stored hash, and the account starts with no hash — so the change ran down the "SSO-only account sets its first password" path, which asks for no current password. A wrong one was accepted with a 200. Nothing was replaced: the environment password kept signing in beside the new one, the planted hash outlived rotating `ADMIN_PASSWORD`, and every later attempt that typed the environment password as the current one was refused against that stray hash — which is what the tester saw. Any holder of that session could plant a lasting credential without knowing a password.

The service now refuses a password change for the deployment admin outright — from the Account page and from an admin's "Set password" on the User Accounts page alike, since a hash planted from either is the same stray second credential — before the policy check so the refusal names the real reason, and `AuthUser` carries an `isEnvAdmin` flag derived from configuration on every read — never stored, and carrying no part of the credential. The Account page reads it and shows, in place of the form, that this account's password is set in the deployment environment and cannot be changed there; the User Accounts page says the same on that row instead of offering a button that can only fail. That is deliberate rather than an omission: the environment password is the rescue path into a deployment, so it has to keep working and has to be changed where a deployment can always reset it. Unset `ADMIN_PASSWORD` and the same account is an ordinary one again, form and all.

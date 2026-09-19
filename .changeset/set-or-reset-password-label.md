---
'@bevel-software/platform-core-frontend': patch
---

User accounts now names the two password actions apart. An account with no password of its own is offered "Set password", and the dialog says that from now on they will be able to sign in with this one as well as with single sign-on. An account that already has one is offered "Reset password", and that dialog says their current password stops working immediately and this one takes its place — then asks, so the admin confirms taking a working credential away rather than discovering it afterwards. The banner that follows reports the act that happened, "Password set" or "Password reset". The deployment admin's row is unchanged: it offers neither action, with or without a stored hash, and still says its password is set in the deployment environment. Which of the two an account gets is decided by `hasPassword`, the flag the list already carries for the sign-in method line — nothing further about the credential is read or shown.

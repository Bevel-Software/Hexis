---
'@bevel-software/platform-core-backend': patch
---

The allowed email domains on the Single sign-on card apply without a restart, like the provider settings beside them: an SSO sign-in governed by the list reads the list in effect (the `ALLOWED_EMAIL_DOMAINS` environment variable, else the saved value), so a save applies to the next sign-in on the replica that served it and no longer answers `restartRequired`. Erasing the field clears the list, as its help text says, and everyone the provider authenticates can sign in again.

---
'@bevel-software/platform-core-backend': patch
---

The allowed email domains on the Single sign-on card apply without a restart, like the provider settings beside them: an SSO sign-in governed by the list reads the list in effect (the `ALLOWED_EMAIL_DOMAINS` environment variable, else the saved value), so a save applies to the next sign-in on the replica that served it and no longer answers `restartRequired`. When the environment variable is not set, erasing the field clears the saved list, as its help text says, and everyone the provider authenticates can sign in again. A value that names no domain, or a token that is not a domain, is refused on save rather than saved as a list the check would read as no guard. Other replicas keep the list they read at boot until they restart, as they do for the provider settings.

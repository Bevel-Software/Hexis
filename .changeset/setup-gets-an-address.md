---
'@bevel-software/platform-core-frontend': patch
---

Deployment settings get a permanent address. The first-run setup form —
knowledge-base connection, branch model, single sign-on — is now also an
admin settings page at `/deployment`, so adding SSO (or rotating its
client secret, or renaming a branch) after setup no longer means finding
the right environment variable. Same form, same env-lock rule, same
connection test; the backend accepted these writes all along — only the
door was missing.

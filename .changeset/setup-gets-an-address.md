---
'@bevel-software/platform-core-frontend': patch
---

Deployment settings get a permanent address. The first-run setup form
(repository connection, branch model, single sign-on) is now also an
admin settings page at `/deployment`, so SAVED settings can be added or
changed after setup — adding SSO later, rotating its client secret,
renaming a branch. Values managed by the environment stay read-only
there, named and locked, and still change where they are set. Same form,
same rules, same connection test; the backend accepted these writes all
along — only the door was missing.

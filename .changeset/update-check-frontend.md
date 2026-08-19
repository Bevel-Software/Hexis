---
'@bevel-software/platform-core-frontend': minor
---

Admins now see a quiet, dismissible banner when a newer Hexis release is
published — "Hexis x.y.z is available — see what's new", linking to the
release notes. Checked once per app load through the new `/api/update-check`
endpoint (no polling); dismissing remembers the version, so the banner only
returns when a later release appears. Non-admins never fetch or see it.

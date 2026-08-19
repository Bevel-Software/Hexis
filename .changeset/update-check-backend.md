---
'@bevel-software/platform-core-backend': minor
---

New admin-only `GET /api/update-check` endpoint: the server lazily asks
GitHub for the newest published Hexis release — only when requested, cached
for ~6 hours, never on a timer — compares it against the running version, and
answers `{ updateAvailable, current, latest?, notesUrl? }`. The request goes
to api.github.com and carries no credentials, identifiers or telemetry; a
failed fetch is cached briefly and reported as "no update", so offline and
air-gapped deployments stay quiet. Set `UPDATE_CHECK=false` to disable the
check entirely (no network call is ever made).

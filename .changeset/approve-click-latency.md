---
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-shared": patch
---

Approving or withdrawing a file in a change request answers in a fraction of the time it took. The access model read at a git ref is now built once per commit and shared by every permission check that lands on that commit (one click used to rebuild it six times), a change-request detail fetches its two refs once instead of twice, and it no longer renders a per-file patch that nothing reads (`files[].patch` is absent from the detail payload).

---
"@bevel-software/platform-shared": patch
"@bevel-software/platform-mcp-core": patch
"@bevel-software/hexis-mcp": patch
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-core-frontend": patch
---

Fixes from the review of the 0.36.0 release, before it was published:

- A managed sign-in's replacement (a typed value, a registered app, a pinned own app, a sign-in started over it) is guarded on the ciphertext its revoke read, as its deletion already was: a refresh or a broker handoff landing in between is not overwritten unrevoked. An account erasure revokes and deletes the person's managed rows inside its own transaction as well, under a row lock, so nothing cascades away unrevoked.
- A broker refresh is bounded (15 s) like a revocation; a broker that does not answer is an outage, and the stale token is served.
- A managed sign-in whose connector the distribution does not know is not startable, on the card and on the start route.
- Managed connector cards carry the Connect page's include/skip control; a card whose workspace connection has an own app pinned says so instead of asking for a broker.
- `AppDef.roots` refuses a path or a blank where one top-level folder name is expected.
- The tool page treats a shared row as a sign-in's registration only when it is of the OAuth kind; `adminKind` is always sent.
- The shared file rules keep a default-branch name holding a backtick inside one code span, and their caps are measured with the longest branch name the platform accepts.

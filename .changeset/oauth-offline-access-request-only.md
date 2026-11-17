---
"@bevel-software/platform-core-backend": patch
---

A tool that signs in with Microsoft (the Microsoft 365 tool, a Teams tool on Microsoft Graph) no longer shows "Needs signing in again" forever. Microsoft grants `offline_access` (its token response carries a refresh token) but never lists it in the `scope` it echoes, and the scope check required every declared scope back. `offline_access` is now request-only: it is still sent in the authorize request, and never required back. Every other declared scope is still required, including when the granted scopes are unknown.

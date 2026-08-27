---
'@bevel-software/platform-core-backend': patch
---

A sign-in whose provider echoes no `scope` on the token response is no longer flagged "sign in again" forever. RFC 6749 §5.1 makes `scope` optional when the grant matches the request, and providers such as HubSpot leave it out — the vault used to read that silence as "nothing granted", so every declared scope counted as missing and the tool was blocked at call time. The scopes a consent asks for are now remembered with the pending sign-in and recorded as the grant when the provider stays silent; an echoed `scope` still wins, narrower grants included.

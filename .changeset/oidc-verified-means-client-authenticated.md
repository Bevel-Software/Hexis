---
"@bevel-software/platform-core-backend": patch
---

The sign-in configuration check no longer labels made-up credentials Verified against Microsoft Entra. Entra refuses the test code (`invalid_grant`) before it checks the client, so a code refusal now counts as proof only when the provider also refuses a made-up client with `invalid_client`; otherwise the configuration saves as "could not be verified". `invalid_client` is still refused.

---
"@bevel-software/platform-core-frontend": minor
---

The auth module's entry now offers what a deployment needs to build its own sign-in pages: `LoginScreen`, and from the SSO service `startSsoLogin`, `OAUTH_ERROR_KEY` and the `SsoProvider` type. A deployment that signs a person in before linking an account or connecting a tool reused these from the module's files, past its entry; it can now import them from `modules/auth` like the rest of the module's surface. Nothing else changes.

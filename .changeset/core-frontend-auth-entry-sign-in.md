---
"@bevel-software/platform-core-frontend": minor
---

The auth module's entry now offers the SSO start a deployment needs to build its own sign-in pages: `startSsoLogin`, `OAUTH_ERROR_KEY` and the `SsoProvider` type. A deployment that signs a person in before linking an account or connecting a tool reused these from `auth/services/sso.ts`, past the entry; it can now import them from `modules/auth`. `LoginScreen` stays where it is: a component is composed by its file (`auth/components/LoginScreen.tsx`), which the module boundary rule allows, and the entry does not re-export it. Nothing else changes.

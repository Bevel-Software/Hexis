---
'@bevel-software/platform-core-frontend': minor
---

A new account lands in the knowledge base, not on the Connect your agent page.

Choosing where the knowledge lives is the only step before the app; connecting an agent waits in the Get set up list and the sidebar's Connect your agent pill, both of which open the page, as does the profile menu. `/` now goes to the knowledge base for everyone, or to the link an SSO sign-in carried through its round-trip. The per-browser "already welcomed" note (`bevel.onboarding.welcomed.*`) is no longer written or read, and `useOnboarding()` no longer returns `shouldWelcome` or `markWelcomed`.

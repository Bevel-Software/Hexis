---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

A sign-in provider can say it has decided admission itself. `AuthService.loginWithSso` takes an optional third argument, `{ admittedByProvider: true }`, and then does not apply the domain allow-list (`ALLOWED_EMAIL_DOMAINS`) on top of the provider's own rule. The allow-list exists for a provider that decides nothing about who may enter; laid over one that does, it refused people the provider had let in, such as an invited address outside the list. The account admission port is asked either way.

Nothing changes for a provider that does not pass the option: core's own OIDC provider is governed by the allow-list as before. The field's help text on the setup screen says it applies to sign-in through that provider.

---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

An admin can remove a saved single sign-on provider. The Single sign-on card has a Remove single sign-on control, and `POST /api/setup/settings` takes `null` for the provider address, application ID and secret to remove their saved values. A blank provider address, application ID or secret still leaves that value unchanged, and `null` for any other setting is refused. Removal applies at once: `/api/auth/providers` stops listing the provider and the sign-in page stops offering it, with no restart and no check against the provider. A value set by the environment cannot be removed this way. Removing the provider address is refused while its secret stays: the saved secret unless a new one comes in the same save, and a secret set by `OIDC_CLIENT_SECRET` always. So the secret is never paired with the next provider saved. Accounts are not touched.

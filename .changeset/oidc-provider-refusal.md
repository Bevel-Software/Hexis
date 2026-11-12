---
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-core-frontend": patch
---

When the sign-in provider refuses a sign-in (`access_denied`), the login screen says the provider did not let you sign in, instead of "Sign-in could not be verified. Please try again." Any other error the provider sends back is shown as a failed sign-in. A forged or missing state is still reported as before.

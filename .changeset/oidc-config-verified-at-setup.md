---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Single sign-on settings are checked with the provider before they are saved. A new "Test sign-in configuration" button fetches the issuer's discovery document (after the outbound-URL safety check), then sends a token request with a made-up code and the application ID and secret, the same way the real callback does. It reports whether the issuer could be reached, whether it is an OIDC issuer, and whether the provider accepted the credentials. A save that changes the issuer, application ID or secret runs the same check. If the provider turns the values down, nothing is saved and the problem shows on the issuer or secret field. If the answer is inconclusive, the values are saved and marked Unverified. Saves that change only scopes, the button label or allowed domains are not checked. The Deployment page and the setup screen show Verified, Unverified (sign in once to confirm) or Not configured, and a successful OIDC sign-in marks the configuration Verified.

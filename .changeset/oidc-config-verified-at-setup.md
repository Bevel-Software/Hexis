---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Single sign-on settings are checked with the provider before they are saved. A new "Test sign-in configuration" button fetches the issuer's discovery document, then sends a token request with a made-up code and the application ID and secret, the same way the real callback does. It reports whether the issuer could be reached, whether it is an OIDC issuer, and whether the provider accepted the credentials. The check follows the same rules as signing in: the issuer must use https, and a provider on a private network is checked like any other. A save that changes the issuer, application ID or secret runs the same check. If the provider turns the values down, nothing is saved and the problem shows on the issuer or secret field. If the answer is inconclusive, the values are saved and marked Unverified. Saves that change only scopes, the button label or allowed domains are not checked. The saved application secret is only ever sent to the provider it was saved for. The Deployment page and the setup screen show Verified, Unverified (sign in once to confirm), Not configured, or Not recorded when SECRETS_ENC_KEY is unset, since verification cannot be kept without it. A successful OIDC sign-in marks the configuration Verified.

A provider whose discovery document names a token or userinfo endpoint that is not https is now refused as a sign-in provider.

Credentials written into `PUBLIC_BACKEND_URL` (`https://user:pass@host`) are now ignored, with a warning in the log that does not print them. They used to be passed on to identity providers and OAuth providers in redirect addresses, and to browsers in the app's configuration.

Tool and MCP server addresses given as an IPv6 literal are now refused unless the address is public, in every spelling of it. Private IPv4 addresses were already refused.

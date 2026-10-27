---
'@bevel-software/platform-core-backend': patch
---

A sign-in that the provider's token endpoint refuses now says why. The error carried only the HTTP status ("Token endpoint returned HTTP 400"), so the log could not tell a redirect URL mismatch from a wrong client secret or a reused code. The message now ends with the provider's own reason, read from the refusal's body: the OAuth `error` and `error_description`, a provider's `status` and `message` pair where that is its shape, or the body's first line, in one line of bounded length, with any secret the request carried (client secret, code, PKCE verifier, refresh token) redacted should the provider echo it. The callback route's "oauth callback failed" log line carries it, and so does the new warning logged when a refresh is refused and the sign-in is wiped, which until now left no trace. The Connect page's message is unchanged.

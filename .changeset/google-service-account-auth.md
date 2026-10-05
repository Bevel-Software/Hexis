---
'@bevel-software/platform-core-backend': minor
---

A `.tool` can now call a Google API as a service account, with `auth_type: google_service_account` on an inline tool's call template.

Google Ads, Tag Manager, BigQuery and most other Google APIs are called as a service account when a team shares one connection rather than each person signing in. Google does not accept the service account's key on a call; it accepts a short-lived token minted from the key by signing a request with its private key. A `.tool` could only fill headers from the Secrets Vault, so there was no way to express that, and a deployment had to run a token service of its own beside the platform.

The `auth` block names the key's vault variable, the scopes and, for domain-wide delegation, a subject:

```yaml
auth:
  auth_type: google_service_account
  credentials: ${GOOGLE_SA_KEY}
  scopes: https://www.googleapis.com/auth/adwords
```

At call time the platform signs an RS256 assertion with the key, exchanges it at Google's token endpoint, and sends the result as `Authorization: Bearer <token>`. A token is kept until a minute before it expires, one per key, scope set and subject, and calls that ask at the same moment share one exchange. The token always comes from `https://oauth2.googleapis.com/token`; a `token_uri` inside the key is ignored, so a stored key cannot send a signed assertion anywhere else. An error names the service account and Google's reason, never the key.

The key variable surfaces in the secrets UI and in `list_tool_setup` like any other `${VAR}`, admin-scoped by default. The AGENTS.md template documents the block with a Google Ads example.

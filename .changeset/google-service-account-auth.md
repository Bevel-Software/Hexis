---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-mcp-core': minor
'@bevel-software/hexis-mcp': minor
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

The auth type lives in `@bevel-software/platform-mcp-core` and is registered when that package loads, once per process, so the hosted platform and the local `hexis-mcp` server both understand it: a `remote: false` tool that names it mints its token on the machine it runs on.

The block works on one thing, an inline tool's `http` call template. On any other call template (`sse`, `streamable_http`, `mcp`), or on a tool that discovers its tools from a `url`, no token would be sent and every call would reach Google unauthenticated. Such a `.tool` is now refused when it is read, and `list_tool_setup` names it under `invalid` with where the block was found.

The key variable surfaces in the secrets UI and in `list_tool_setup` like any other `${VAR}`, admin-scoped by default. The AGENTS.md template documents the block with a Google Ads example, and points to a sign-in variable for the case where each person should call Google as themselves.

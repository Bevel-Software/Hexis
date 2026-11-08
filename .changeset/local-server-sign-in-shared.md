---
"@bevel-software/hexis-mcp": minor
---

The local server's processes for one agent on one machine share one browser sign-in, and a sign-in the workspace has refused for good is reported once instead of retried every minute.

- The stored sign-in (`~/.hexis/oauth/<host>--<agent>.json`) also carries the access token and when it expires (`StoredOAuthCredentials.accessToken`, `accessExpiresAt`). A starting process reuses a live one instead of spending the rotating refresh token, so several Cursor windows started together all serve tools on at most one refresh grant. A store written by an older version is still read, and an older version still reads the new one.
- Every read-refresh-write of the store runs under a lock file beside it (`<store>.lock`, taken over after 30 s if its holder died), and a renewal writes the rotated refresh token, the access token and its expiry before using them.
- A refresh refused as unknown, revoked or expired re-reads the store once and continues with a newer sign-in found there. Otherwise renewal stops for good (`SignInRefusedError`, never retried): stderr says so once, `tools/list` answers the `hexis_unavailable` notice ("restart hexis-mcp to sign in through your browser again"), and no further refresh request is sent. A network error or a 5xx is still retried. The browser opens only when nothing is stored or the stored sign-in was refused for good.
- `HexisMcpConfig.onSignInEnded` is how an embedding host hears of it; `BrowserFlowResult.expiresInMs` carries the token endpoint's `expires_in`.

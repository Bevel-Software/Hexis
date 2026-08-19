# Configuration reference

Every setting Hexis reads, and where it comes from.

Four values are **required** before first boot. Everything marked *setup
screen* can be left unset and configured in the app at first sign-in.
**Anything set in the environment wins over the setup screen**, so a value you
pin in `.env` cannot be changed out from under you in the UI.

[`.env.example`](../.env.example) documents every variable in full.

## Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_EMAIL` | yes | Deployment owner: always an admin, and the initial Admin of a freshly seeded KB |
| `ADMIN_PASSWORD` | with password login | Bootstrap sign-in password, checked against the env and never stored. Not needed when `LOGIN_PASSWORD=false` |
| `JWT_SECRET` | yes | Signs login sessions + OAuth state |
| `SECRETS_ENC_KEY` | yes | 32-byte key (base64/hex) encrypting vault secrets + MCP OAuth tokens |
| `DATABASE_URL` | see note | Postgres connection string. Unset under compose, the app builds it from the `POSTGRES_*` values the bundled db was created with |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | no | Credentials for the bundled database (applied only when its volume is first created) |
| `KB_REPO_URL` | setup screen | https clone/push URL of the knowledge-base repo, on any git host |
| `GIT_TOKEN` / `GIT_USERNAME` | setup screen | Git credential (HTTP Basic password / host-specific username; see `.env.example` for per-host usernames) |
| `DEFAULT_BRANCH` / `PROTECTED_BRANCHES` | setup screen | Branch model. Runtime-only: served to the frontend over `/api/config`, so one build runs anywhere |
| `DOMAIN` | with the `https` profile | Public host name served by the bundled Caddy; also derives the public origins (`https://<DOMAIN>`) and `TRUST_PROXY=1` unless set explicitly |
| `PUBLIC_BACKEND_URL` / `PUBLIC_FRONTEND_URL` | production | Public origins for OAuth redirects + post-login bounces (derived from `DOMAIN` when set) |
| `TRUST_PROXY` | behind a proxy | Reverse-proxy hop count, so `req.ip` and the login rate limit see the real client (defaults to `1` when `DOMAIN` is set) |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | no | Generic OIDC SSO; the login method appears once all three are set |
| `ALLOWED_EMAIL_DOMAINS` | with multi-tenant SSO | Signup allow-list for SSO auto-provisioning |
| `LOGIN_PASSWORD` | no | `false` hides password login and rejects the endpoint |
| `PORT` | no | Backend port (default 3001) |
| `KB_DIR_NAME` | no | Directory name of the KB clone inside each workspace |
| `TENANT_ID` | no | Slug branding credential prefixes (default `bevel`) |
| `KB_TEMPLATE_DIR` | no | Overrides the packaged KB seed template |
| `ONTOLOGY_SESSION_BLOCK` | no | Ontology-session touch tracking toggle (default on) |

## Generating the two secrets

`JWT_SECRET` and `SECRETS_ENC_KEY` are both 32 random bytes. Run this twice
and paste one result into each. Never reuse the same value for both:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# no Node installed? docker run --rm node:22-slim node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Rotating `SECRETS_ENC_KEY` makes every stored vault secret and MCP OAuth token
undecryptable, so treat it as permanent for the life of the deployment.

## Single sign-on

Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` for any
spec-compliant provider, or configure it on the setup screen, which shows you
the redirect URI to register with your identity provider.

- **SSO-only deployments**: set `LOGIN_PASSWORD=false` and drop
  `ADMIN_PASSWORD`. The password endpoint is then rejected, not merely hidden.
- **Multi-tenant issuers** (Google, Entra `common`): set
  `ALLOWED_EMAIL_DOMAINS`. SSO auto-provisions accounts, and that list is the
  **only** signup boundary. Without it, anyone with an account at the issuer
  can sign in.

## Configuring by environment instead of the setup screen

Every value the setup screen collects has an env var (`KB_REPO_URL`,
`GIT_TOKEN`, `DEFAULT_BRANCH`, …). Setting them in the environment skips those
steps at first sign-in and pins them against later change in the UI, which is
what you want for a deployment managed by config-as-code.

## State that survives redeploys

Postgres data plus three app volumes (workspace clones, diff-review backups,
tool-chain spill files) are named volumes, so a redeploy or image rebuild loses
nothing.

**Back up the `pgdata` volume and your knowledge-base git repository.**
Everything else is derivable from those two.

## Health

`GET /api/health`. First boot can take a minute or two while it runs migrations
and seeds the knowledge-base repo, so give the container its `start_period`
(~90s) before treating an unhealthy status as a fault.

Migrations run automatically on boot; there is no separate migrate step, in
development or in production.

---

Stuck on something specific? See [troubleshooting](troubleshooting.md).

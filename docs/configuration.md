# Configuration reference

Every setting Hexis reads, and where it comes from.

Four values are **required** before first boot. Everything marked *setup
screen* can be left unset and configured in the app at first sign-in.
**Anything set in the environment wins over the setup screen**, so a value you
pin in `.env` cannot be changed out from under you in the UI. The one
exception is the knowledge-base layout — the three root folder names — which
are entered in the app and nowhere else; see the *retired* rows below.

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
| `GIT_MODE` | setup screen | Where the knowledge-base repo is: `managed` (the deployment keeps it), `github-app` (on GitHub, through a GitHub App) or `token` (any git host, by address and token). See [repository.md](repository.md). Unset, a deployment with `KB_REPO_URL` or `GIT_TOKEN` is on `token` |
| `KB_REPO_URL` | setup screen | With `token`: https clone/push URL of the knowledge-base repo, on any git host |
| `GIT_TOKEN` / `GIT_USERNAME` | setup screen | With `token`: Git credential (HTTP Basic password / host-specific username; see `.env.example` for per-host usernames) |
| `GITHUB_APP_REPOSITORY` | setup screen | With `github-app`: the repository, as `owner/name` |
| `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | no | A GitHub App you registered yourself, in place of the one the setup screen creates. All five together. The private key is the PEM, with its line breaks written as `\n` or in base64 |
| `GITHUB_APP_INSTALLATION_ID` | no | The installation of that app to use, in place of installing it from the setup screen |
| `DEFAULT_BRANCH` / `PROTECTED_BRANCHES` | setup screen | Branch model. Runtime-only: served to the frontend over `/api/config`, so one build runs anywhere |
| `DOMAIN` | with the `https` profile | Public host name served by the bundled Caddy; also derives the public origins (`https://<DOMAIN>`) and `TRUST_PROXY=1` unless set explicitly |
| `PUBLIC_BACKEND_URL` / `PUBLIC_FRONTEND_URL` | production | Public origins for OAuth redirects + post-login bounces (derived from `DOMAIN` when set) |
| `TRUST_PROXY` | behind a proxy | Reverse-proxy hop count, so `req.ip` and the login rate limit see the real client (defaults to `1` when `DOMAIN` is set) |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | no | Generic OIDC SSO; the login method appears once all three are set |
| `OIDC_SCOPES` / `OIDC_PROVIDER_LABEL` | no | Scopes requested from the issuer (default `openid profile email`) and the name of the SSO button on the login screen |
| `ALLOWED_EMAIL_DOMAINS` | with multi-tenant SSO | Signup allow-list for SSO auto-provisioning |
| `LOGIN_PASSWORD` | no | `false` hides password login and rejects the endpoint |
| `PORT` | no | Backend port (default 3001) |
| `KB_DIR_NAME` | no | Directory name of the KB clone inside each workspace |
| `KB_SYNC_SECRET` | setup screen | Bearer secret a git host's webhook or a pipeline presents to `POST /api/sync` so pushes made outside Hexis show up at once — see [git-sync.md](git-sync.md) |
| `KB_KNOWLEDGE_BASE_DIR` / `KB_SKILLS_DIR` / `KB_PLUGINS_DIR` | retired | The three top-level folders are now entered on the setup screen and the Deployment settings page only. A deployment that still sets one has its value imported into the saved setting on the first start after upgrading (with a log line naming the variable to delete); a saved value that differs wins, and the variable is ignored |
| `TENANT_ID` | no | Slug branding credential prefixes (default `bevel`) |
| `DB_SCHEMA` | no | The Postgres schema this deployment's tables live in (default `public`). Set it to keep several knowledge bases in one database, each on a schema of its own. Applied as a connection startup parameter, so a non-default schema needs a direct connection or session-mode pooling; the process refuses to start on a connection that lost it |
| `TENANTS_FILE` / `TENANT_MASTER_KEY` / `TENANT_IDLE_MINUTES` | multi-tenant | Serve several knowledge bases from one process, one per host name — see [multi-tenant.md](multi-tenant.md) |
| `KB_TEMPLATE_DIR` | no | Overrides the packaged KB seed template |
| `INTERNAL_TOKEN_SECRET` | no | Dedicated HMAC key for internal (loopback) tool tokens; unset, one is derived from `JWT_SECRET` |
| `UPDATE_CHECK` | no | `false` disables the release check behind the admin upgrade banner, the app's one outbound request (air-gapped deployments) |
| `GIT_TIMEOUT_MS` | no | Default ceiling on a git command (default 120000, two minutes). Raise it for a large repository on a slow git host. Two paths set their own: the clones and pushes made at boot and on setup get at least ten minutes, and the setup screen's connection test gives up after twenty seconds |
| `LOG_LEVEL` | no | Log verbosity of the server (`debug`, `info`, `warn`, `error`; default `info`) |

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
the redirect URI to register with your identity provider. A configuration
saved there, or a later change to it, applies to the next sign-in without a
restart — on the replica that served the save. Each replica reads settings once
at boot, so if you run more than one, restart the others after changing SSO
(especially after rotating the client secret).

- **SSO-only deployments**: set `LOGIN_PASSWORD=false` and drop
  `ADMIN_PASSWORD`. The password endpoint is then rejected, not merely hidden.
- **Multi-tenant issuers** (Google, Entra `common`): set
  `ALLOWED_EMAIL_DOMAINS`. SSO auto-provisions accounts, and that list is the
  **only** signup boundary. Without it, anyone with an account at the issuer
  can sign in.

## The agent guide

The platform's guide for agents — the repository's layout, where a new file
goes, the rules every file tool shares, access control, skills and tool
manuals — is not a file in your repository. The platform composes it when an
agent asks for it, from text that ships with the platform, so it is always
the guide for the version you run.

An agent gets it two ways:

- the `get_agent_guide` tool returns the guide on its own;
- a `read_file` of `AGENTS.md` at the top of the repository returns it too.
  When your repository has an `AGENTS.md` of its own, that file comes first,
  whole, and the platform's guide follows it after a marked separator.

Your `AGENTS.md` is yours: the platform never writes to it, never hides it
from the file tree, and it moves and deletes like any other page. Put your own
conventions there; every agent is told to read both. The guide names the
folders as you called them in setup.

Earlier versions wrote the guide into the repository and refreshed it on every
start. The first start on this version removes those copies from every
protected branch — only a copy that still carries the platform's own header,
never a file someone edited — and takes the rule that hid them out of
`.bevelignore`. A copy left on a draft branch is recognised the same way and
never served.

The **Agent guide file** setting that let you give the written guide another
name is gone: the guide is read as `AGENTS.md` on every deployment. A name a
deployment saved earlier is ignored; the first start on this version removes
the copy written under it like any other.

## Configuring by environment instead of the setup screen

Most values the setup screen collects have an env var (`KB_REPO_URL`,
`GIT_TOKEN`, `DEFAULT_BRANCH`, …). Setting them in the environment skips those
steps at first sign-in and pins them against later change in the UI, which is
what you want for a deployment managed by config-as-code.

The knowledge-base layout is the exception: `KB_KNOWLEDGE_BASE_DIR`,
`KB_SKILLS_DIR` and `KB_PLUGINS_DIR` are retired. On the first start after upgrading, each of those
three still present in the environment is imported once into its saved
setting, with a log line naming the variable to delete; where a saved value
already differs, the saved value wins and the start warns that the variable is
ignored.

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

`GET /api/ready` is the answer worth alerting on. It reports whether the
database is reachable, how old the oldest commit still waiting to be pushed is
and whether this process is the one pushing, whether the git host was reachable
at the last attempt, and how much free space the workspaces volume has. The
status is `ok`, `degraded` (a commit older than ten minutes is waiting, the
last attempt to reach the git host failed, or free space is under a gibibyte)
or `unavailable` (the database cannot be reached, the one case that also
returns a 503). Poll it from your monitoring rather than
the orchestrator: a restart fixes none of the degraded conditions.

Logs are one JSON object per line (`level`, `time`, `module`, `msg`, plus
whatever the line carries). `LOG_LEVEL` sets the verbosity.

---

Stuck on something specific? See [troubleshooting](troubleshooting.md).

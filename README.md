# Bevel core — skill & tool management

The open-source core of the Bevel platform: a **git-backed knowledge workspace** with
branches / change requests / file locks / live updates (SSE), **skills**, **tool
manuals** (UTCP), a **secrets vault**, **role-based access control**, a **Library**
UI, and a remote **MCP server** (with its own OAuth 2.1 authorization server) so
external agents like Claude Code can work against the knowledge base.

Monorepo layout:

| Path | What it is |
| --- | --- |
| `packages/shared` | `@bevel-software/platform-shared` — shared types + pure domain utilities |
| `packages/core-backend` | `@bevel-software/platform-core-backend` — the core backend (ships `migrations/` + `kb-template/`) |
| `packages/core-frontend` | `@bevel-software/platform-core-frontend` — the core UI, published as raw TS/TSX source |
| `apps/server` | standalone core backend shell |
| `apps/web` | standalone core SPA shell (Vite) |

## Quickstart

Requirements: Node 22 (`.nvmrc`), pnpm 10, git ≥ 2.41, a Postgres 17 database.

```sh
# 1. Postgres (or bring your own and set DATABASE_URL)
docker compose up -d db

# 2. Install + build
pnpm install
pnpm build

# 3. Configure
cp .env.example .env   # then fill in: DATABASE_URL (or the POSTGRES_* knobs
                       # if you use the Postgres docker-compose ships), JWT_SECRET,
                       # SECRETS_ENC_KEY, ADMIN_EMAIL — plus ADMIN_PASSWORD
                       # unless you set LOGIN_PASSWORD=false. The knowledge-base
                       # repo and its token are asked for on the setup screen at
                       # first sign-in, where they can be tested before saving.

# 4. Run (backend :3001 + Vite dev server :5173)
pnpm dev
```

Or run the whole thing in Docker: `docker compose up` (Postgres + the app serving
the built SPA on :3001). Use `APP_PORT=8080 docker compose up` for a different
host port.

**Behind a reverse proxy** (Coolify, Traefik, nginx), deploy with an explicit
`-f docker-compose.yml`. That skips `docker-compose.override.yml`, so the app
publishes no host port and the proxy reaches it on port 3001 over the compose
network. Publishing a fixed host port instead makes every redeploy fail with
`port is already allocated`, because the replacement container starts while the
outgoing one still holds it.

## Environment variables (core subset)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes* | Postgres connection string. Wins over the `POSTGRES_*` knobs — set it to use a database you already have |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose only | Credentials for the Postgres docker-compose brings with it; compose builds `DATABASE_URL` from them when you do not supply one. Applied only when the volume is first initialised |
| `JWT_SECRET` | yes | Signs login sessions + OAuth state |
| `ADMIN_EMAIL` | yes | The deployment owner: always an admin (whatever the sign-in method), and the initial Admin of a freshly seeded KB |
| `ADMIN_PASSWORD` | with password login | Password half of the bootstrap credential — checked against the env, never stored. Not needed when `LOGIN_PASSWORD=false` |
| `KB_REPO_URL` | setup screen | https clone/push URL of the knowledge-base repo (any git host). Leave unset and an admin supplies it on first sign-in |
| `GIT_TOKEN` / `GIT_USERNAME` | setup screen | Git credential (Basic password / host-specific username). Also settable on first sign-in, where it can be tested against the host |
| `SECRETS_ENC_KEY` | yes | 32-byte key (base64/hex) encrypting vault secrets + MCP OAuth tokens |
| `KB_DIR_NAME` | no | Directory name of the KB clone inside each workspace |
| `DEFAULT_BRANCH` / `PROTECTED_BRANCHES` | setup screen | Branch model. Runtime only — the frontend fetches it from `/api/config`, so one build serves any deployment. Settable on first sign-in, where the repository's real branches are offered |
| `PORT` | no | Backend port (default 3001) |
| `PUBLIC_BACKEND_URL` / `PUBLIC_FRONTEND_URL` | prod | Public origins for OAuth redirects + bounces |
| `TENANT_ID` | no | Slug branding every credential prefix (default `bevel`) |
| `ALLOWED_EMAIL_DOMAINS` | no | SSO allow-list, settable on the setup screen beside the SSO settings it guards. SSO auto-provisions, so against a multi-tenant issuer this is the only thing limiting who can sign themselves up. Not applied to admin-created accounts or password login |
| `LOGIN_PASSWORD` | no | `false` hides password login and rejects `/api/auth/login` |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | no | Generic OIDC single sign-on; the method appears once all three are set. Also settable on the setup screen, which shows the redirect URI to register |
| `TRUST_PROXY` | behind a proxy | Reverse-proxy hop count, so `req.ip` and the per-IP login rate limit see the real client |
| `KB_TEMPLATE_DIR` | no | Overrides the packaged KB seed template |
| `ONTOLOGY_SESSION_BLOCK` | no | Ontology-session touch tracking toggle (default on) |

See `.env.example` for the full commented list.

## Part of the Bevel platform

This repo is the open-source base of the Bevel platform. The commercial
platform layers chat/agents, connectors, routines, the knowledge-graph system
and more on top of the extension points exposed here (`CorePorts`,
`ServerExtensions`, workflow lifecycle hooks, and the frontend `AppRegistry`).

License: [Apache-2.0](LICENSE)

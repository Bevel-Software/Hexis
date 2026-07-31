# Bevel core — skill & tool management

The open-source core of the Bevel platform: a **git-backed knowledge workspace** with
branches / change requests / file locks / live updates (SSE), **skills**, **tool
manuals** (UTCP), a **secrets vault**, **role-based access control**, a **Library**
UI, and a remote **MCP server** (with its own OAuth 2.1 authorization server) so
external agents like Claude Code can work against the knowledge base.

Monorepo layout:

| Path | What it is |
| --- | --- |
| `packages/shared` | `@bevel-software/shared` — shared types + pure domain utilities |
| `packages/core-backend` | `@bevel-software/core-backend` — the core backend (ships `migrations/` + `kb-template/`) |
| `packages/core-frontend` | `@bevel-software/core-frontend` — the core UI, published as raw TS/TSX source |
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
cp .env.example .env   # then fill in at least: DATABASE_URL, JWT_SECRET,
                       # TEST_PASSWORD, KB_REPO_URL, GIT_TOKEN, SECRETS_ENC_KEY,
                       # SEED_ADMIN_EMAILS (for an empty KB repo)

# 4. Run (backend :3001 + Vite dev server :5173)
pnpm dev
```

Or run the whole thing in Docker: `docker compose up` (Postgres + the app serving
the built SPA on :3001).

## Environment variables (core subset)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `JWT_SECRET` | yes | Signs login sessions + OAuth state |
| `TEST_PASSWORD` | yes* | Shared password for password login (`LOGIN_PASSWORD=false` disables the method) |
| `KB_REPO_URL` | yes | https clone/push URL of the knowledge-base repo (any git host) |
| `GIT_TOKEN` / `GIT_USERNAME` | yes | Git credential (Basic password / host-specific username) |
| `SECRETS_ENC_KEY` | yes | 32-byte key (base64/hex) encrypting vault secrets + MCP OAuth tokens |
| `SEED_ADMIN_EMAILS` | first boot | Initial Admin(s) written into `roles.yaml` when seeding an EMPTY KB repo |
| `KB_DIR_NAME` | no | Directory name of the KB clone inside each workspace |
| `DEFAULT_BRANCH` / `PROTECTED_BRANCHES` | no | Branch model (baked into the frontend at build time too) |
| `PORT` | no | Backend port (default 3001) |
| `PUBLIC_BACKEND_URL` / `PUBLIC_FRONTEND_URL` | prod | Public origins for OAuth redirects + bounces |
| `TENANT_ID` | no | Slug branding every credential prefix (default `bevel`) |
| `ALLOWED_EMAIL_DOMAINS` | no | Email-domain allow-list for login |
| `KB_TEMPLATE_DIR` | no | Overrides the packaged KB seed template |
| `ONTOLOGY_SESSION_BLOCK` | no | Ontology-session touch tracking toggle (default on) |

See `.env.example` for the full commented list.

## Part of the Bevel platform

This repo is the open-source base of the Bevel platform. The commercial
platform layers chat/agents, connectors, routines, the knowledge-graph system
and more on top of the extension points exposed here (`CorePorts`,
`ServerExtensions`, workflow lifecycle hooks, and the frontend `AppRegistry`).

License: [Apache-2.0](LICENSE)

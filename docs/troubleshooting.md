# Troubleshooting

Symptoms you are most likely to hit, and what causes them.

## Deployment

**`port is already allocated` on redeploy**
You're behind a reverse proxy but ran compose without `-f docker-compose.yml`,
so the override file published a host port. A fixed published port makes every
redeploy fail, because the replacement container starts while the outgoing one
still holds the port. Deploy with the explicit `-f` so the app publishes no
host port and your proxy reaches it on `3001` over the compose network.

**App unhealthy right after first start**
Give it the `start_period` (~90s). First boot runs migrations and seeds the
knowledge-base repo before it answers `GET /api/health`.

**Changed `ADMIN_PASSWORD` and nothing happened**
It is read once at startup. Restart the app container.

## Database

**Changed `POSTGRES_PASSWORD` but can't connect**
Postgres applies those values only when its data volume is **first** created;
changing them later does not rename the existing user or database. In
development, `docker compose down -v` resets the volume. In production, change
the password in the database itself.

## Git and the knowledge base

**Setup screen rejects the git token**
The token needs read *and* write (push) access to the knowledge-base
repository. The setup screen's test tells you which half failed. On GitHub,
fine-grained tokens also need the repository explicitly selected, not just the
right scopes.

## Local development

**`pnpm install` fails on Node version**
The engine range is strict (`>=22.13 <23`) because of a native dependency's ABI, and the floor is 22.13 because `pdfjs-dist` requires it.
`nvm use` picks up the version from `.nvmrc`.

---

Configuration questions rather than failures? See the
[configuration reference](configuration.md).

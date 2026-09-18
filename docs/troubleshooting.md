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

## Desktop agents (the local MCP server)

The `npx -y @bevel-software/hexis-mcp` command from **Connect** → Desktop
agents, on the machine the agent runs on.

**The client says `npx` was not found, but it runs fine in a terminal**
The client was launched from the Dock, the Start menu or a desktop icon, so it
was started by the window server rather than by a login shell and never read
the profile that puts Homebrew's or nvm's `npx` on PATH. Cursor and Claude
Desktop on macOS are the usual pair. Run `which npx` in a terminal (`where npx`
in PowerShell) and use the full path it prints as the `"command"` in the
configuration; leave `args` alone. If the client then says `env: node: No such
file or directory`, that `npx` is a script whose `#!/usr/bin/env node` line hits
the same PATH gap — add the folder that path names to the client's `"env"`:
`{ "PATH": "/that/folder:/usr/bin:/bin" }`.

**The server prints one sentence about Node and exits**
It runs on **Node 22.13+ or 24** — exactly the versions its sandbox
(`isolated-vm`) publishes a prebuilt binary for; anywhere else it would compile
C++ on the user's machine, so it refuses instead. `nvm install 22` fixes a
terminal-launched client. A GUI-launched one never reads that shell, so point
its `"command"` at a supported version's `npx` (the absolute path, `args`
unchanged — `node` would read the `-y` as its own option and never reach the
package).

**The only tool is `hexis_unavailable`**
Discovery failed after the handshake. Its description carries the reason, and
the same sentence is on the server's stderr (MCP clients show this as the
server log). The server stays up deliberately, so the reason reaches you.

## Local development

**`pnpm install` fails on Node version**
The engine range is strict (`>=22.13 <23`) because of a native dependency's ABI, and the floor is 22.13 because `pdfjs-dist` requires it.
`nvm use` picks up the version from `.nvmrc`.

---

Configuration questions rather than failures? See the
[configuration reference](configuration.md).

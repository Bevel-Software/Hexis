# Deployment variants

Extra deployment material beyond the root `docker-compose.yml`: a standalone
build-from-source compose file, and distribution templates for third-party
platforms.

Two compose files deliberately stay at the repository root and out of this
folder: `docker-compose.yml` (the default every release deployment uses —
it pulls the published image) and `docker-compose.override.yml` (the
local-quickstart port publish — Compose only auto-merges it under exactly
that name in the project root).

Public HTTPS without a reverse proxy of your own is no longer a file here
either: it is the `https` **profile** of the root compose file
(`docker compose -f docker-compose.yml --profile https up -d` with `DOMAIN` set in `.env` — Caddy
in front of the app, automatic Let's Encrypt certificates). See the
[main README](../README.md#deploy-it-in-5-minutes-docker)'s deploy section.

## docker-compose.build.yml — build from source (standalone)

The root `docker-compose.yml` pulls the release image from GHCR — deploying
never compiles anything. This file is for deployments that track a BRANCH
instead of a release: a staging server building `dev`, a fork building its
own changes. It is a **standalone** compose file, not an overlay, precisely
so an orchestrator can be pointed at it directly — in Coolify, set the
resource's *Docker Compose Location* to `/deployment/docker-compose.build.yml`.

```sh
docker compose --project-directory . -f deployment/docker-compose.build.yml up -d
```

`--project-directory .` (run from the repo root) is load-bearing, not
ceremony: compose resolves the build context and the `.env` file against the
PROJECT directory, which orchestrators set to the checkout root — this pins
the manual command to the same behavior.

It mirrors the root file's services and env list; the root file's comments
are the reference for what each knob means.

## portainer-template.json — Portainer app template

A [Portainer](https://www.portainer.io/) v3 app-template list with one entry,
prompting for the four required values plus the version pin. Its stackfile is
`docker-compose.portainer.yml` — the root file with the app port published on
the host (`APP_PORT`, default 3001): Portainer activates no compose profiles
and brings no reverse proxy, so an unpublished port would deploy an
unreachable stack. TLS is the deployer's proxy's job. To use it, add this
file's raw GitHub URL as a **custom template list** in Portainer
(*Settings → App Templates → URL*), then deploy Hexis from the Templates view.

## coolify-template.yml — Coolify service-template candidate

A service-template candidate in the format of
[Coolify's template repo](https://github.com/coollabsio/coolify/tree/main/templates/compose)
(`# documentation:`/`# slogan:` headers, `SERVICE_*` magic variables that
make Coolify generate secrets and the public URL). It exists as the basis for
a future PR to that repo — **not** something to point a deployment at
directly. Deploying on Coolify today works with the root compose file as a
Docker Compose resource, per the main README's reverse-proxy section.

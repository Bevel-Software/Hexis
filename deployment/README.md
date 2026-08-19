# Deployment variants

Compose files for specific deployment shapes — overlays passed alongside the
root file (`docker compose -f docker-compose.yml -f deployment/<overlay>.yml`)
and standalone variants an orchestrator is pointed at directly; each section
below says which its file is.

Two compose files deliberately stay at the repository root and out of this
folder: `docker-compose.yml` (the default every release deployment uses —
it pulls the published image) and `docker-compose.override.yml` (the
local-quickstart port publish — Compose only auto-merges it under exactly
that name in the project root).

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

## docker-compose.https.yml — public HTTPS without a reverse proxy

For a server that has no proxy of its own: a bare EC2 instance, a plain VPS.
Puts [Caddy](https://caddyserver.com/) in front of the app, which obtains and
renews Let's Encrypt certificates automatically and redirects HTTP to HTTPS.

```sh
DOMAIN=bevel.your-domain.com \
  docker compose -f docker-compose.yml -f deployment/docker-compose.https.yml up -d
```

`DOMAIN` can also go in `.env` next to the other values. The overlay sets
`TRUST_PROXY=1` and both public-origin URLs from `DOMAIN` for you, so the
only `.env` entries you need are the four required values from the
[main README](../README.md#deploy-it-in-5-minutes-docker).

Before first start:

- **DNS**: an A (or AAAA) record for the domain pointing at the server. On
  EC2, use an Elastic IP so the record survives instance stop/start.
- **Ports 80 and 443 open** to the internet — on EC2 that is two inbound
  rules in the security group. Port 80 is not optional: the certificate
  challenge and the HTTP→HTTPS redirect both use it. Port 3001 stays closed;
  only Caddy talks to the app, over the compose network.

Worth knowing:

- Certificates live in the `caddy_data` volume and survive redeploys. Do not
  clear it casually — Let's Encrypt rate-limits issuance per domain.
- A CDN or load balancer *in front of* Caddy adds a proxy hop: set
  `TRUST_PROXY=2` in `.env` so rate limits still see real client addresses.
- Already behind Coolify, Traefik or nginx? Skip this overlay — that proxy
  terminates TLS, and the base file alone is the right shape (see the main
  README's reverse-proxy section).

TLS never lives in the app image: the published image is the app alone, and
Caddy runs beside it from the stock `caddy:2-alpine` image. The typical
bare-EC2 install is therefore just the root file plus this overlay — the
command in the main README's deploy section.

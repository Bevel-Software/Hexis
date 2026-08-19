# Deployment overlays

Compose files for specific deployment shapes. Each is an **overlay**: it is
passed alongside the base file, never instead of it —

```sh
docker compose -f docker-compose.yml -f deployment/<overlay>.yml up -d
```

Two compose files deliberately stay at the repository root and out of this
folder: `docker-compose.yml` (the base every deployment uses) and
`docker-compose.override.yml` (the local-quickstart port publish — Compose
only auto-merges it under exactly that name in the project root).

## docker-compose.image.yml — run the published image, skip the build

Uses `ghcr.io/bevel-software/hexis` (published by CI on every release)
instead of compiling the monorepo on your server. No Node toolchain, no
multi-minute build, and a small instance suffices — the source build is
exactly what needed the memory.

```sh
docker compose -f docker-compose.yml -f deployment/docker-compose.image.yml up -d
```

Pin the version in `.env` so upgrades are deliberate:

```sh
HEXIS_VERSION=0.9.1
```

Upgrade = bump the value, then
`docker compose -f docker-compose.yml -f deployment/docker-compose.image.yml pull app && docker compose -f docker-compose.yml -f deployment/docker-compose.image.yml up -d`.
Unset, the tag is `latest` (the newest release) — fine for a first install, a
footgun after: an unplanned `pull` becomes an unplanned upgrade.

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

## Combining overlays

Overlays stack — pass every one that applies. The typical bare-EC2 install
wants both:

```sh
DOMAIN=bevel.your-domain.com docker compose \
  -f docker-compose.yml \
  -f deployment/docker-compose.image.yml \
  -f deployment/docker-compose.https.yml up -d
```

TLS never lives in the app image: the published image is the app alone, and
Caddy runs beside it from the stock `caddy:2-alpine` image — which is what
lets each overlay make sense without the other.

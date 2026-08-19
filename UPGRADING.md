# Upgrading and backups

## Upgrading

Pin the version you run in `.env` (`HEXIS_VERSION=0.10.0`) — left unset it
tracks `latest`, and an unplanned `pull` becomes an unplanned upgrade.

The app tells you when it's time: admins see an in-app banner when a newer
release is published, linking to its release notes (set `UPDATE_CHECK=false`
to disable the check — e.g. on air-gapped deployments).

To upgrade, read the
[release notes](https://github.com/Bevel-Software/Hexis/releases) for the
target version first, then:

1. Edit `HEXIS_VERSION` in `.env` to the new version.
2. `docker compose pull app`
3. `docker compose up -d`

Database migrations and the knowledge-base maintenance phase run
automatically while the app boots — no manual steps, but the first start
after an upgrade can take a little longer.

**Downgrading is not supported** once a version's migrations have run: an
older app cannot read a newer database. To go back, restore the backup you
took before upgrading.

## Backups

Everything that matters lives in Postgres and the named Docker volumes; the
knowledge-base content itself is additionally safe in your git remote — the
deployment only holds working copies of it.

Back up the database before every upgrade (with the default credentials):

```sh
docker compose exec db pg_dump -U bevel bevel > backup.sql
```

The volumes, and what each holds:

- **pgdata** — the Postgres data itself (what `backup.sql` above captures).
- **workspaces** — per-branch working copies of the knowledge base, plus
  scratch files. The copies re-clone from your git remote; only scratch
  files outside the knowledge base are unique to the volume.
- **backups** — the change-review backup ledger.
- **spills** — oversized tool results parked for re-reading; ephemeral.

(The `https` profile adds **caddy_data** / **caddy_config** — TLS
certificates. Keep them too: Let's Encrypt rate-limits re-issuance.)

To restore on a fresh server:

1. Start only the database: `docker compose up -d db`, then feed it the dump:
   `docker compose exec -T db psql -U bevel bevel < backup.sql`
2. Start the rest with the same `.env` (same secrets — they decrypt what the
   database holds): `docker compose up -d`
3. The knowledge base re-clones from your git remote on first use.

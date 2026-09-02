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

### PII encryption (0.14+)

From 0.14, personal data in the database — emails, display names, and
change-request/review text — is encrypted with a key derived from
`SECRETS_ENC_KEY`, in addition to the secrets vault it already sealed. The
first boot after the upgrade rewrites existing rows automatically; nothing
to do.

What it changes for operations:

- **Losing `SECRETS_ENC_KEY` now loses this data too**, not just stored
  credentials. Keep a copy of the key somewhere safe *outside* the server —
  a database backup can only be read back with the key that was in `.env`
  when it was taken.
- Database dumps contain ciphertext for these columns; ad-hoc SQL against
  them (looking up a user by email in `psql`, say) no longer works — use
  the app or its API instead.

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

The database dump is the backup that matters — it is the only thing a
restore below puts back. The other volumes are deliberately not part of it:
workspace copies re-clone, spills expire, and the change-review ledger is a
belt-and-braces safety copy whose history you lose on a fresh server without
losing any reviewed content (it all lives in git). If you want the volumes
anyway, archive them while the app is stopped:

```sh
docker compose down
docker run --rm -v hexis_backups:/v -v "$PWD":/out alpine tar czf /out/backups-volume.tgz -C /v .
```

(`hexis_backups` = `<project>_backups`; `docker volume ls` shows the exact
names. The same line works for any of the volumes.)

(The `https` profile adds **caddy_data** / **caddy_config** — TLS
certificates. Keep them too: Let's Encrypt rate-limits re-issuance.)

To restore on a fresh server:

1. Start only the database: `docker compose up -d db`, then feed it the dump:
   `docker compose exec -T db psql -U bevel bevel < backup.sql`
2. Start the rest with the same `.env` (same secrets — they decrypt what the
   database holds): `docker compose up -d`
3. The knowledge base re-clones from your git remote on first use.

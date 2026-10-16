# Upgrading and backups

## Upgrading

Pin the version you run in `.env` (`HEXIS_VERSION=0.15.1`) — left unset it
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

Since 0.21.0 every compose file in this repository sets `pull_policy: always`
on the app, so `docker compose up` fetches the image the tag currently names
instead of reusing whatever the host pulled last; if you copied an older
compose file, take the release's.

Database migrations and the knowledge-base maintenance phase run
automatically while the app boots — no manual steps, but the first start
after an upgrade can take a little longer.

The maintenance phase commits to the knowledge base on every branch when a
release needs it. The current steps: rename a legacy `Groups/` root to
`Plugins/`; create the `Skills/` root (and take back the `.bevelignore` rule an
earlier release added for it — the Skills & Tools sidebar shows that root as
a file tree now); write a `plugin.json` into every plugin folder that predates
the manifest. Each is idempotent, so a second start writes nothing.

### Branch workspaces are worktrees of one repository (0.30+)

From 0.30 a deployment holds ONE git repository per knowledge base, on the
**backups** volume (`.kb-repository/`), and every branch's working copy on
the **workspaces** volume is a `git worktree` of it. Opening a branch copies
no history any more. Nothing changes in the compose files: both volumes are
already mounted.

What to expect at this upgrade:

- **The first start takes longer.** The boot converts every full clone the
  previous release left on the workspaces volume into a worktree, one at a
  time, then compacts the repository once. Each clone's branch tip, its
  commits not yet pushed, its stash and the files git ignores are carried
  over before the clone is removed. The log says how many were converted. A
  clone with uncommitted changes, or one git cannot read, is left as it is
  and keeps working as a clone; the log names its branch, and the next start
  tries again.
- **Keep the backups volume.** It now holds every commit not yet pushed to
  your remote. A redeploy that drops it while keeping the workspaces volume
  recreates the working copies from the remote, without those commits.
- **Rolling back** to a release before 0.30 needs the workspaces volume
  cleared first (`docker compose down`, then `docker volume rm
  <project>_workspaces`, then start the older release): that release does not
  recognise a worktree. The commits not yet pushed stay in the repository on
  the backups volume, which the rollback leaves in place. A clone the
  conversion left as it was keeps its own unpushed commits on the workspaces
  volume, so archive that volume before clearing it if the log reported any.
- The in-app agent's `execute_command` tool is gone: an agent that calls it
  by name is told the tool is unknown. Every git operation an agent needs is
  a platform tool.

### The knowledge-base layout is no longer read from the environment

`KB_KNOWLEDGE_BASE_DIR`, `KB_SKILLS_DIR` and `KB_PLUGINS_DIR` are retired: the
three root folder names, and the agent guide's file name beside them, are
entered on the setup screen and the Deployment settings page.

Nothing changes for most deployments: on the first start, each of the three
still set in your environment is imported once into its saved setting and the
log names the variable to delete. A value that is not a usable folder name is
not imported — the start warns and falls back to the default name for that
root, so check the log once after upgrading. Delete the variables from your
`.env` at your
convenience.

One deployment shape does change at the upgrade. Where a value is ALREADY saved
from the app and the variable is still set to something else, the two disagreed
— and until this release the variable won. From now on the saved value wins,
the start warns that the variable is ignored, and those names take effect at
that boot. The import only runs where nothing is saved, so editing `.env`
cannot hand precedence back: if the variable's names are the ones you want,
enter them on the Deployment settings page.

A plugin is named by its manifest: the `name` in `plugin.json` is what the
marketplace publishes, what the plugin's page address uses, and what grants
spell (`plugin/<name>/read`). The manifests the maintenance phase writes name
each folder in slug form (`Sales Team` → `sales-team`), and grants written
before this release already resolved through that slug, so they keep working.
If you wrote a manifest by hand whose `name` differs from the folder's slug,
grants that spelled the folder no longer name that plugin: open the plugin's
page and rename its identifier to the slug the grants use, or respell the
grants. The folder name (or the manifest's `displayName`) stays the label
people see, so nothing is relabelled.

**Downgrading is not supported** once a version's migrations have run: an
older app cannot read a newer database. To go back, restore the backup you
took before upgrading.

### Personal data in the database is encrypted (0.24+)

From 0.24, personal data in the database — emails, display names, avatar
URLs, change-request and review text, and the error messages of merges,
queued commits and plugin join requests, including every copy of a name or
email kept beside an approval, comment, lock or merge — is encrypted with a
key derived from `SECRETS_ENC_KEY`, in addition to the secrets vault it
already sealed. The first boot after the upgrade rewrites existing rows
automatically.

What is not encrypted is what names a place in the repository rather than a
person: branch names and file paths. A draft branch is usually named after
its author (`ada.lovelace/pricing-page`) and a personal folder after its
owner, so those still say who worked where. They are in the repository's own
history too, which this does not change.

Two things are different about this upgrade:

- **Stop the old version before the new one starts.** The normal
  `docker compose pull app && up -d` flow already replaces the container. A
  deployer that starts the new container, waits for it to be healthy and only
  then stops the old one (a rolling update) leaves the old version running on
  a sealed database: it reads names and addresses as ciphertext, so a save it
  accepts in that window can be committed to the knowledge base's git history
  with `pii:v1:…` as its author, and every first sign-in it handles fails.
  Turn rolling updates off for this one release, or stop the app first.
- **There is no way back without a backup.** An older version reads every
  name and address as ciphertext, so a downgrade after the first start means
  restoring the database as it was before. Take a database backup first.

That first start also removes two kinds of data, which is one more reason
for the backup:

- **Duplicate approvals and join requests.** Addresses are compared without
  regard to case or surrounding whitespace from now on. Where one change
  request holds two approvals of the same file at the same version from
  `Ada@example.com` and `ada@example.com`, they are one person's approval
  recorded twice: the earlier row is kept and the later one deleted. The same
  goes for two requests to join one plugin. If your deployment really has two
  people whose addresses differ only in case, give one of them another
  address before upgrading.
- **The name on a refused apply recorded before this release.** A change
  request that could not be applied shows who tried. Older versions kept that
  name without the address it belongs to, so it could not be found again when
  the person's account is erased. The name is taken off those refusals; the
  refusal, its reason and its time stay.

That first start refuses to come up in two cases, and says which:

- Two accounts share one address up to case and whitespace
  (`Alice@example.com` and `alice@example.com` could both exist before).
  The log names the conflicting user ids; merge or delete the duplicates,
  then start again.
- `SECRETS_ENC_KEY` is not a clean hex or base64 spelling of its key: it
  holds a character the encoding does not have, padding where none belongs,
  or bits its last character should not carry. Such a value used to be
  accepted with the odd part skipped, and the key in use is what it decoded
  to. The refusal gives a one-line command that prints that same key spelled
  properly; set the variable to what it prints, and nothing sealed is lost.

And every start after it refuses in one more:

- A sealed row does not open with the configured key. Changing
  `SECRETS_ENC_KEY` is no longer a configuration change but a re-keying of
  the database, and a start under a different key stops instead of locking
  everyone out. Restore the key that sealed the data. The first start has
  nothing sealed to check the key against, which is why this one begins with
  the second.

A process that serves several knowledge bases (`TENANTS_FILE`) seals each
tenant's rows with that tenant's own key, the one derived for it from
`TENANT_MASTER_KEY` that already seals its stored credentials. Nothing new
to set, and a tenant that leaves takes a dump its one key opens
(docs/multi-tenant.md).

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
- **workspaces** — per-branch working copies of the knowledge base (each a
  git worktree of the repository below), plus scratch files. The copies are
  recreated from the shared repository (which fetches from your git remote);
  knowledge-base edits not yet committed (a write reaches disk before the
  commit worker commits it) and scratch files live only in this volume.
- **backups** — the change-review backup ledger, and the knowledge base's
  one git repository (`.kb-repository/`) that every branch's working copy is
  a worktree of. It holds commits that have not been pushed yet, so keep
  this volume with the workspaces volume: a redeploy that loses it while
  keeping the workspaces recreates the working copies from the remote.
- **spills** — oversized tool results parked for re-reading; ephemeral.

The database dump is the backup that matters. Everything that was pushed
is in your git remote, so workspace copies re-clone and spills expire. What
was NOT pushed yet — every local commit not on the remote, whether its push
failed or is still pending — lives only in
the repository on the **backups** volume (with the change-review ledger), so
archive that volume too if you want those back; a restore without it starts
from what the remote holds. (A full clone the 0.30 conversion left as it was
keeps its own unpushed commits on the **workspaces** volume instead; archive
that one too while the start log still names such a clone.) Archive volumes
while the app is stopped:

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
2. If you archived the backups volume, put it back BEFORE the app first
   starts, so the repository with the unpushed commits is there when the
   working copies are made:
   `docker run --rm -v hexis_backups:/v -v "$PWD":/in alpine tar xzf /in/backups-volume.tgz -C /v`
   (restore the workspaces volume the same way, from its own archive, for
   edits that were not yet committed).
3. Start the rest with the same `.env` (same secrets — they decrypt what the
   database holds): `docker compose up -d`
4. Otherwise the knowledge base is fetched from your git remote on first use.

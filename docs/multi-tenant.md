# Serving several knowledge bases from one process

One Hexis process can serve many knowledge bases, one per host name. Each
one is a tenant: its own repository, admin, users, settings, secrets and
schema, built by the same code a single-tenant deployment runs, and none of
them can see another's data. Nothing changes for a deployment that serves
one knowledge base; this mode is opt-in.

## Turning it on

Set two variables and point the process at a tenants file:

```sh
TENANTS_FILE=/etc/hexis/tenants.json
TENANT_MASTER_KEY=<32+ random characters>   # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Everything the process needs regardless of tenant is read from the usual
variables: `DATABASE_URL` (or the `POSTGRES_*` parts), `PORT`,
`TRUST_PROXY` or `DOMAIN`, `WORKSPACES_ROOT`, `KB_TEMPLATE_DIR`,
`GIT_TIMEOUT_MS`. The per-deployment variables (`ADMIN_EMAIL`,
`JWT_SECRET`, `SECRETS_ENC_KEY`, `KB_REPO_URL`, …) are not read in this
mode: every tenant has its own, from the file or from its setup screen.

`TENANT_IDLE_MINUTES` (default 30) is how long a tenant may go without a
request before its graph is stopped; it starts again on the next request.

## The tenants file

```json
{
  "tenants": [
    {
      "slug": "acme",
      "hosts": ["acme.hexis.example.com"],
      "adminEmail": "owner@acme.com",
      "adminPassword": "a bootstrap password",
      "kbRepoUrl": "https://github.com/acme/knowledge-base.git",
      "gitToken": "ghp_..."
    },
    {
      "slug": "globex",
      "hosts": ["globex.hexis.example.com", "kb.globex.com"],
      "adminEmail": "owner@globex.com",
      "oidc": { "issuerUrl": "https://login.globex.com", "clientId": "…", "clientSecret": "…" }
    }
  ]
}
```

Per tenant:

| Field | Required | Meaning |
| --- | --- | --- |
| `slug` | yes | Stable name: lowercase letters, digits and hyphens, at most 40 characters. It names the tenant's schema, folders and loopback path, so pick it once |
| `hosts` | yes | Host names whose requests belong to this tenant (a port is ignored). The first is the tenant's public address |
| `adminEmail` | yes | The tenant's owner, as `ADMIN_EMAIL` is for a single-tenant deployment |
| `adminPassword` | no | The bootstrap password. Absent, password login is off for this tenant (`loginPassword` forces it either way) |
| `kbRepoUrl`, `gitToken`, `gitUsername` | no | The repository and its credential. Absent, the tenant's admin enters them on its setup screen, exactly as on a single-tenant deployment |
| `oidc` | no | `issuerUrl`, `clientId`, `clientSecret`, optional `scopes` and `providerLabel` |
| `allowedEmailDomains` | no | The SSO sign-up allow-list |
| `publicBackendUrl`, `publicFrontendUrl` | no | Default `https://<first host>` |
| `dbSchema`, `tenantId`, `kbDirName` | no | Defaults derived from the slug: `t_<slug>`, the slug without hyphens, `knowledge-base` |

The three secrets a deployment normally sets in its environment
(`JWT_SECRET`, `SECRETS_ENC_KEY`, `INTERNAL_TOKEN_SECRET`) are derived per
tenant from `TENANT_MASTER_KEY` and the slug. They are not stored anywhere,
and the same master key and slug always derive the same values, which is
what makes an export restorable elsewhere. Rotating the master key
invalidates every tenant's sessions and makes every tenant's stored secrets
undecryptable, so treat it as permanent.

## What is kept apart

- **Database**: one database, one schema per tenant (`t_<slug>` by default),
  created on the tenant's first request. Migrations and their ledger run per
  schema; a tenant's tables never share a name space with another's.
- **Disk**: `<WORKSPACES_ROOT>/<slug>` for the tenant's clones, with its
  backups, spill files and document cache in sibling folders of the same
  name.
- **Settings and secrets**: the setup screen, the deployment settings and
  the secrets vault are per schema, so each tenant's admin configures their
  own.
- **Credentials**: connection keys and internal tokens carry the tenant's
  own prefix; a key minted for one tenant does not authenticate on another.
- **Background work**: each tenant runs its own commit worker and sweeps,
  under locks keyed by the tenant, so two tenants never wait on each other.

Requests reach a tenant by host name (`Host`, or `X-Forwarded-Host` behind
a proxy the process trusts). A host name no tenant claims is answered with
404. The process reaches one of its own tenants over loopback through a
path prefix (`/_tenant/<slug>/…`) that is honoured only for connections
from the machine itself.

## Capacity

Registered tenants cost a schema and a folder each; there is no practical
limit on their number. Active tenants cost memory (each graph holds its
own caches and registries) and database connections (a small pool each),
so a process serves on the order of a few hundred active tenants, and idle
eviction keeps the active set to the tenants in use. All active tenants
share one event loop; to serve more traffic, run more processes and route
host names to them at the load balancer.

## Moving a tenant to its own deployment

A tenant leaves as data a single-tenant deployment reads unchanged:

1. Export the schema: `pg_dump --schema=t_<slug> --no-owner <database>`.
2. Copy `<WORKSPACES_ROOT>/<slug>` (and its backups folder, if wanted).
3. Restore the dump into the new database's `public` schema (rename the
   schema in the dump, or set `DB_SCHEMA=t_<slug>` on the new deployment
   to keep it).
4. Set the new deployment's `JWT_SECRET`, `SECRETS_ENC_KEY` and
   `INTERNAL_TOKEN_SECRET` to the values derived for the tenant, so its
   stored secrets and git credential still decrypt. The derivation is
   exposed by the platform package (`deriveTenantSecrets`).
5. Point the new deployment's `ADMIN_EMAIL` and `TENANT_ID` at the same
   values the tenant record used.

## Where the tenant list lives

The file-based source is meant for development, tests and a small fleet.
A larger operator implements the tenant source over its own registry
(where subdomains are provisioned and plans live) and passes it to the
host; the host, the runtime and the isolation above are the same.

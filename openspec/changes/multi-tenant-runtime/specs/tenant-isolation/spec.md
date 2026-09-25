## ADDED Requirements

### Requirement: Git credentials are injected, never written to the process environment
The git runner SHALL take a credentials provider and put the token in the child process's environment only. Nothing SHALL write `GITHUB_TOKEN` into the server's own environment, and nothing SHALL read it from there. The token SHALL never appear in a git command's arguments. Redaction of logs and error text SHALL scrub the tokens the caller names.

#### Scenario: Token saved on the setup screen
- **WHEN** an admin saves a git token on the setup screen
- **THEN** the next git call uses it without a restart, and the process environment is unchanged

#### Scenario: Two knowledge bases, two tokens
- **WHEN** two graphs in one process hold different tokens
- **THEN** each graph's git calls carry only its own token

#### Scenario: A git failure quotes the remote
- **WHEN** git fails with output containing the token
- **THEN** the logged and returned text carries the placeholder, not the token

### Requirement: One database, one schema per knowledge base
The database connection SHALL be created for a schema, with `search_path` set to it, and migrations SHALL be tracked per schema. A single-tenant deployment SHALL keep `public` and its existing ledger. Migrations SHALL NOT qualify a table with `public.`.

#### Scenario: Fresh schema boots
- **WHEN** a graph is built for a schema that does not exist yet
- **THEN** the schema is created, every core migration runs in it, and the graph's queries touch only that schema

#### Scenario: Existing single-tenant install upgrades
- **WHEN** a deployment on `public` starts after this change
- **THEN** no migration re-runs and no data moves

#### Scenario: Invalid schema name
- **WHEN** a schema name is not a lowercase identifier of at most 63 characters
- **THEN** the graph refuses to build with a message naming the rule

### Requirement: Advisory locks are keyed by tenant
Every advisory lock and lease SHALL be taken under a key derived from the lock id and the tenant key, and an empty tenant key SHALL keep today's ids.

#### Scenario: Two tenants run the commit worker
- **WHEN** two graphs in one database each start their commit worker
- **THEN** both hold their lease at the same time

#### Scenario: Single tenant keeps its ids
- **WHEN** a single-tenant deployment upgrades while an older instance holds the lease
- **THEN** the new instance waits on the same lock as before

### Requirement: The secrets loader is keyed by tenant
The UTCP variable loader that resolves `bevel_secrets` SHALL be registered per tenant and resolve a variable from that tenant's vault only.

#### Scenario: Same variable name in two vaults
- **WHEN** two tenants each store `API_KEY` and a tool in each asks for it
- **THEN** each tool receives its own tenant's value

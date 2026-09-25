## ADDED Requirements

### Requirement: Boot and shutdown are separable from server construction
The knowledge-base startup phase, its unreachable-remote retry, the deleted-branch sweep and the join-request jobs SHALL run from `startCore`, and `stopCore` SHALL stop every one of them, drain the commit worker and close the pool, without closing the process's HTTP server. `createCoreServer` SHALL keep its signature and behaviour for single-tenant callers.

#### Scenario: Stop leaves nothing running
- **WHEN** `stopCore` resolves
- **THEN** no timer, worker or pool of that graph is still alive

#### Scenario: Single-tenant boot unchanged
- **WHEN** `apps/server` starts without a tenants file
- **THEN** the startup phase runs as before and the readiness endpoint answers as before

### Requirement: A tenant source names tenants and their hosts
Core SHALL define a `TenantSource` that resolves a host name to a tenant descriptor and describes a tenant by slug. A descriptor SHALL carry everything a graph needs (its config) plus the host names it answers on and the per-tenant ports and extensions. Core SHALL ship a static source that reads a JSON file and derives per-tenant secrets from a master key and the slug.

#### Scenario: Static source resolves a host
- **WHEN** the tenants file lists `acme` with host `acme.example.test`
- **THEN** resolving that host yields `acme` with its derived secrets and its workspaces folder under the process root

#### Scenario: Derived secrets are reproducible
- **WHEN** the same master key and slug are given twice
- **THEN** the derived secrets are identical

### Requirement: The host serves one graph per tenant
The tenant host SHALL resolve each request's host name to a tenant, activate that tenant's graph on first use exactly once even under concurrent first requests, hand the request to the tenant's app, serve the single-page app for every resolved tenant, answer process health itself and leave readiness per tenant. An unknown host SHALL get a 404. A tenant idle past the configured time SHALL be evicted unless it holds a lease or has queued commits.

#### Scenario: Two hosts, two tenants
- **WHEN** a user signs in on tenant A's host and another on tenant B's
- **THEN** each sees only their tenant's knowledge base, and a change request opened on A is absent from B

#### Scenario: Concurrent first requests
- **WHEN** many requests reach a not-yet-active tenant at once
- **THEN** the graph is built once, the requests are answered after activation, and requests past the wait bound get 503 with `Retry-After`

#### Scenario: Unknown host
- **WHEN** a request arrives for a host no tenant claims
- **THEN** `/api/*` answers 404 JSON and any other path a plain page saying there is no workspace at that address

#### Scenario: Eviction leaves the others serving
- **WHEN** tenant A is evicted for idleness
- **THEN** tenant B keeps answering and A activates again on its next request

### Requirement: Loopback carries the tenant
Requests a graph makes to itself over loopback SHALL name the tenant on the path, under `/_tenant/<slug>/`, and the host SHALL honour that prefix only when the peer address is loopback, stripping it before the tenant's app sees the request.

#### Scenario: MCP proxy calls its own tenant
- **WHEN** the MCP proxy fetches a tenant's tool listing over loopback, or a UTCP manual it seeded calls the tenant's REST surface
- **THEN** the listing and the call are that tenant's, and the tenant's routes see the path without the prefix

#### Scenario: Prefix from outside
- **WHEN** a request from a non-loopback peer carries the `/_tenant/<slug>/` prefix
- **THEN** the prefix is ignored, the host name decides, and the path is served as spelled

#### Scenario: Prefix naming no tenant
- **WHEN** a loopback request names a slug no tenant has
- **THEN** it is answered 404

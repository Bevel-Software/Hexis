## Context

A `.tool` sign-in is an `oauth` block on a `user`-scoped variable; the tokens it obtains are an `oauth` row in the vault, and `resolve` hands the access token to the one variable loader every tool shares, refreshing it against the provider with the client secret the owner pasted. The Connect page lists these sign-ins and starts them through `POST /secrets/tools/:slug/vars/:var/oauth/start`, which runs the authorization-code flow from this deployment's redirect URI.

A managed connector keeps all of that and changes three things: there is no client id or secret here, the round-trip happens on a broker the distribution runs, and renewing a token needs that broker too.

## Goals / Non-Goals

**Goals:**
- A managed sign-in is an ordinary sign-in to every surface that does not need to know: the variable loader, the pre-call check, the catalog revision, the listing filter, the tool page.
- Core holds no connector definition, no broker and no template; the distribution supplies them through one port and two token handlers.
- A handoff cannot be forged, replayed or aimed at another row.
- Tokens, codes and secrets never reach a log line.

**Non-Goals:**
- The connectors themselves, the broker, enabling one in a plugin, the switch from a legacy manual: the distribution's (bevel-platform).
- SCIM deprovisioning: core has no SCIM; the seam exists for a distribution to call.

## Decisions

**1. A marker on the variable, not a new manual type.**
The file an enabled connector becomes is a complete inline manual the distribution renders from its catalog and commits into the plugin; `managed: { connectorId, scopeSet }` on the sign-in's `oauth` block is the only thing core needs to see. Alternative considered: a `type: managed` pointer file expanded at scan time from a platform catalog. Rejected with the user: the file in the customer's repository should be the whole tool, readable and editable, and a catalog in core would make core ship Bevel's product.

**2. The handoff lands on a row that expects it.**
`beginManagedConnection` writes a one-time nonce into the row's encrypted blob (beside where a PKCE verifier lives for an ordinary sign-in); `completeManagedConnection` compares the broker's nonce in constant time, writes the tokens guarded on the ciphertext it read, and clears the nonce. A replay finds nothing; a handoff for a row that is not managed is refused in the same words. Alternative: an in-memory pending map in the service. Rejected: it does not survive a second replica, and the vault already has the pattern.

**3. Refresh through a port, revocation through a port.**
`refreshRow` branches on the row's `managed` meta: a `ManagedTokenRefresher` answers a token set or throws with the broker's status, so a 400/401 wipes the grant as a provider's would and an outage keeps the stale token. A `ManagedTokenRevoker` is asked before any managed row with tokens is deleted (per-key removal, namespace wipe, deprovisioning); its failure is logged with the key and never with the token, and the delete proceeds.

**4. A shared connection is an `admin`-scoped sign-in.**
One workspace connection (HubSpot's "one CRM for the company") is the shared row holding tokens: `resolve` already reads the shared row for an `admin` variable, so nothing changes at call time. What changes is who may start it (a writer of the tool), how status reads it (`adminAuthorized`), and the pre-call check, which now also reports a shared sign-in nobody has made.

**5. The port is late-bound.**
`CoreServices.managedSignIns` is a mutable field like `sessionSink`: the distribution builds its service from core's services and assigns it after `createCoreServices` returns; the routes read it per request.

## Risks / Trade-offs

- A `.tool` can be edited to widen `scopes`: that only changes what a token must cover to count as connected. The broker requests scopes from its own copy of the connector, so the edit cannot widen the grant.
- `clientId` on `ToolVariableOAuth` is now optional. The two consumers that needed it are guarded; a distribution reading it must guard too.

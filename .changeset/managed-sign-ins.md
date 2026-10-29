---
"@bevel-software/platform-shared": minor
"@bevel-software/platform-mcp-core": minor
"@bevel-software/hexis-mcp": minor
"@bevel-software/platform-core-backend": minor
"@bevel-software/platform-core-frontend": minor
---

A `.tool` sign-in may go through a MANAGED connector: a distribution's own OAuth app, with a broker doing the provider round-trip and handing the tokens to the deployment. Core keeps the seams; the connectors are the distribution's.

- A sign-in variable's `oauth` block may carry `managed: { connectorId, scopeSet }` in place of a `clientId`. On an `admin`-scoped variable it declares one workspace connection an owner makes, read by every caller — the one case an `oauth` block may sit on an `admin` variable.
- The vault opens a managed sign-in (`beginManagedConnection`, a one-time nonce on the row), lands the broker's handoff (`completeManagedConnection`, constant-time nonce check, so a replay finds nothing), renews through a `ManagedTokenRefresher` and revokes through a `ManagedTokenRevoker` before a managed row is deleted (`setManagedTokenHandlers`). `removeManagedRowsOfUser` is the deprovisioning call. `statusFor` reports the shared row's `adminAuthorized`, the connected `account`, and whether an owner brought their own app.
- `CorePorts.managedSignIns` / `CoreServices.managedSignIns`: the distribution's side of a managed sign-in (what the Connect page shows, how a sign-in starts). `/connect/pending`, `/secrets/tools` and `list_tool_setup` carry the card as `managed`; the tool sign-in start route delegates a managed sign-in to the port unless an owner pinned their own app (`clientId` accepted beside the secret on the client-secret route).
- The pre-call check also reports a workspace connection nobody has made, so a shared tool fails with "an owner connects this" rather than at the provider.
- `AccountHooks.onAccountDeactivated`: fired after an admin switches an account off, for what the account held elsewhere.
- Connect page: a managed sign-in renders as a card (purpose, permissions, Connect / Reconnect / Disconnect, "Connected as …", an owner's "use our own app"); `AppRegistry.connectPanel` lets a distribution add the foot of the page.

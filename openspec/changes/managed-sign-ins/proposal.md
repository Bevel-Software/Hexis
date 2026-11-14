## Why

Every OAuth integration a knowledge base declares needs per-deployment setup today: a `.tool` sign-in with a client id, a client secret pasted by a tool owner, and the deployment's own redirect URI registered with the provider. A distribution that wants to offer "Connect, sign in, done" for Microsoft 365, Google Workspace and HubSpot through OAuth apps it owns and operates cannot build that on core as it stands: the parser refuses a sign-in without a client id, the vault's refresh needs the client secret in hand, and the sign-in start route runs the provider round-trip from this deployment.

## What Changes

- A sign-in variable's `oauth` block may name a managed connector (`managed: { connectorId, scopeSet }`) in place of a `clientId`. On an `admin`-scoped variable it declares one workspace connection an owner makes, read by every caller: the one case an `oauth` block may sit on an `admin` variable.
- The vault learns the shape of a managed sign-in: open it with a one-time nonce on the row, land a broker's handoff against that nonce (constant time, once), renew through a refresher port, revoke through a revoker port before the row goes, and delete every managed row of a person on request. Status reports the shared row's connection, the connected account and whether an owner brought their own app.
- A port (`CorePorts.managedSignIns`) carries the distribution's side: what a managed sign-in is (the card) and how one starts. The Connect page lists managed sign-ins as cards and offers the distribution a panel at its foot. The sign-in start route delegates a managed sign-in to the port unless an owner pinned their own app, which the client-secret route now accepts a client id for.
- The pre-call check reports a workspace connection nobody has made, in words that say whose job it is.
- Core fires a seam when an admin switches an account off, so a distribution can let go of what the account held elsewhere.

Core ships no connector, no broker and no template. Core-only deployments see no change until a `.tool` carries the marker, and such a `.tool` is listed as waiting on the deployment.

## Capabilities

### New Capabilities
- `managed-sign-in`: a sign-in that goes through a distribution's managed app; the marker in the file, the vault's open/handoff/refresh/revoke paths, the port, the Connect page card.
- `account-deactivated-seam`: the hook core runs after an account is switched off.

### Modified Capabilities

None. There are no existing specs under `openspec/specs/` for these areas.

## Impact

- **core-backend**: `tool-manuals` (contract: `ToolVariableOAuth.clientId?`, `managed`; parser; `sharedSignInKeysForManual`), `secrets-vault` (contract ports and three methods; service; routes), `mcp` (pre-call check), `auth` (`AccountHooks.onAccountDeactivated`, fired by the deactivate route), `core-ports` / `create-core-services` (`managedSignIns`).
- **core-frontend**: `connect.api.ts` (`ManagedSignIn`), `ManagedConnectorCard`, the Connect page's Connectors section, `AppRegistry.connectPanel`.
- **Every deployment**: no runtime change without the marker in a file.

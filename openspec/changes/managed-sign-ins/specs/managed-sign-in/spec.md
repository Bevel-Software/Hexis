## ADDED Requirements

### Requirement: A sign-in may name a managed connector in place of a client
A `.tool` sign-in variable's `oauth` block SHALL accept `managed: { connectorId, scopeSet }` (both lowercase snake_case ids) with no `clientId`; an ordinary sign-in SHALL still require a `clientId`. A managed sign-in on an `admin`-scoped variable SHALL be accepted and declares one workspace connection; an ordinary `oauth` block on an `admin` variable SHALL still be refused.

#### Scenario: Managed sign-in parses without a client id
- **WHEN** a `.tool` declares a `user` variable whose `oauth` has the endpoints, `scopes` and `managed` but no `clientId`
- **THEN** the manual is listed with that variable, its `oauth.managed` set and `oauth.clientId` absent

#### Scenario: Workspace connection
- **WHEN** the same `oauth` block sits on an `admin` variable
- **THEN** the manual is listed, and the variable is reported by `sharedSignInKeysForManual`

### Requirement: The vault opens a managed sign-in and lands its handoff once
`beginManagedConnection` SHALL write the row the handoff lands on with a one-time nonce, keeping tokens a managed row already holds and starting clean over a row of any other kind. `completeManagedConnection` SHALL store the tokens only when the nonce matches in constant time, SHALL clear the nonce, SHALL remember the connected account, and SHALL refuse a mismatch, a reuse and a row that is not managed in the same words.

#### Scenario: Handoff round trip
- **WHEN** a sign-in is begun with nonce N and a handoff arrives with N and a token set
- **THEN** the tokens are stored encrypted, the account is on the row's public meta, and listeners are told the user's credentials changed

#### Scenario: Replay
- **WHEN** the same handoff arrives again
- **THEN** it is refused, and the stored tokens are unchanged

### Requirement: A managed token renews and is revoked through the distribution
`resolve` SHALL renew an expired managed token through the registered refresher; a 400 or 401 from it SHALL wipe the grant; no refresher SHALL serve the stale token. Before a managed row with tokens is deleted (by key, by namespace, or by `removeManagedRowsOfUser`), the registered revoker SHALL be told; its failure SHALL be logged without token material and the delete SHALL proceed.

#### Scenario: Refresh through the broker
- **WHEN** an expired managed token is resolved and the refresher answers a token set without a refresh token
- **THEN** the new access token is served and the old refresh token is kept

#### Scenario: Revoke then delete
- **WHEN** a managed sign-in is removed
- **THEN** the revoker is called before the delete, with the row's tokens

### Requirement: The Connect page and the start route know a managed sign-in
`/connect/pending` and `/secrets/tools` SHALL report a managed sign-in with its card (from the port, or a bare one without), the connected account, whether an owner brought their own app, and whether sign-ins can start. The start route SHALL delegate a managed sign-in to the port, SHALL refuse with 409 when no port is available, SHALL allow a workspace connection only to a writer of the tool, and SHALL run the ordinary flow when an owner pinned their own app. The client-secret route SHALL accept a `clientId` beside the secret for a managed sign-in.

#### Scenario: Two readers, one plugin
- **WHEN** a managed connector is enabled in a plugin one person may read and another may not
- **THEN** the first sees its card and may start it; the second sees nothing and a start is 404

### Requirement: A shared sign-in nobody made is reported before the call
The pre-call check SHALL report an `admin`-scoped managed sign-in whose shared row holds no covering token, with words that say an owner connects it for the workspace.

#### Scenario: Shared HubSpot not yet connected
- **WHEN** a tool declares a workspace connection and no owner has connected it
- **THEN** a call returns the needs-authorization result naming the sign-in and the Connect link, and the caller's own grant is not reset

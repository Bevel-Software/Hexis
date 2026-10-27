---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The "Connect your tools" page lists only the tools the chosen agent loads. In the consent step, picking an `.agent` file under "Connect as" now refetches the list of sign-ins and keys for that agent: `GET /api/connect/pending?agent=<path>` narrows the listing to the connectors a connection made as the file would load, by the same `ConnectionScope` every agent surface asks, and lists no standalone sign-in (those belong to no connector). Everything, the default, lists what it always listed. An agent the person cannot use lists nothing, never Everything. The page's wording says when the list is the chosen agent's. `SecretsVaultRoutesDeps` takes an optional `agents` resolver (`core.agentScopeService`); without one, an `?agent=` request lists nothing.

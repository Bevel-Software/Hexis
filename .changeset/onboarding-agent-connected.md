---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The connect-your-agent page says when your agent has connected.

Under the snippet, a quiet "Waiting for your agent…" turns into "Connected. Your agent reached this knowledge base." the moment the agent makes its first call. Connecting concludes the onboarding the way Done does: the sidebar pill goes and the Get set up step ticks. The Get set up list hears the same news, so someone who connected without opening the page gets the tick too.

- New user-scoped event `agent-connected` (`forUserId`, `client`, `agentKind: 'agent' | 'key'`, `at`), emitted over the event stream when one of a person's agent connections or connection keys is used for the FIRST time — the `last_used_at` an agent stamps on its first authenticated request, which every client makes on connecting, before it has called any tool. Later uses stamp quietly. The OAuth provider emits it for connections (`BevelOAuthProvider` takes an optional `events`), the key service for keys (`ExternalApiKeyService` takes an optional fourth `events` argument).
- New `GET /api/onboarding/agent-connection` (signed-in only) answers `{ connected, at?, client?, kind? }` for the caller alone; `kind` says whether `client` is an agent connection's registered name (`agent`) or a connection key's label (`key`). The page and the list ask it once on arrival, and again when you come back to the tab (at most every 30 seconds), for an agent that connected before the tab opened or while its event stream was down. Nothing asks on a timer. It does not read the Audit log's events, so it works whatever the retention setting, and an agent that was disconnected or revoked does not count.
- `AgentAuditService` implements a new `IAgentConnectionStatus` (`lastAgentUse(userId)`, whose `AgentUse` carries `kind`), and `createAgentConnectionRoutes` is exported from the audit module.

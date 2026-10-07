---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The connect-your-agent page says when your agent has connected.

Under the snippet, a quiet "Waiting for your agent…" turns into "Connected. Your agent can now read and write this knowledge base." as soon as the agent makes its first call. Connecting concludes the onboarding the way Done does: the sidebar pill goes and the Get set up step ticks. The Get set up list asks the same question once when it loads, so someone who connected without opening the page gets the tick too.

- New `GET /api/onboarding/agent-connection` (signed-in only) answers `{ connected, at?, client? }` for the caller alone. Connected means one of the caller's live agent connections or connection keys has been used: the `last_used_at` an agent stamps on its first authenticated request, which every client makes on connecting, before it has called any tool. It does not read the Audit log's events, so it works whatever the retention setting, and an agent that was disconnected or revoked does not count.
- The page asks every 3 seconds while it is open and visible, stops while the tab is hidden, and stops for good once connected.
- `AgentAuditService` implements a new `IAgentConnectionStatus` (`lastAgentUse(userId)`), and `createAgentConnectionRoutes` is exported from the audit module.

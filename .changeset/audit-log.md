---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-mcp-core': minor
---

An **Audit log** page, in the profile menu for everyone, lists the agents (browser sign-ins) and connection keys connected to your account — admins see every account — with when each connected, when it was last used and how much it has called. Each row can be revoked, and opens to the calls it made: a hexis capability, a tool from a connected server or `.tool` manual, or a skill it read, with the outcome and time, newest first. Skills and tools link to their pages. Nothing an agent sent or received is recorded — only what was called. It replaces the admin Connection keys page (`/connection-keys` redirects); keys are still created and deleted on External agent access, and a deleted key leaves the owner's listings while its history stays for admins.

Revoking an agent cuts off every token it holds, including a local server's exchanged grant; it reconnects only by signing in again. One row per agent per person: a client that registers itself afresh on every sign-in (Claude does) no longer appears once per registration, and existing duplicates are merged by the migration. A new deployment setting, **Keep events for** (`AUDIT_RETENTION_DAYS`), prunes events older than that many days; unset, zero or negative keeps them forever.

Migrations `0012_agent_audit` and `0013_agent_identity_and_key_soft_delete` add the `agent_connections` and `agent_events` tables, a `connection_id` on `oauth_tokens`, and `deleted_at` on `api_tokens`; they run at boot like every core migration. `SkillSummary` in `platform-mcp-core` gains an optional `path`.

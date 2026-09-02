/**
 * CORE platform tables — the git-backed workspace/workflow, auth, access,
 * change requests, locks, the pending-commits queue, the ontology-session
 * touched-set, connection keys, MCP OAuth, and the Secrets Vault. A core-only
 * deployment migrates and runs on exactly these tables.
 *
 * Enterprise-only tables (chat, routines, watchlist, connectors, LLM config,
 * SharePoint/Atlassian links, feedback, upload, kb-revalidation) live in
 * `enterprise-schema.ts`, which imports the FK targets (`users`,
 * `externalApiKeys`) from here. `schema.ts` re-exports both, so existing
 * imports keep working unchanged.
 *
 * PII columns (emails, display names, change-request/comment text) are
 * `encryptedText` — AES-256-GCM ciphertext in the database, transparently
 * decrypted on read (see `shared/column-crypto.ts`). Because the ciphertext is
 * randomized, equality lookups and unique constraints on those columns go
 * through their deterministic `*_bidx` companions (HMAC-SHA256 blind indexes)
 * — never `eq()` an encrypted column directly.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { encryptedText } from '../../shared/column-crypto.js';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: encryptedText('email').notNull(),
  /**
   * Blind index of the lowercased email — carries the uniqueness constraint
   * and every lookup-by-email (login, upsert conflict target), which the
   * randomized `email` ciphertext cannot. Populate with `blindIndex(email)`
   * on every insert.
   */
  emailBidx: text('email_bidx').notNull(),
  name: encryptedText('name').notNull(),
  avatarUrl: encryptedText('avatar_url'),
  /**
   * scrypt hash for password login (see auth/password-hash.ts). NULL for
   * accounts that only ever signed in via SSO — password login refuses them
   * until an admin (or the user, from their Account page) sets one.
   */
  passwordHash: text('password_hash'),
  /**
   * The one onboarding fact the server keeps: has this person concluded the
   * connect-your-agent setup (the welcome page's Done, or the reminder
   * pill's dismiss — one field, both doors). False drives the pill in every
   * browser the account signs into; true ends it everywhere at once, which
   * is exactly what localStorage could not promise.
   *
   * Existing accounts are NOT backfilled to true: the column simply defaults
   * to false, so everyone is greeted once and anyone already connected
   * clicks Done. A plain `ADD COLUMN` is worth more than the branching a
   * backfill would need, and being shown the setup once costs a click.
   */
  onboardingDone: boolean('onboarding_done').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  emailBidxUnq: uniqueIndex('users_email_bidx_unq').on(t.emailBidx),
}));

/**
 * Per-file owner approvals on a PR. A PR is mergeable-in-Bevel when every
 * touched path has a non-stale approval from its owner. Force-pushes invalidate
 * approvals automatically because `head_sha` is part of the uniqueness key —
 * an approval row for a superseded SHA stays in the DB (audit) but doesn't
 * count toward the merge gate.
 *
 * Self-approval (approver == PR author) is allowed and flagged downstream in
 * the assembled `FileApprovalState` — enforcement of "PR-author-can't-self-
 * approve" belongs in the service layer, not the DB.
 */
export const prFileApprovals = pgTable('pr_file_approvals', {
  id: uuid('id').defaultRandom().primaryKey(),
  prNumber: integer('pr_number').notNull(),
  path: text('path').notNull(),
  approverEmail: encryptedText('approver_email').notNull(),  // lowercased at insert
  /** Blind index of `approver_email` — the uniqueness key and eq() lookup. */
  approverEmailBidx: text('approver_email_bidx').notNull(),
  approverName: encryptedText('approver_name').notNull(),
  headSha: text('head_sha').notNull(),
  approvedAt: timestamp('approved_at').defaultNow().notNull(),
}, (t) => ({
  // Idempotency: approving the same path on the same SHA twice must be a no-op,
  // not a duplicate row. Unique on the (PR, path, approver, headSha) tuple —
  // via the blind index, because the encrypted email is randomized.
  unq: uniqueIndex('pr_file_approvals_bidx_unq')
    .on(t.prNumber, t.path, t.approverEmailBidx, t.headSha),
  byPr: index('pr_file_approvals_by_pr').on(t.prNumber),
}));

/**
 * Audit log for change-request merges the app executed. Captures the real Bevel
 * user who clicked Merge, the SHA we merged, and whether the local merge+push
 * succeeded. `pr_number` holds the change_requests number. One row per attempt —
 * both success and failure paths insert so crash-loop scenarios are visible
 * after the fact.
 */
export const prMergeLog = pgTable('pr_merge_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  prNumber: integer('pr_number').notNull(),
  triggeredByEmail: encryptedText('triggered_by_email').notNull(),
  /** Blind index of `triggered_by_email` — GDPR-erasure lookup. */
  triggeredByEmailBidx: text('triggered_by_email_bidx').notNull(),
  triggeredByName: encryptedText('triggered_by_name').notNull(),
  headShaAtMerge: text('head_sha_at_merge').notNull(),
  mergeMethod: text('merge_method').notNull(),
  succeeded: boolean('succeeded').notNull(),
  // Encrypted: merge failure output can quote author identities and CR text.
  error: encryptedText('error'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
}, (t) => ({
  byPr: index('pr_merge_log_by_pr').on(t.prNumber),
}));

/**
 * In-app PR comments. GitHub is authoritative for the diff + PR metadata;
 * Bevel owns the review conversation. Comments never round-trip to GitHub.
 *
 * Shape encodes three comment kinds:
 *   • General PR comment        — path null, line null
 *   • File-level comment        — path set,  line null
 *   • Inline (line-anchored)    — path set,  line set
 *
 * Threading: replies point at their root via `parentId`. Root comments have
 * `parentId = null`. We use a self-FK-less column (no DB-side constraint) to
 * keep the parent row independently deletable — the service layer tolerates
 * orphan replies rather than cascading deletes and losing discussion context.
 */
export const prComments = pgTable('pr_comments', {
  id: uuid('id').defaultRandom().primaryKey(),
  prNumber: integer('pr_number').notNull(),
  authorEmail: encryptedText('author_email').notNull(),
  /** Blind index of `author_email` — GDPR-erasure lookup. */
  authorEmailBidx: text('author_email_bidx').notNull(),
  authorName: encryptedText('author_name').notNull(),
  path: text('path'),
  line: integer('line'),
  headSha: text('head_sha').notNull(),
  // Encrypted: review conversation exists only in this DB (never on GitHub).
  body: encryptedText('body').notNull(),
  parentId: uuid('parent_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at'),
}, (t) => ({
  byPr: index('pr_comments_by_pr').on(t.prNumber),
  byThread: index('pr_comments_by_thread').on(t.prNumber, t.path, t.line),
}));

/**
 * Change requests (the app's own "pull request" model). The app used to lean on
 * GitHub PRs via the `gh` CLI; now a change request is a plain DB row plus git
 * branches, so ANY git host (GitHub, GitLab, Bitbucket, Azure DevOps, self-
 * hosted) works — the remote only stores commits/branches.
 *
 * `number` is the human-facing id and the join key the sibling tables
 * (`pr_file_approvals`, `pr_comments`, `pr_merge_log`) reference in their
 * `pr_number` column — those columns now hold THIS number, not a GitHub PR
 * number. It's a DB-assigned identity so allocation is race-free.
 *
 * The diff, head/base SHAs, and mergeability are computed live from git (not
 * stored) so a force-push or a new commit is always reflected; only durable
 * facts live here — the pairing, title/body, author, lifecycle state.
 */
export const changeRequests = pgTable('change_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  number: integer('number').generatedAlwaysAsIdentity(),
  sourceBranch: text('source_branch').notNull(),
  targetBranch: text('target_branch').notNull(),
  // Encrypted: CR title/body exist only in this DB (the remote sees branches).
  title: encryptedText('title').notNull(),
  body: encryptedText('body').notNull().default(''),
  authorEmail: encryptedText('author_email').notNull(), // lowercased at insert
  /** Blind index of `author_email` — GDPR-erasure lookup. */
  authorEmailBidx: text('author_email_bidx').notNull(),
  authorName: encryptedText('author_name').notNull(),
  state: text('state').notNull().default('open'), // 'open' | 'merged' | 'closed'
  mergedSha: text('merged_sha'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at'),
  closedAt: timestamp('closed_at'),
}, (t) => ({
  numberUnq: uniqueIndex('change_requests_number_unq').on(t.number),
  // Enforce the "A→B blocks A→B while open" uniqueness rule at the DB level —
  // a partial unique index on open rows only. B→A in parallel is still allowed
  // because the pair differs. Replaces the previous race-prone list scan.
  openPairUnq: uniqueIndex('change_requests_open_pair_unq')
    .on(t.sourceBranch, t.targetBranch)
    .where(sql`${t.state} = 'open'`),
  byState: index('change_requests_by_state').on(t.state),
  stateCheck: check(
    'change_requests_state_check',
    sql`${t.state} IN ('open', 'merged', 'closed')`,
  ),
}));

/**
 * Long-lived API tokens that authenticate remote agents (Claude Code and
 * similar MCP clients) as a specific Bevel user. Plaintext token is shown
 * once at mint time; we store only the SHA-256 hash. Verification is a hash
 * lookup, so the unique index on `token_hash` is what makes lookup O(1)
 * rather than a table scan.
 *
 * Tokens are revoked, not deleted — keeping the row preserves the audit
 * trail for `last_used_at` and lets an operator see when a leaked key was
 * actually used. A revoked row is rejected on verify because the service
 * filters on `revoked_at IS NULL`; the unique index still applies, so a
 * revoked token cannot be re-issued.
 */
export const externalApiKeys = pgTable('api_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
}, (t) => ({
  byUser: index('api_tokens_by_user').on(t.userId),
}));

/**
 * Per-(workspace, branch, path) edit locks. While the lock is held by a user,
 * other users see the file as locked and can't edit it. The client pings
 * `last_heartbeat_at` periodically; when `expires_at` passes without a
 * heartbeat the lock is considered stale and may be reclaimed by another
 * caller — prevents a disconnected client from holding a file hostage.
 *
 * Composite primary key on (workspace, branch, path) — one lock per file
 * per branch. The same physical path on another branch is independently
 * lockable; the spec calls this out explicitly.
 *
 * Holder identity carries both the user id (FK into `users` for referential
 * integrity) and a denormalised display name so consumers can render
 * "Locked by Alice" without a JOIN on the hot read path.
 */
export const fileLocks = pgTable('file_locks', {
  workspaceId: text('workspace_id').notNull(),
  branch: text('branch').notNull(),
  path: text('path').notNull(),
  holderUserId: uuid('holder_user_id').notNull().references(() => users.id),
  holderName: encryptedText('holder_name').notNull(),
  // How the lock was acquired. 'edit' (the default) is a normal write hold —
  // the holder is editing and the release publishes their bytes.
  // 'coordination' is a pure-mutex hold (see IWorkflowService.acquireLock)
  // that grants NO write authority. Persisted on the row — not inferred at
  // release time — so the write/checkpoint/commit-enqueue paths can refuse
  // to treat a coordination hold as write possession for as long as the row
  // lives, across process restarts included.
  mode: text('mode').notNull().default('edit'),
  acquiredAt: timestamp('acquired_at').defaultNow().notNull(),
  lastHeartbeatAt: timestamp('last_heartbeat_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.branch, t.path] }),
  // Sweep stale locks via `expires_at < now()` — an index avoids a full
  // table scan once the lock count grows.
  byExpiry: index('file_locks_by_expiry').on(t.expiresAt),
  byHolder: index('file_locks_by_holder').on(t.holderUserId),
  modeCheck: check('file_locks_mode', sql`${t.mode} IN ('edit', 'coordination')`),
}));

/**
 * Background commit queue. Every successful lock release enqueues a row
 * here; the queue worker drains it by running `commitFile` + `pushBranch`
 * (with the existing `pushWithRecovery` cooperative pull-rebase).
 *
 * Why a table and not an in-memory queue: the prior in-line lock-release
 * commit path stranded files on disk whenever the process died (or git
 * blipped) between disk-write and commit. A persistent queue means a
 * process crash leaves the work resumable — the next worker pass picks
 * it up. Schema choices follow from that:
 *
 *   - `id` UUID PK so the worker can `UPDATE ... WHERE id = ...` atomically
 *     without locking the queue. Read order is `(workspace_id, queued_at)`
 *     so per-workspace work stays FIFO.
 *   - `(workspace_id, branch, path)` is NOT unique. Two consecutive saves
 *     of the same file produce two rows; the worker collapses them by
 *     committing once and deleting both (commitFile is a no-op on a
 *     clean path, so the duplicate becomes a free deletion).
 *   - Author identity is denormalised (email + name) at enqueue time, like
 *     `file_locks.holder_name`. We don't FK into `users` because the
 *     startup sweep enqueues orphans with synthetic `system-recovery`
 *     attribution and there's no row for that user.
 *   - `attempts` + `last_error` drive the worker's transient-retry budget
 *     (1s/5s/30s backoff before handing off to the recovery agent) and
 *     the agent's own retry ceiling (3 runs before `status = needs_attention`).
 *   - `status` is a small enum (`pending` | `running` | `needs_attention`).
 *     Workers claim a row by flipping `pending → running` in a single
 *     UPDATE; terminal failure flips to `needs_attention` and the row
 *     stays for admin / feedback review.
 *   - `last_attempted_at` gates backoff scheduling so the worker doesn't
 *     re-pop a row that just failed.
 */
export const pendingCommits = pgTable('pending_commits', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  branch: text('branch').notNull(),
  path: text('path').notNull(),
  // Author attribution captured at enqueue. The denormalised name/email pair
  // lands on the eventual `git commit --author=` so the commit history shows
  // the human who triggered the save, not the worker.
  authorEmail: encryptedText('author_email').notNull(),  // lowercased at insert
  /** Blind index of `author_email` — GDPR-erasure lookup. */
  authorEmailBidx: text('author_email_bidx').notNull(),
  authorName: encryptedText('author_name').notNull(),
  queuedAt: timestamp('queued_at').defaultNow().notNull(),
  // `running` is set while the worker is mid-commit so a second worker
  // (e.g. after a restart with another instance still draining) doesn't
  // double-process the row. Set back to `pending` on transient failure;
  // set to `needs_attention` after the recovery-agent retry ceiling.
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  // Tracks how many full recovery-agent runs have fired for this row.
  // Bounded so a genuinely-broken commit eventually escalates to
  // `needs_attention` + feedback notice instead of looping forever.
  recoveryAgentRuns: integer('recovery_agent_runs').notNull().default(0),
  lastAttemptedAt: timestamp('last_attempted_at'),
  // Encrypted: git/agent failure output can quote author identities and paths.
  lastError: encryptedText('last_error'),
}, (t) => ({
  // Primary read pattern: drain in queued order, scoped to a workspace.
  byWorkspaceQueued: index('pending_commits_by_workspace_queued').on(t.workspaceId, t.queuedAt),
  // Sweep: find rows ready to retry (status='pending' AND last_attempted_at < now() - backoff).
  byStatus: index('pending_commits_by_status').on(t.status, t.lastAttemptedAt),
  // Admin surface: enumerate everything stuck in needs_attention.
  byStatusOnly: index('pending_commits_by_status_only').on(t.status),
  statusCheck: check(
    'pending_commits_status',
    sql`${t.status} IN ('pending', 'running', 'needs_attention')`,
  ),
}));

/**
 * Secrets Vault — the per-user store of credentials that back UTCP tool
 * variables (`${FOO_API_KEY}`). Distinct from `vault_sources` (which holds
 * connector+URL POINTERS and no credentials): this table holds the actual
 * secret values, encrypted at rest.
 *
 * Two kinds:
 *  - `static`  — a value the user pasted (an API key). `value_encrypted` is the
 *                AES-256-GCM ciphertext of the raw value.
 *  - `oauth`   — an authorization-code credential. `value_encrypted` is the
 *                ciphertext of a JSON blob `{ clientSecret?, tokens: { access_token,
 *                refresh_token?, expires_at?, token_type? } }`; the non-secret
 *                provider config (auth/token URLs, client id, scopes) lives in
 *                `oauth_meta`. `resolve()` refreshes the access token on demand.
 *
 * `key` is the UTCP variable name a `.tool` manual references (`<manual>_<VAR>`).
 * Two provisioning tiers share this table:
 *  - `user_id` set  — a PER-USER secret (private to that user, cascade-deleted
 *                     with them), unique per `(user_id, key)`.
 *  - `user_id NULL` — a SHARED/admin secret, set by a writer of the `.tool` file
 *                     and read by every invoker of that tool. Unique per `key`
 *                     via the partial index below (a plain `(user_id, key)` index
 *                     treats NULLs as distinct, so it can't enforce one shared
 *                     row per key on its own).
 * `kind` is validated in the service, not a DB CHECK.
 */
export const secrets = pgTable('secrets', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** The UTCP variable name this secret resolves (e.g. `FOO_API_KEY`). */
  key: text('key').notNull(),
  /** `static` | `oauth`. */
  kind: text('kind').notNull().default('static'),
  /** Operator-chosen display name. */
  label: text('label'),
  /** AES-256-GCM ciphertext (`iv:tag:ct`) — the value (static) or token JSON (oauth). */
  valueEncrypted: text('value_encrypted').notNull(),
  /** Non-secret OAuth provider config for `oauth` kind; null for `static`. */
  oauthMeta: jsonb('oauth_meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  byUser: index('secrets_by_user').on(t.userId),
  userKeyUnq: uniqueIndex('secrets_user_key_unq').on(t.userId, t.key),
  // One shared (admin) row per key: enforce uniqueness only across NULL-user rows.
  sharedKeyUnq: uniqueIndex('secrets_shared_key_unq').on(t.key).where(sql`${t.userId} is null`),
}));

/**
 * Ontology-session boundary — the per-session log of which named ontologies a
 * run has TOUCHED (one row per `(session_id, ontology)`). Each agent operation
 * that resolves to a named ontology records a row here (idempotent on the PK).
 *
 * The rule the gate enforces from this set:
 *   - READS are always allowed; they just record the ontology they touched.
 *   - WRITES are allowed only while the session's touched set is a SINGLE named
 *     ontology equal to the write target. Once a session has touched two or
 *     more ontologies (e.g. by reading across them), every write is blocked —
 *     "read across ontologies → you can't write anymore at all."
 *
 * Postgres is the durable source of truth so the boundary holds across a
 * backend restart (an in-memory set would reset and silently un-poison a run).
 * A write-through in-process cache fronts this table for the chatty read path;
 * a cache miss falls back here.
 *
 *   - PK is `(session_id, ontology)` — a set, idempotent on repeat touches.
 *   - `ontology` is the resolved ontology id (e.g. `KnowledgeBase/Product`).
 *     Neutral touches don't record, so they never write a row.
 *   - `touched_at` drives the abandoned-run `sweepOlderThan` backstop; the
 *     primary reclamation is an explicit delete of all of a session's rows at
 *     run end.
 */
/**
 * OAuth clients dynamically registered by MCP clients (RFC 7591 DCR). When an
 * MCP client (claude.ai, Claude Code) connects to `/api/mcp` without a
 * connection key, it registers itself here via `POST /register`, then runs the
 * PKCE authorization-code flow against our authorize/token endpoints.
 *
 * `client_secret_encrypted` is AES-256-GCM ciphertext (`iv:tag:ct`), NOT a
 * hash: the MCP SDK's token-endpoint client-auth middleware plaintext-compares
 * `client.client_secret`, so `getClient` must return the original value. In
 * practice MCP clients register as PUBLIC clients (`token_endpoint_auth_method
 * 'none'`, PKCE only) and the column stays NULL. `metadata` snapshots the full
 * registration object so `getClient` can rebuild it without lossy re-mapping.
 */
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientSecretEncrypted: text('client_secret_encrypted'),
  clientSecretExpiresAt: timestamp('client_secret_expires_at'),
  redirectUris: jsonb('redirect_uris').notNull().$type<string[]>().default(sql`'[]'::jsonb`),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
  clientName: text('client_name'),
  metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * One-time OAuth authorization codes, issued when a user clicks Finish on the
 * `/connect` consent page and exchanged at `/token` within seconds. Stored as
 * a SHA-256 hash like every other bearer secret here. The row binds the code
 * to (user, client, redirect_uri, PKCE challenge) so the token exchange can
 * verify all four; single-use is enforced by the atomic consume
 * `UPDATE … SET consumed_at = now() WHERE consumed_at IS NULL` (same pattern
 * as `upload_tokens.used_at`).
 */
export const oauthAuthCodes = pgTable('oauth_auth_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  codeHash: text('code_hash').notNull().unique(),
  clientId: text('client_id').notNull().references(() => oauthClients.clientId),
  userId: uuid('user_id').notNull().references(() => users.id),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope'),
  resource: text('resource'),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  // Sweep expired/spent rows without a full scan.
  byExpiry: index('oauth_auth_codes_by_expiry').on(t.expiresAt),
}));

/**
 * OAuth access/refresh token pairs minted by the token endpoint. Like
 * `api_tokens`: plaintext shown only in the token response, SHA-256 hashes
 * stored, revoked-not-deleted so `last_used_at` keeps its audit value and a
 * revoked token can't be re-issued. One row per pair; refresh rotation
 * revokes the old row and inserts a new one.
 */
export const oauthTokens = pgTable('oauth_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  accessTokenHash: text('access_token_hash').notNull().unique(),
  refreshTokenHash: text('refresh_token_hash').unique(),
  clientId: text('client_id').notNull().references(() => oauthClients.clientId),
  userId: uuid('user_id').notNull().references(() => users.id),
  scope: text('scope'),
  resource: text('resource'),
  expiresAt: timestamp('expires_at').notNull(),
  refreshExpiresAt: timestamp('refresh_expires_at'),
  revokedAt: timestamp('revoked_at'),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  byUser: index('oauth_tokens_by_user').on(t.userId),
  byExpiry: index('oauth_tokens_by_expiry').on(t.expiresAt),
}));

export const sessionOntologyTouches = pgTable('session_ontology_touches', {
  sessionId: text('session_id').notNull(),
  ontology: text('ontology').notNull(),
  touchedAt: timestamp('touched_at').defaultNow().notNull(),
}, (t) => ({
  // The composite PK leads with `session_id`, so a load-by-session SELECT is
  // already served by the PK index — no separate `by_session` index needed.
  pk: primaryKey({ columns: [t.sessionId, t.ontology] }),
  // Backstop sweep of abandoned runs via `touched_at < cutoff`.
  byTouchedAt: index('session_ontology_touches_by_touched_at').on(t.touchedAt),
}));

/**
 * Deployment-wide settings an admin can change from the setup screen, so a
 * fresh install does not have to be told everything through the environment
 * before it will boot.
 *
 * KEY/VALUE rather than typed columns: the set grows (the KB remote first, the
 * branch model after it), and a migration per setting buys nothing when every
 * value arrives from a text input anyway. Validation lives with the setting's
 * definition, not in the column type.
 *
 * The ENVIRONMENT still wins over anything stored here — a row is a fallback,
 * never an override. That is what lets an existing deployment adopt this table
 * with no behaviour change, and stops a value typed once in a browser from
 * quietly outranking the infrastructure config that is under review.
 */
export const deploymentSettings = pgTable('deployment_settings', {
  key: text('key').primaryKey(),
  /** Ciphertext when `encrypted`, plain text otherwise. */
  value: text('value').notNull(),
  /**
   * Whether `value` is sealed with the secrets key. Stored per row rather than
   * inferred from the key name so a reader never has to know the catalogue to
   * know whether it is holding a secret.
   */
  encrypted: boolean('encrypted').default(false).notNull(),
  /**
   * Who last wrote it. `set null` on delete rather than cascade: erasing a
   * person must not take the deployment's configuration with them.
   */
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

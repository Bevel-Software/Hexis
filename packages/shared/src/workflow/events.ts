/**
 * Workflow event bus types — what the backend pushes over SSE to keep the
 * frontend in sync with state changes, including those triggered by other
 * users on the same branch or by the agent acting server-side.
 *
 * **Scope model** — events have one of three scopes, set by the variant:
 *
 *   - **Workspace-scoped** (`workspaceId` field). Pushed to every connected
 *     session whose current focus is `workspaceId`. Examples: a file changed
 *     on this branch, someone took the lock on a file. Anyone editing this
 *     branch cares.
 *
 *   - **User-scoped** (`forUserId` field, no `workspaceId`). Pushed only to
 *     sessions opened by `forUserId`, regardless of their current focus.
 *     Examples: an agent turn called a tool on your behalf, your view should
 *     navigate to a different branch. Other users on the same branch don't
 *     care.
 *
 *   - **Global** (no `workspaceId`, no `forUserId`). Pushed to every
 *     authenticated session. Examples: change requests opening / merging /
 *     being rejected — any user with access to the repo might care.
 *
 * **Identity + replay** — every event carries an `id` (monotonic int) and an
 * ISO `ts`. Clients reconnecting with `Last-Event-ID: <id>` get the buffered
 * tail replayed (server's ring buffer is finite — see `WorkflowEventBus`).
 * If `id` is older than what the buffer still has, the server sends a
 * `{ kind: 'resync' }` instead so the client refetches the world cleanly.
 *
 * **Idempotency over exactly-once** — clients tolerate duplicates and
 * out-of-order delivery: every payload carries enough state for the UI to
 * reach the right end state regardless of how many times it sees the event
 * (e.g. `file-changed` includes the new SHA — UI only refreshes if the open
 * tab's SHA differs).
 */

export interface WorkflowEventEnvelope {
  /** Monotonic, process-local. Used for `Last-Event-ID` replay. */
  id: number;
  /** ISO timestamp the event was emitted on the backend. */
  ts: string;
}

// ── Workspace-scoped ─────────────────────────────────────────────────────────

/**
 * A file's content changed on disk — fires for ANY write that lands bytes
 * for `(workspaceId, branch, path)`, whether or not a commit followed.
 *
 *   - **`newSha` set** → a commit landed. The disk write came through the
 *     full lock-release pipeline (acquire → write → commitFile → push).
 *     History views should refetch.
 *
 *   - **`newSha === null`** → disk bytes changed but no commit yet, i.e.
 *     the writer is mid-edit (lock still held — e.g. the editor's Ctrl+S
 *     autosave-to-disk before the final Save click). Watchers should
 *     refetch content but NOT history (nothing new in git log).
 *
 * Emitted from both the human PUT/PATCH/DELETE routes and the agent's
 * LockingFilesystem so anyone tailing the file sees changes immediately.
 */
export interface FileChangedEvent {
  kind: 'file-changed';
  workspaceId: string;
  branch: string;
  path: string;
  /** Commit sha if a commit landed; null if this was a disk-only write. */
  newSha: string | null;
  /** The user whose write caused the change. */
  byUserId: string;
  byUserName: string;
}

/** Someone (`holderUserId`) just acquired the lock on `(branch, path)`. */
export interface LockAcquiredEvent {
  kind: 'lock-acquired';
  workspaceId: string;
  branch: string;
  path: string;
  holderUserId: string;
  holderName: string;
}

/** The lock on `(branch, path)` was released — file is free for the next caller. */
export interface LockReleasedEvent {
  kind: 'lock-released';
  workspaceId: string;
  branch: string;
  path: string;
}

/**
 * The file tree for `(workspaceId, branch)` changed in a way that's not
 * captured by a single `file-changed` event — typically a recursive delete,
 * a move, or an unzip extracting many files. Emitted alongside per-file
 * `file-changed` events, but lets the file explorer refresh once instead of
 * N times.
 */
export interface FsTreeChangedEvent {
  kind: 'fs-tree-changed';
  workspaceId: string;
  branch: string;
}

// ── User-scoped ──────────────────────────────────────────────────────────────

/**
 * Agent called `switch_branch` mid-turn and the target validated +
 * pre-warmed successfully. Tells the frontend to navigate to the new draft
 * once the in-flight chat turn completes — navigation mid-stream would tear
 * down the chat connection. The chat hook stashes the latest pending
 * destination and consumes it in `onFinish`. The native chat path stamps the
 * `threadId`; the registry `switch_branch` tool (called over the internal
 * loopback, which carries no threadId) omits it, so the frontend keys the
 * pending destination on `forUserId` — a user has one active chat stream.
 *
 * User-scoped (no `workspaceId`) — only the user whose agent ran the tool
 * should follow; other users on the same branch don't care.
 */
export interface BranchSwitchedEvent {
  kind: 'branch-switched';
  forUserId: string;
  threadId?: string;
  branch: string;
  workspaceId: string;
}

/**
 * Agent (running on `forUserId`'s behalf) is about to call a tool — used by
 * the file explorer to highlight files the agent is touching and by the
 * chat sidebar to show a live activity feed without parsing the chat
 * stream's data parts.
 *
 * Fired BEFORE the tool runs; the resulting `file-changed` /
 * `change-request-opened` / etc. events arrive after.
 */
export interface AgentToolCallEvent {
  kind: 'agent-tool-call';
  forUserId: string;
  threadId: string;
  tool: string;
  /**
   * Free-form summary of what the tool is about to do (e.g. `"writing
   * Knowledge/Foo.md"`, `"opening change request Foo → target-company-state"`).
   * Optional — purely informational, never load-bearing.
   */
  summary?: string;
}

// ── Global ───────────────────────────────────────────────────────────────────

export interface ChangeRequestOpenedEvent {
  kind: 'change-request-opened';
  number: number;
  source: string;
  target: string;
  /** Hash of the author's email (matches the marker in the CR body); null when unattributable. */
  authorIdHash: string | null;
  title: string;
}

export interface ChangeRequestMergedEvent {
  kind: 'change-request-merged';
  number: number;
}

export interface ChangeRequestRejectedEvent {
  kind: 'change-request-rejected';
  number: number;
}

/**
 * A merge the caller triggered did NOT land — either the gate refused it, the
 * branch needs conflict resolution, or `gh pr merge` failed. The merge route
 * is async (returns 202 immediately so a large PR's merge can't outlive the
 * gateway timeout), so this is how the failure reaches the UI that kicked it
 * off. Success travels on `change-request-merged` instead.
 *
 * User-scoped (`forUserId`, no `workspaceId`) — a failed merge changes no
 * shared state; only the user who clicked needs the reason, so we don't
 * broadcast the error string to every session.
 */
export interface ChangeRequestMergeFailedEvent {
  kind: 'change-request-merge-failed';
  forUserId: string;
  number: number;
  /** Human-readable reason for the error banner (tokens already redacted). */
  reason: string;
  /**
   * True when the merge failed because the branch needs conflict resolution.
   * The UI routes to the agent resolution flow instead of showing an error.
   */
  conflicts: boolean;
}

/**
 * Per-file approval on a change request was added or removed (e.g. via the
 * Approve / Withdraw confirmation buttons, or auto-invalidated by a new
 * commit). The UI re-fetches the CR detail to get the updated approval set.
 */
export interface ApprovalChangedEvent {
  kind: 'approval-changed';
  number: number;
  path: string;
  approverUserId: string;
  change: 'added' | 'removed';
}

// ── Control ──────────────────────────────────────────────────────────────────

/**
 * Sent every ~25 s on the SSE stream to keep proxies / load balancers from
 * killing idle connections. Carries no payload state — the client ignores it
 * apart from the keepalive effect.
 */
export interface HeartbeatEvent {
  kind: 'heartbeat';
}

/**
 * Server told the client to discard its cached state and refetch from
 * scratch — sent when a reconnecting client's `Last-Event-ID` is older than
 * the server's ring buffer still has, so we can't trust an event replay to
 * catch them up.
 */
export interface ResyncEvent {
  kind: 'resync';
  /** Human-readable reason for logs / debugging. */
  reason: string;
}

// ── Union + helpers ──────────────────────────────────────────────────────────

export type WorkflowEventPayload =
  | FileChangedEvent
  | LockAcquiredEvent
  | LockReleasedEvent
  | FsTreeChangedEvent
  | BranchSwitchedEvent
  | AgentToolCallEvent
  | ChangeRequestOpenedEvent
  | ChangeRequestMergedEvent
  | ChangeRequestRejectedEvent
  | ChangeRequestMergeFailedEvent
  | ApprovalChangedEvent
  | HeartbeatEvent
  | ResyncEvent;

export type WorkflowEvent = WorkflowEventEnvelope & WorkflowEventPayload;

/** True for events scoped to a workspace — the focus filter applies. */
export function isWorkspaceScoped(
  e: WorkflowEventPayload,
): e is WorkflowEventPayload & { workspaceId: string } {
  return (
    e.kind === 'file-changed' ||
    e.kind === 'lock-acquired' ||
    e.kind === 'lock-released' ||
    e.kind === 'fs-tree-changed'
  );
}

/** True for events scoped to a specific user — the user filter applies. */
export function isUserScoped(
  e: WorkflowEventPayload,
): e is WorkflowEventPayload & { forUserId: string } {
  return (
    e.kind === 'agent-tool-call' ||
    e.kind === 'branch-switched' ||
    e.kind === 'change-request-merge-failed'
  );
}

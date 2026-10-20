/**
 * Who may receive an event: the per-kind delivery rule the events route
 * applies, once per event per session, before it writes the event out.
 *
 * The bus decides which sessions HEAR about an event — its focus filter
 * (workspace-scoped kinds) and user filter (user-scoped kinds). That is a
 * delivery filter, and a session may name any workspace as its focus. This is
 * the access check on top of it: an event that names something reaches only a
 * person who may read what it names, judged by the same services the routes
 * that serve that thing judge it by.
 *
 *   - An event that names a path on a workspace (`file-changed`, the two lock
 *     events, and any later kind that carries `workspaceId` and `path`): the
 *     person may read the path on that branch, as the file routes judge it.
 *   - `approval-changed`: the person may read the approved path at the
 *     request's target branch — the verdict the request's own detail and the
 *     merge gate are scoped by. Judged on the path alone, from the access
 *     tree at `origin/<target>`, which is cached by commit: never by reading
 *     the request's detail, which diffs the branch pair with several git
 *     subprocesses per person per event.
 *   - `git-sync-failed`: the event names the workspace's root and, for a sync
 *     conflict, each conflicted file (its `reason` quotes them too). The person
 *     gets the paths they may read; git's words reach only a person who may
 *     read the root and every path the conflict names, and everyone else gets
 *     a fixed sentence.
 *   - `agent-tool-call`: the person whose agent made the call, and admins.
 *
 * Every other kind is delivered as it is. That includes the change-request
 * lifecycle kinds (`change-request-opened`, `-merged`, `-rejected`,
 * `-apply-failed`): they carry a number and branch names, no title and no
 * paths, so there is nothing in them a person may not read, and every tab
 * refetches the lists it may see. A verdict that cannot be reached (the
 * access tree fails to load) withholds, or for `git-sync-failed` redacts:
 * failing closed costs a live refresh, failing open names a file.
 *
 * Nothing here changes what publishers emit; the rule only reads the event.
 */

import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import type { IAccessControl } from '../access/index.js';
import type { IAdminAccessService } from '../admin/index.js';
import { canReadWorkspacePath } from '../access-model/index.js';

const log = logger('events');

/** What a `git-sync-failed` says in place of git's words. */
const GIT_SYNC_FAILED_REDACTED_REASON = 'The last push did not land.';

/** The person behind a session, as the auth middleware named them. */
export interface EventViewer {
  userId: string;
  email: string | undefined;
}

/**
 * The verdicts the rule asks for. Each one is the question a route already
 * answers for the thing the event names; `createEventAccess` wires them to
 * those services, and tests to a fake.
 */
export interface EventAccess {
  /** May `email` read the workspace-relative `wsPath` on `workspaceId` — the file routes' verdict. */
  mayReadPath(workspaceId: string, email: string, wsPath: string): Promise<boolean>;
  /** May `email` read the KB-repo-relative `repoPath` on `workspaceId`; `''` is the root. */
  mayReadRepoPath(workspaceId: string, email: string, repoPath: string): Promise<boolean>;
  /**
   * May `email` read the KB-repo-relative `repoPath` at the published tip of
   * `targetBranch` — what a request into that branch is scoped by.
   */
  mayReadAtTarget(targetBranch: string, email: string, repoPath: string): Promise<boolean>;
  isAdmin(email: string): Promise<boolean>;
}

/**
 * What the events route asks of the rule. The route depends on this, never on
 * `EventDelivery`, so the rule can be substituted behind it.
 */
export interface IEventDelivery {
  /** The event as `viewer` may receive it: itself, a redacted copy, or null. Never rejects. */
  judge(event: WorkflowEvent, viewer: EventViewer): Promise<WorkflowEvent | null>;
  /** Whether `viewer` is an admin. Never rejects; a failure is a no. */
  isAdmin(viewer: EventViewer): Promise<boolean>;
}

/** The deployment's `EventAccess`: the access service the file routes and the request tools use. */
export function createEventAccess(deps: {
  accessControl: Pick<IAccessControl, 'canRead' | 'canReadBatchAtRef'>;
  adminAccess: IAdminAccessService;
  kbDirName: string;
  /**
   * A workspace to read a published ref in. Every verdict at `origin/<branch>`
   * is the same from any clone of the repository, so any existing one serves;
   * the composition root answers with one that exists.
   */
  anyWorkspaceId: () => Promise<string>;
}): EventAccess {
  return {
    mayReadPath: (workspaceId, email, wsPath) =>
      canReadWorkspacePath(
        (w, e, p) => deps.accessControl.canRead(w, e, p),
        workspaceId,
        email,
        deps.kbDirName,
        wsPath,
      ),
    mayReadRepoPath: (workspaceId, email, repoPath) => deps.accessControl.canRead(workspaceId, email, repoPath),
    mayReadAtTarget: async (targetBranch, email, repoPath) => {
      const verdicts = await deps.accessControl.canReadBatchAtRef(
        await deps.anyWorkspaceId(),
        `origin/${targetBranch}`,
        email,
        [repoPath],
      );
      // A ref that cannot be resolved answers null: nothing is granted on it.
      return verdicts?.get(repoPath) === true;
    },
    isAdmin: (email) => deps.adminAccess.isAdmin(email),
  };
}

/**
 * The event as `viewer` may receive it: the event itself, a redacted copy, or
 * null for nothing at all.
 */
async function deliveryFor(
  event: WorkflowEvent,
  viewer: EventViewer,
  access: EventAccess,
): Promise<WorkflowEvent | null> {
  const email = viewer.email;
  try {
    switch (event.kind) {
      case 'approval-changed':
        return email && (await access.mayReadAtTarget(event.targetBranch, email, event.path)) ? event : null;
      case 'git-sync-failed':
        return email ? await gitSyncFailedFor(event, email, access) : redactGitSyncFailed(event, []);
      case 'agent-tool-call':
        return viewer.userId === event.forUserId || (email && (await access.isAdmin(email))) ? event : null;
    }
    // Structural, not by kind: anything that names a path on a workspace is
    // judged by the path, so a kind added later is covered without a line here.
    const named = pathOnWorkspace(event);
    if (named) return email && (await access.mayReadPath(named.workspaceId, email, named.path)) ? event : null;
    return event;
  } catch (err) {
    log.warn(`delivery verdict failed for event id=${event.id} kind=${event.kind} user=${viewer.userId}; withheld`, { err });
    return event.kind === 'git-sync-failed' ? redactGitSyncFailed(event, []) : null;
  }
}

type GitSyncFailed = Extract<WorkflowEvent, { kind: 'git-sync-failed' }>;

/**
 * Every path the event names is judged: the root, which git's words are about,
 * and each conflicted file, which a conflict's `reason` also quotes. Git's
 * words go out only when every one of them is readable; otherwise the person
 * keeps the conflicted files they may read and a fixed sentence.
 */
async function gitSyncFailedFor(event: GitSyncFailed, email: string, access: EventAccess): Promise<WorkflowEvent> {
  const conflicted = event.conflictedPaths ?? [];
  const [root, ...each] = await Promise.all([
    access.mayReadRepoPath(event.workspaceId, email, ''),
    ...conflicted.map((p) => access.mayReadRepoPath(event.workspaceId, email, p)),
  ]);
  const readable = conflicted.filter((_, i) => each[i]);
  return root && readable.length === conflicted.length ? event : redactGitSyncFailed(event, readable);
}

function pathOnWorkspace(event: WorkflowEvent): { workspaceId: string; path: string } | null {
  const e = event as { workspaceId?: unknown; path?: unknown };
  return typeof e.workspaceId === 'string' && typeof e.path === 'string'
    ? { workspaceId: e.workspaceId, path: e.path }
    : null;
}

/**
 * Same shape, so a client parses it as before: git's words are gone, and of
 * the conflicted files only `readable` remain (none, the key absent).
 */
function redactGitSyncFailed(event: GitSyncFailed, readable: string[]): WorkflowEvent {
  const redacted: GitSyncFailed = { ...event, reason: GIT_SYNC_FAILED_REDACTED_REASON };
  if (readable.length > 0) redacted.conflictedPaths = readable;
  else delete redacted.conflictedPaths;
  return redacted;
}

/**
 * The rule, shared per (event, person) while it is being judged: a person with
 * three tabs open is judged once per event, not three times. A verdict is
 * dropped the moment it settles and never reused, so a replay after a
 * reconnect asks again, and a grant or a revocation since the event was first
 * delivered decides what the replay carries.
 */
export class EventDelivery implements IEventDelivery {
  private readonly inFlight = new Map<string, Promise<WorkflowEvent | null>>();

  constructor(private readonly access: EventAccess) {}

  /** Whether `viewer` is an admin; never rejects, a failure being a no. */
  async isAdmin(viewer: EventViewer): Promise<boolean> {
    if (!viewer.email) return false;
    try {
      return await this.access.isAdmin(viewer.email);
    } catch (err) {
      log.warn(`admin resolution failed for user=${viewer.userId}; treated as not admin`, { err });
      return false;
    }
  }

  judge(event: WorkflowEvent, viewer: EventViewer): Promise<WorkflowEvent | null> {
    const key = `${event.id}\u0000${event.ts}\u0000${viewer.userId}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    // `deliveryFor` never rejects: a verdict it cannot reach withholds the
    // event, or for `git-sync-failed` redacts it.
    const verdict = deliveryFor(event, viewer, this.access).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, verdict);
    return verdict;
  }
}

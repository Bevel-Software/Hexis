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
 *   - `approval-changed`: the request may name that path to the person, as the
 *     change-request tools judge it.
 *   - `change-request-opened`: the person may see the request, as
 *     `get_change_request` and the request list judge it.
 *   - `git-sync-failed`: a person who may not read the workspace's root gets
 *     the event with git's words replaced by a fixed sentence.
 *   - `agent-tool-call`: the person whose agent made the call, and admins.
 *
 * Every other kind is delivered as it is. A verdict that cannot be reached
 * (the access tree fails to load, the request cannot be read) withholds:
 * failing closed costs a live refresh, failing open names a file.
 *
 * Nothing here changes what publishers emit; the rule only reads the event.
 */

import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import { canReadWorkspacePath } from '../access-model/kb-read-filter.js';
import type { ScopeCaller, ScopedDetail } from './agent-tools/change-request-read.tools.js';

const log = logger('events');

/** What a `git-sync-failed` says to a person who may not read the workspace's root. */
export const GIT_SYNC_FAILED_REDACTED_REASON = 'The last push did not land.';

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
  /** May `email` read the root of `workspaceId`. */
  mayReadRoot(workspaceId: string, email: string): Promise<boolean>;
  /** May `email` see change request `number` at all — what `get_change_request` answers 404 for, as a no. */
  maySeeChangeRequest(number: number, email: string): Promise<boolean>;
  /** May request `number` name `path` to `email` — its approvals and comments are shown on the same rule. */
  mayShowChangeRequestPath(number: number, email: string, path: string): Promise<boolean>;
  isAdmin(email: string): Promise<boolean>;
}

/** The deployment's `EventAccess`: the access service the file routes use, and the change-request scope the tools use. */
export function createEventAccess(deps: {
  accessControl: Pick<IAccessControl, 'canRead'>;
  adminAccess: IAdminAccessService;
  kbDirName: string;
  /** `changeRequestScope(...).scopedDetail`, the tools' own read of a request. */
  scopedDetail: (caller: ScopeCaller, number: number, opts: { patches: boolean }) => Promise<ScopedDetail>;
  /** `changeRequestScope(...).maySee`. */
  maySee: (caller: ScopeCaller, number: number) => Promise<boolean>;
  services: Omit<ScopeCaller, 'user'>;
}): EventAccess {
  const caller = (email: string): ScopeCaller => ({ ...deps.services, user: { email } });
  return {
    mayReadPath: (workspaceId, email, wsPath) =>
      canReadWorkspacePath(
        (w, e, p) => deps.accessControl.canRead(w, e, p),
        workspaceId,
        email,
        deps.kbDirName,
        wsPath,
      ),
    mayReadRoot: (workspaceId, email) => deps.accessControl.canRead(workspaceId, email, ''),
    maySeeChangeRequest: (number, email) => deps.maySee(caller(email), number),
    mayShowChangeRequestPath: async (number, email, path) => {
      // `scopedDetail` answers a request the person may not see with a 404,
      // which is a no here like any other failure.
      const scoped = await deps.scopedDetail(caller(email), number, { patches: false });
      return scoped.mayShow(path);
    },
    isAdmin: (email) => deps.adminAccess.isAdmin(email),
  };
}

/**
 * The event as `viewer` may receive it: the event itself, a redacted copy, or
 * null for nothing at all.
 */
export async function deliveryFor(
  event: WorkflowEvent,
  viewer: EventViewer,
  access: EventAccess,
): Promise<WorkflowEvent | null> {
  const email = viewer.email;
  try {
    switch (event.kind) {
      case 'approval-changed':
        return email && (await access.mayShowChangeRequestPath(event.number, email, event.path)) ? event : null;
      case 'change-request-opened':
        return email && (await access.maySeeChangeRequest(event.number, email)) ? event : null;
      case 'git-sync-failed':
        return email && (await access.mayReadRoot(event.workspaceId, email)) ? event : redactGitSyncFailed(event);
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
    return event.kind === 'git-sync-failed' ? redactGitSyncFailed(event) : null;
  }
}

function pathOnWorkspace(event: WorkflowEvent): { workspaceId: string; path: string } | null {
  const e = event as { workspaceId?: unknown; path?: unknown };
  return typeof e.workspaceId === 'string' && typeof e.path === 'string'
    ? { workspaceId: e.workspaceId, path: e.path }
    : null;
}

/** Same shape, so a client parses it as before; git's words and the paths a conflict names are gone. */
function redactGitSyncFailed(event: Extract<WorkflowEvent, { kind: 'git-sync-failed' }>): WorkflowEvent {
  const redacted = { ...event, reason: GIT_SYNC_FAILED_REDACTED_REASON };
  delete redacted.conflictedPaths;
  return redacted;
}

/**
 * The rule, shared per (event, person) while it is being judged: a person with
 * three tabs open is judged once per event, not three times. A verdict is
 * dropped the moment it settles and never reused, so a replay after a
 * reconnect asks again, and a grant or a revocation since the event was first
 * delivered decides what the replay carries.
 */
export class EventDelivery {
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

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
 *     person may read the path on that branch, as the file routes judge it —
 *     after the one normaliser the file routes put every path through, so a
 *     path a client sent without the `<kbDirName>/` prefix (the lock route
 *     takes both spellings) is judged as the repository path it names, never
 *     as "outside the knowledge base, readable".
 *   - `approval-changed`: the person may read the approved path on the
 *     request's target branch — judged as a file event on that branch is,
 *     from the server's checkout of it (a cached read of the access rules
 *     from disk, no git), and only for a target the server holds no checkout
 *     of from its published ref. Never by reading the request's detail, which
 *     diffs the branch pair with several git subprocesses per person per event.
 *   - `change-request-opened`: the person may see the request, by the rule the
 *     request tools list and 404 by (`maySeeChangeRequest`): its author, or
 *     someone who may read one of its files — both names of a move — at its
 *     target. The request's file list is read ONCE per event, however many
 *     sessions are judged; each person then costs one batch read verdict, from
 *     the target's checkout when the server holds one, as an approval does.
 *   - `git-sync-failed`: the event names the workspace's root and, for a sync
 *     conflict, each conflicted file (its `reason` quotes them too). The person
 *     gets the paths they may read; git's words reach only a person who may
 *     read the root and every path the conflict names, and everyone else gets
 *     a fixed sentence.
 *   - `agent-tool-call`: the person whose agent made the call, as the bus
 *     already filters it; the rule says the same, so a bus that passed it on
 *     would not widen the audience.
 *
 * Every other kind is delivered as it is. That includes the number-only
 * change-request lifecycle kinds (`-merged`, `-rejected`, `-apply-failed`),
 * which follow an announcement the person was either given or not. A verdict
 * that cannot be reached (the access tree fails to load, the request cannot be
 * read) withholds, or for `git-sync-failed` redacts:
 * failing closed costs a live refresh, failing open names a file.
 *
 * Nothing here changes what publishers emit; the rule only reads the event.
 */

import type { ChangeRequest, WorkflowEvent } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { IAccessControl } from '../access/index.js';
import { canReadWorkspacePath } from '../access-model/index.js';
import { normalizeWorkspacePath } from '../kb-fs/index.js';
import { fileIsReadable, isAuthor, maySeeChangeRequest, pathsOf } from './agent-tools/change-request-read-shape.js';

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
  /** Which of the KB-repo-relative `repoPaths` `email` may read on `targetBranch` — what a request into that branch is scoped by. */
  readableAtTarget(targetBranch: string, email: string, repoPaths: string[]): Promise<Set<string>>;
  /**
   * Request `number` as the request list judges it — its target, author and
   * changed files — or null when there is none. Read once per event: callers
   * judging one event for many sessions share the read.
   */
  changeRequest(number: number): Promise<ChangeRequestFacts | null>;
}

/** What the visibility rule reads of a request. */
export type ChangeRequestFacts = Pick<ChangeRequest, 'base' | 'authorId' | 'touchedNodeFiles'>;

/**
 * What the events route asks of the rule. The route depends on this, never on
 * `EventDelivery`, so the rule can be substituted behind it.
 */
export interface IEventDelivery {
  /** The event as `viewer` may receive it: itself, a redacted copy, or null. Never rejects. */
  judge(event: WorkflowEvent, viewer: EventViewer): Promise<WorkflowEvent | null>;
}

/** The deployment's `EventAccess`: the access service the file routes use, read in the server's own checkouts. */
export function createEventAccess(deps: {
  accessControl: Pick<IAccessControl, 'canRead' | 'canReadBatch' | 'canReadBatchAtRef'>;
  kbDirName: string;
  /** `IWorkflowService.getChangeRequest`: the summary the request list judges, files included. */
  getChangeRequest(number: number): Promise<ChangeRequestFacts | null>;
  workspaces: {
    /** Whether the server holds a checkout for `workspaceId` (the branch's own workspace). */
    hasWorkspace(workspaceId: string): Promise<boolean>;
    /**
     * A workspace to read a published ref in, for a target the server holds
     * no checkout of. Every verdict at `origin/<branch>` is the same from any
     * clone of the repository, so any existing one serves.
     */
    anyWorkspaceId(): Promise<string>;
  };
}): EventAccess {
  /** A request's read, shared while it is in flight: one per event's fan-out, never a stale one after. */
  const requestsInFlight = new Map<number, Promise<ChangeRequestFacts | null>>();
  return {
    // Normalised first, by the file routes' own normaliser: a path it refuses
    // throws, and the rule withholds the event.
    mayReadPath: async (workspaceId, email, wsPath) =>
      canReadWorkspacePath(
        (w, e, p) => deps.accessControl.canRead(w, e, p),
        workspaceId,
        email,
        deps.kbDirName,
        normalizeWorkspacePath(wsPath, deps.kbDirName),
      ),
    mayReadRepoPath: (workspaceId, email, repoPath) => deps.accessControl.canRead(workspaceId, email, repoPath),
    readableAtTarget: async (targetBranch, email, repoPaths) => {
      if (repoPaths.length === 0) return new Set();
      const unique = [...new Set(repoPaths)];
      // The branch's own checkout, when the server has one (the default
      // branch always): the same disk read a file event on that branch gets.
      const own = workspaceIdForBranch(targetBranch);
      const verdicts = (await deps.workspaces.hasWorkspace(own))
        ? await deps.accessControl.canReadBatch(own, email, unique)
        : await deps.accessControl.canReadBatchAtRef(
            await deps.workspaces.anyWorkspaceId(),
            `origin/${targetBranch}`,
            email,
            unique,
          );
      // A ref that cannot be resolved answers null: nothing is granted on it.
      return new Set(unique.filter((p) => verdicts?.get(p) === true));
    },
    changeRequest: (number) => {
      const pending = requestsInFlight.get(number);
      if (pending) return pending;
      const read = deps.getChangeRequest(number).finally(() => requestsInFlight.delete(number));
      requestsInFlight.set(number, read);
      return read;
    },
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
        return email && (await access.readableAtTarget(event.targetBranch, email, [event.path])).has(event.path)
          ? event
          : null;
      case 'change-request-opened':
        return email && (await maySeeRequest(event.number, email, access)) ? event : null;
      case 'git-sync-failed':
        return email ? await gitSyncFailedFor(event, email, access) : redactGitSyncFailed(event, []);
      case 'agent-tool-call':
        return viewer.userId === event.forUserId ? event : null;
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

/**
 * The request tools' visibility rule, over the request the list judges: its
 * author sees it; anyone else sees it when one of its files is readable at
 * the target, a move only when both its names are. No request, no file list
 * (a diff that could not be computed): author only, as the tools answer it.
 */
async function maySeeRequest(number: number, email: string, access: EventAccess): Promise<boolean> {
  const request = await access.changeRequest(number);
  if (!request) return false;
  if (isAuthor(request, email)) return true;
  const files = request.touchedNodeFiles ?? [];
  const readable = await access.readableAtTarget(request.base, email, files.flatMap(pathsOf));
  const readableFiles = files.filter((f) => fileIsReadable(f, (p) => readable.has(p))).length;
  return maySeeChangeRequest({ readableFiles, isAuthor: false });
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

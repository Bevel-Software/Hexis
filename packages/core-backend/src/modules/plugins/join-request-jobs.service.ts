import {
  DEFAULT_BRANCH,
  joinBranchFor,
  type AuthUser,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { spliceGrant } from '../access-model/access-splice.js';
import { sanitizeError } from '../workflow/sanitize-error.js';
import { logger } from '../../shared/logging.js';
import { printable } from '../../shared/printable.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { pluginsWorkspaceId } from './plugins.service.js';
import type { JoinRequestRecord, JoinRequestStore } from './join-request-records.store.js';

const log = logger('plugins');

/**
 * How long a claim on a record holds before another process may take it over.
 *
 * Has to exceed the longest honest attempt, and that is a first-ever request:
 * a full clone of the plugins repository, which is minutes on a real one. Too
 * short and a redeploy's two processes both work the same branch, which is
 * the thing the claim exists to prevent; too long and a request whose process
 * died mid-clone waits that much longer to be finished. Fifteen minutes is
 * comfortably past the clone and well inside a person's patience for a
 * request they have already been told was received.
 */
const CLAIM_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * A failure that says nothing about the REQUEST — the platform simply could
 * not do the work just now. Thrown instead of returning a refusal when the
 * knowledge base is not readable yet, which is a boot that has not finished
 * cloning or a remote that blipped, and is indistinguishable from "the plugin
 * was deleted" if you only look at an empty catalog.
 *
 * The difference matters to the person who clicked: a refusal is shown to
 * them and takes their request off the page, while this leaves the row
 * `pending` — still "Requested", still owed — for the next sweep to retry.
 */
export class JoinRequestNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoinRequestNotReadyError';
  }
}

/** What a recorded plugin key still names, resolved when the job runs. */
export interface JoinRequestTarget {
  /** The plugin's primary folder, workspace-relative (`Plugins/Finance`). */
  folder: string;
  /** What people call it — the change request's title and body carry this. */
  displayName: string;
}

export interface JoinRequestJobsDeps {
  workflow: Pick<
    IWorkflowService,
    | 'createBranch'
    | 'listBranches'
    | 'commitChanges'
    | 'openChangeRequest'
    | 'listChangeRequestsAuthoredBy'
  >;
  workspaceService: Pick<WorkspaceService, 'getOrCreateForBranch' | 'readFile' | 'writeFile'>;
  kbDirName: string;
  /**
   * The plugin a recorded key still names, or null when nothing does — it was
   * deleted, or its folder moved out from under the record.
   */
  target(pluginKey: string): Promise<JoinRequestTarget | null>;
  /**
   * The requester as an author. Resolved per run rather than carried on the
   * record because the boot sweep has no request to read an identity from,
   * and the commit and change request are the requester's, not the platform's.
   */
  requester(email: string): Promise<AuthUser | null>;
}

/**
 * The git half of a join request, after the answer.
 *
 * The endpoint used to do all of this before it replied: create the branch on
 * the remote, clone the plugins repository for it (many seconds the first
 * time a person asks for anything), splice the grant into `access.md`, commit,
 * push, open the change request. The click looked like a freeze for as long as
 * that took. So the route now records the ask and answers, and this runs the
 * same steps afterwards, against the recorded row — nothing about what lands
 * on the git host changed, including the change request's title, body and
 * diff, so the plugin's managers see exactly what they saw before.
 *
 * SINGLE FLIGHT PER RECORD, and the record's id is the key: a second click, a
 * second tab, or a sweep that overlaps a live run all join the run already
 * under way instead of starting a second one. Since the row is unique on
 * `(requester, plugin)`, that is also what makes two clicks one change
 * request.
 *
 * AND IDEMPOTENT ANYWAY, because single-flight is an in-process promise and a
 * restart is not: every step tolerates having run before. An existing open
 * join change request is adopted rather than duplicated, a leftover branch is
 * reused, and the splice no-ops when the grant is already on the branch. That
 * is what lets the boot sweep re-run every `pending` row without asking which
 * of them got how far.
 *
 * AND ACROSS PROCESSES, by claiming the row. Single-flight is an in-process
 * map, and a redeploy runs two processes for as long as the changeover takes
 * — both sweeping, neither able to see the other's map. The sweep cannot go
 * under the commit-worker lease to fix that: it is sequenced after the
 * knowledge-base startup phase instead, in `createCoreServer`, because it
 * needs the default-branch clone that phase maintains and the plugin catalog
 * read from it, and a sweep that ran first would mark every row failed for a
 * knowledge base that was merely not ready yet. So exclusion is taken where
 * the row lives: `attempt` claims it with one conditional UPDATE, and a
 * process that does not get the claim does nothing. Two servers cloning,
 * committing and pushing the same branch into the same shared workspace is
 * what that prevents; the adoption check below, now on a FRESH listing, is
 * the second line for the change request itself.
 */
export class PluginJoinRequestJobs {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: JoinRequestStore,
    private readonly deps: JoinRequestJobsDeps,
  ) {}

  /**
   * Record the ask — the whole of what the endpoint does before answering.
   * One statement against one row, so it costs a database round-trip and no
   * git at all.
   */
  async record(user: AuthUser, pluginKey: string): Promise<JoinRequestRecord> {
    return this.store.record({
      requesterEmail: user.email,
      requesterName: user.name,
      pluginKey,
    });
  }

  /** Every request this person has recorded — what the plugin listing reads. */
  async recordsFor(email: string): Promise<JoinRequestRecord[]> {
    return this.store.forRequester(email);
  }

  /**
   * Run the git work for `record`, or join the run already under way for it.
   * Returns the flight so a test (or the sweep) can await it; callers on the
   * request path deliberately do not. Never rejects — a failure is recorded
   * on the row, which is where the requester reads it.
   */
  start(record: JoinRequestRecord): Promise<void> {
    if (record.status === 'opened') return Promise.resolve();
    const existing = this.inFlight.get(record.id);
    if (existing) return existing;
    const flight = this.run(record).finally(() => {
      this.inFlight.delete(record.id);
    });
    this.inFlight.set(record.id, flight);
    return flight;
  }

  /**
   * Re-run every record still `pending` — the boot sweep, and the whole of
   * what makes a recorded request survive a restart: a row written before the
   * process died is either completed or marked failed after it, never lost.
   */
  async sweep(): Promise<void> {
    const pending = await this.store.pending();
    if (pending.length === 0) return;
    log.info(`resuming ${pending.length} join request(s) recorded before this boot`);
    // Started, not awaited: this runs as a boot task ahead of the commit
    // worker, and a queue of first-time requests is a queue of full clones —
    // minutes of git that nothing else at boot should be made to wait behind.
    for (const record of pending) void this.start(record);
  }

  /**
   * Every job now in flight, as one promise. The test seam, and the honest
   * answer to "is the background work done" for anything that has to know.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight.values()]);
  }

  private async run(record: JoinRequestRecord): Promise<void> {
    try {
      await this.attempt(record);
    } catch (err) {
      const reason = sanitizeError(err);
      // `pluginKey` is a persisted folder path, so it is escaped before it
      // reaches a log line: a folder carrying control characters could
      // otherwise write newlines of its own into the log.
      const key = printable(record.pluginKey);
      if (err instanceof JoinRequestNotReadyError) {
        // Nothing is wrong with the request, so nothing is said to the person
        // who made it. The claim goes back so the next sweep — or their next
        // click — can pick the row up immediately rather than waiting out a
        // claim held by a process that never really started.
        log.warn(`join request for ${key} postponed: ${reason}`);
        await this.store.release(record.id).catch((releaseErr: unknown) => {
          log.warn(`could not release that claim: ${sanitizeError(releaseErr)}`);
        });
        return;
      }
      log.error(`join request for ${key} failed: ${reason}`);
      await this.store
        .markFailed(record.id, reason)
        // Nothing left to do if even that write fails: the row stays
        // `pending` and the next boot's sweep tries the whole thing again.
        .catch((writeErr: unknown) => {
          log.error(`could not record that failure: ${sanitizeError(writeErr)}`);
        });
    }
  }

  private async attempt(record: JoinRequestRecord): Promise<void> {
    const { workflow, workspaceService, kbDirName } = this.deps;
    // CLAIM THE ROW, and stop dead if somebody else holds it.
    //
    // This does the work the old `byId` re-read did — a second click carries a
    // snapshot taken before the first click's job finished, and single-flight
    // cannot catch that one, because the first flight is already gone from the
    // map — and the work that read could not do. A re-read only tells this
    // process what the row said a moment ago; on a redeploy the outgoing and
    // incoming servers both sweep, both re-read `pending`, and both proceed to
    // clone, commit and push the same branch in the same shared workspace. The
    // claim is a single conditional UPDATE, so exactly one of them is told yes.
    const live = await this.store.claim(record.id, CLAIM_STALE_AFTER_MS);
    if (!live) return;

    const target = await this.deps.target(record.pluginKey);
    if (!target) throw new Error('the plugin is no longer available');
    const user = await this.deps.requester(record.requesterEmail);
    if (!user) throw new Error('the account that asked no longer exists');

    const branch = joinBranchFor(record.requesterEmail, record.pluginKey);
    // Adopt rather than duplicate. This is the check the endpoint used to do
    // inline, moved here because it costs a change-request listing and the
    // answer must not wait for one.
    //
    // FRESH, always. This listing is the only thing standing between a retry
    // (or the redeploy window, where the outgoing and incoming processes both
    // sweep the same row) and a second change request for one request — and a
    // cached listing taken before the first attempt opened its change request
    // shows nothing to adopt. Paying a round-trip here is the point: it buys
    // the "one recorded request, one change request" promise, and it is off
    // the answer path entirely.
    const mine = await workflow.listChangeRequestsAuthoredBy(record.requesterEmail, {
      fresh: true,
    });
    const open = mine.find((cr) => cr.state === 'open' && cr.branch === branch);
    if (open) {
      await this.store.markOpened(record.id, open.number);
      return;
    }

    // A leftover branch from a rejected/withdrawn request is reused — the
    // grant commit is already on it and the splice below no-ops.
    await this.ensureBranch(branch);
    const ws = await workspaceService.getOrCreateForBranch(branch);
    const accessPath = `${kbDirName}/${target.folder}/access.md`;
    const current = await workspaceService.readFile(ws.id, accessPath).catch((err: unknown) => {
      // Absent is ordinary — a plugin whose access.md does not exist yet
      // splices its first grant from nothing. Anything else (a permission
      // error, a directory where the file should be, an I/O fault) must NOT
      // read as "empty": the commit below would then replace the plugin's
      // real rules with a file containing nothing but this one request.
      if (isFileAbsent(err)) return '';
      throw err;
    });
    const spliced = spliceGrant(
      current,
      'read',
      { kind: 'user', email: user.email, displayName: user.name },
      { target: 'folder' },
    );
    if (spliced.changed) {
      await workspaceService.writeFile(ws.id, accessPath, spliced.text);
      await workflow.commitChanges(ws.id, user, `Request access to ${target.displayName}`);
    }
    const detail = await workflow.openChangeRequest(ws.id, user, {
      sourceBranch: branch,
      targetBranch: DEFAULT_BRANCH,
      // People read these: the display name, not the identifier.
      title: `Join request: ${target.displayName}`,
      description:
        `${user.name} asked to join ${target.displayName}. A manager of the plugin accepts by ` +
        `granting the access this branch proposes; the request closes itself once ` +
        `every proposal has landed.`,
    });
    await this.store.markOpened(record.id, detail.number);
  }

  /**
   * Have the join branch, whether this call made it or an earlier one did.
   *
   * `createBranch` failing is ambiguous — the branch already exists (the
   * ordinary case: a rejected request left it, or a retry is re-running), or
   * the git host refused for a reason that leaves nothing to work against.
   * Swallowing both was the bug: every later step then ran against a branch
   * that was never created, and the requester read whatever confused error
   * fell out downstream instead of the one that actually happened.
   *
   * So a failure is only forgiven when a FRESH listing proves the branch is
   * there. `strictFetch` is what makes that a proof rather than a guess: a
   * stale list from a clone that could not reach origin would report a branch
   * created seconds ago as missing, and — worse — would let a genuine refusal
   * pass as "already exists". Anything the listing does not vouch for is
   * rethrown, which marks the row failed with the git host's own words and
   * leaves the next click free to retry the same row.
   */
  private async ensureBranch(branch: string): Promise<void> {
    const wsId = pluginsWorkspaceId();
    try {
      await this.deps.workflow.createBranch(wsId, branch, DEFAULT_BRANCH);
      return;
    } catch (err) {
      const branches = await this.deps.workflow.listBranches(wsId, {
        freshFetch: true,
        strictFetch: true,
      });
      if (!branches.some((b) => b.name === branch)) throw err;
      // It exists — this call raced another, or an earlier attempt left it.
    }
  }
}

/** Node's "there is no such file" errors, and only those. */
function isFileAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

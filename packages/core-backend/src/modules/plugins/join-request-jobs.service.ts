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
 * How often a process that is working a record says so, by pushing its
 * claim's timestamp forward.
 *
 * The claim is a LIVENESS signal, not a deadline, and the heartbeat is what
 * makes it one. Without it `claimed_at` only says when the work started, and
 * a timestamp cannot tell "another process is still doing this" from "a
 * process died holding it" — which is exactly the distinction both the
 * redeploy overlap and the crash-restart need, in opposite directions.
 */
const CLAIM_HEARTBEAT_MS = 30 * 1000;

/**
 * How long a claim outlives its last heartbeat before another process may
 * take the record over.
 *
 * Three missed beats. It does NOT have to cover the longest honest attempt —
 * that was the mistake this replaced. Sizing the window to a first-ever
 * request's full clone made a crash-restart wait out the whole clone window
 * before anything would retry, and a boot is far quicker than that, so the
 * boot sweep was refused every row it had come to rescue and gave up. A
 * heartbeat decouples the two: a live process holds its claim for as long as
 * the work genuinely takes, however long that is, and a dead one lets go
 * within a minute and a half.
 */
export const CLAIM_STALE_AFTER_MS = 90 * 1000;

/**
 * How often every `pending` record is looked at again.
 *
 * Boot alone is not enough. A redeploy's incoming process sweeps while the
 * outgoing one still holds a record — correctly skipping it — and if that
 * process then exits mid-work, nothing would look at the row again until the
 * NEXT boot, which on a healthy deployment may be days. The tick is one
 * indexed read of the rows that are still owed, and it is what makes "a
 * recorded request is always eventually finished or failed" true between
 * boots rather than only across them.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;

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
 * the row lives: `run` claims it with one conditional UPDATE, and a process
 * that does not get the claim does nothing. Two servers cloning, committing
 * and pushing the same branch into the same shared workspace is what that
 * prevents; the adoption check below, on a FRESH listing, is the second line
 * for the change request itself.
 *
 * THE CLAIM IS A HEARTBEAT, and that is the part worth being careful about. A
 * bare `claimed_at` cannot distinguish a process still working from one that
 * died holding the row, so whatever window you pick is wrong in one
 * direction: long enough to cover a first-ever request's clone, and a crash
 * leaves the request owed for that whole window — which is how the boot
 * sweep, the very thing meant to rescue it, came to be refused every row it
 * asked for and to give up silently. So a running job pushes its claim
 * forward every {@link CLAIM_HEARTBEAT_MS}, and the window is three missed
 * beats. A live process holds a row for as long as the work honestly takes; a
 * dead one lets go in ninety seconds.
 *
 * AND SOMETHING ALWAYS LOOKS AGAIN. {@link startSweeping} re-reads the owed
 * rows on a timer, not only at boot, because the one case boot cannot cover
 * is the redeploy: the incoming process skips a row the outgoing one holds,
 * and the outgoing process then exits mid-work. A requester cannot rescue
 * that themselves — a pending record shows them the "Requested" card, not a
 * button — so nothing but this tick would ever pick the row up.
 */
export class PluginJoinRequestJobs {
  private readonly inFlight = new Map<string, Promise<void>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

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
   * Re-run every record still `pending` — what makes a recorded request
   * survive: a row written before a process died is completed or marked
   * failed afterwards, never left owed.
   *
   * A record another LIVE process is working is skipped by the claim, not by
   * this: the sweep asks for everything pending and lets each attempt decide.
   */
  async sweep(): Promise<void> {
    const pending = await this.store.pending();
    if (pending.length === 0) return;
    log.info(`looking at ${pending.length} join request(s) still owed`);
    // Started, not awaited: a queue of first-time requests is a queue of full
    // clones — minutes of git that nothing else should be made to wait behind.
    for (const record of pending) void this.start(record);
  }

  /**
   * Sweep now, and keep sweeping.
   *
   * Boot alone left a hole with no second door: a redeploy's incoming process
   * sweeps while the outgoing one still holds a record, skips it correctly,
   * and then the outgoing process exits mid-work — after which nothing looked
   * at that row again until the next boot. Nothing else retries, because the
   * only other way a record is picked up is its requester clicking again, and
   * a pending record shows them the "Requested" card rather than a button.
   *
   * Idempotent, and safe to call when a sweep is already scheduled.
   */
  startSweeping(intervalMs: number = SWEEP_INTERVAL_MS): void {
    void this.sweep().catch((err: unknown) => {
      log.warn(`could not look at the join requests still owed: ${sanitizeError(err)}`);
    });
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        log.warn(`could not look at the join requests still owed: ${sanitizeError(err)}`);
      });
    }, intervalMs);
    // Never a reason for the process to stay alive: every row is durable, and
    // whatever this tick would have done the next boot's sweep does.
    this.sweepTimer.unref?.();
  }

  /** Stop the periodic sweep. Part of shutting down cleanly. */
  stopSweeping(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Every job now in flight, as one promise. The test seam, and the honest
   * answer to "is the background work done" for anything that has to know.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight.values()]);
  }

  private async run(record: JoinRequestRecord): Promise<void> {
    // CLAIM FIRST, and say nothing further if somebody else holds it.
    //
    // Claiming here rather than inside `attempt` is what lets the heartbeat
    // wrap the whole attempt: the claim has to be refreshed for as long as
    // the work runs, and the work is the part that can take minutes.
    const live = await this.store.claim(record.id, CLAIM_STALE_AFTER_MS).catch((err: unknown) => {
      log.warn(`could not claim a join request: ${sanitizeError(err)}`);
      return null;
    });
    if (!live) {
      // Not silence, as this once was: a row that is skipped every pass is
      // the shape of the bug this logging exists to make visible.
      log.debug(`join request for ${printable(record.pluginKey)} is held elsewhere — leaving it`);
      return;
    }

    const heartbeat = setInterval(() => {
      void this.store.heartbeat(live.id).catch((err: unknown) => {
        // A missed beat is survivable — the window is three of them — and the
        // work is still running, so there is nothing to do but note it.
        log.warn(`could not refresh a join-request claim: ${sanitizeError(err)}`);
      });
    }, CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.();

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
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** The work itself. The caller has already claimed `record`. */
  private async attempt(record: JoinRequestRecord): Promise<void> {
    const { workflow, workspaceService, kbDirName } = this.deps;
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

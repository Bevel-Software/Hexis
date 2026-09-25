import {
  joinBranchFor,
  type AuthUser,
  type ChangeRequestState,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { spliceGrant } from '../access-model/access-splice.js';
import { sanitizeError } from '../workflow/sanitize-error.js';
import { logger } from '../../shared/logging.js';
import { printable } from '../../shared/printable.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type {
  ClaimedJoinRequest,
  JoinRequestRecord,
  JoinRequestStore,
} from './join-request-records.store.js';

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

/**
 * What a beat found out about the claim — including that it found out
 * nothing.
 *
 * `held` and `lost` are the database's answers. `unknown` is the absence of
 * one: the UPDATE threw, so ownership was not established either way. It is a
 * third case rather than a shade of one of the others because the periodic
 * beat and the pre-side-effect guard must treat it oppositely — tolerated by
 * the one, refused by the other — and a boolean would have to pick.
 */
type ClaimState = 'held' | 'lost' | 'unknown';

/**
 * The row is not demonstrably this process's to finish, mid-work.
 *
 * Three ways that happens, and none is the request's fault. The claim
 * LAPSED — this process stalled past {@link CLAIM_STALE_AFTER_MS}, so another
 * took the row over and is doing the work now. Or the row was DELETED, which
 * is what account erasure does to it: the person who asked no longer exists,
 * so neither does the ask. Or ownership simply could not be ESTABLISHED,
 * because the beat that would have settled it threw.
 *
 * The third is the reason this is thrown on `unknown` and not only on a
 * confirmed loss. In front of an irreversible step, "I do not know whether I
 * still own this" has to be read the same way as "I do not" — a database that
 * cannot answer is exactly a database a replacement may have claimed the row
 * through. Failing open there buys nothing and risks a second change request;
 * failing closed costs one retry.
 *
 * In every case the only correct thing left is to stop, and in particular to
 * stop BEFORE mutating the shared workspace or opening a change request.
 * Carrying on would open a second change request alongside the replacement's
 * in the first case, and one for an erased account in the second — a change
 * request in a deleted person's name, which the row that would have recorded
 * it no longer exists to undo.
 *
 * Nothing is written and nothing is said to the requester: for a lapsed claim
 * the holder will say it, for an erased account there is nobody to tell, and
 * for an unreachable database there is nothing to write with. The row stays
 * `pending`, this process stops beating, the claim goes stale, and the next
 * sweep does the whole thing again — so the request is delayed, never lost.
 */
class ClaimLostError extends Error {
  constructor(state: Exclude<ClaimState, 'held'>) {
    super(
      state === 'lost'
        ? "the recorded request is no longer this process's to finish"
        : "the recorded request could not be confirmed as this process's to finish",
    );
    this.name = 'ClaimLostError';
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
  /** The checkout folder, and which branch the request is cut from and aimed at. */
  kb: Pick<KbContext, 'kbDirName' | 'defaultBranch' | 'defaultWorkspaceId'>;
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
 * AND THE CLAIM IS FENCED, because a heartbeat still cannot make missing the
 * window impossible — a long GC pause, a frozen host, a partition that
 * outlives three beats. A worker that comes back from one believes it still
 * holds a row another worker has since taken, and if the writes that decide
 * the row were addressed by id alone it would settle its replacement's
 * attempt: the replacement's fresh run stamped `opened` by the straggler's
 * stale number, or a run that is going fine stamped `failed` under it. So a
 * claim mints a token, and every write that holds or decides the row names
 * the token it believes it holds. A superseded worker writes nothing.
 *
 * The same mechanism is what makes the row's DELETION visible. Account
 * erasure removes a requester's rows outright, in a transaction this has no
 * part in; a beat against a row that is gone matches nothing, exactly as a
 * beat against a stolen one does. Both read as "not ours any more".
 *
 * So {@link attempt} beats the claim in front of each step that touches the
 * world — before the branch, after the clone and immediately before the file
 * write and push, and again immediately before the change request — rather
 * than once at the end. The clone between the first two is the long step, and
 * a check taken before it says nothing about who owns the row by the time it
 * returns. Anything short of a confirmed `held` stops the work, including a
 * beat that could not reach the database at all: in front of something
 * irreversible, not knowing is treated as not owning.
 *
 * None of that makes a gate and the step behind it atomic, and it is not
 * meant to. It narrows the exposure from the whole of a clone to a single
 * statement, and what carries the rest is that every step here is idempotent
 * and the deciding writes are fenced — so even two workers racing through the
 * git leave exactly one change request. A lease that could not expire across
 * these steps would close the window instead, and is the one option not open:
 * that is precisely what the heartbeat replaced, and it left the request of
 * any process that died owed forever.
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
  /**
   * Set by `stopSweeping`: the process is shutting down. A start that arrives
   * after it — a request handler still finishing while the pool is being
   * drained — runs nothing; the row stays `pending` and the next boot's sweep
   * does the work, exactly as for a row written just before a crash.
   */
  private stopping = false;

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

  /**
   * An `opened` record whose change request is no longer open is an ask that
   * was ANSWERED — declined by a manager, withdrawn, or settled and the
   * access since taken back — and the click that finds it is a new ask. Put
   * the row back to `pending` so the caller can carry it; hand back every
   * other record unchanged.
   *
   * The request's state is read from its own row, not from a listing: every
   * listing is open-only and cached, so a closed request is simply absent
   * from it, and absence proves nothing. The row says `closed`. A number with
   * no row at all is over too — nothing is standing under it.
   */
  async reviveIfAnswered(record: JoinRequestRecord): Promise<JoinRequestRecord> {
    if (record.status !== 'opened' || record.changeRequestNumber === null) return record;
    const states = await this.store.changeRequestStates([record.changeRequestNumber]);
    if (states.get(record.changeRequestNumber) === 'open') return record;
    return (await this.store.reopen(record.id, record.changeRequestNumber)) ?? record;
  }

  /** The state of each named change request, by its row — see the store. */
  async changeRequestStates(numbers: readonly number[]): Promise<Map<number, ChangeRequestState>> {
    return this.store.changeRequestStates(numbers);
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
    if (record.status === 'opened' || this.stopping) return Promise.resolve();
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
      log.warn(`could not look at the join requests still owed: ${loggable(sanitizeError(err))}`);
    });
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        log.warn(`could not look at the join requests still owed: ${loggable(sanitizeError(err))}`);
      });
    }, intervalMs);
    // Never a reason for the process to stay alive: every row is durable, and
    // whatever this tick would have done the next boot's sweep does.
    this.sweepTimer.unref?.();
  }

  /**
   * Stop the periodic sweep, and refuse to start any further job. Part of
   * shutting down cleanly: what is in flight is awaited by `drain`; nothing
   * new begins against a pool that is about to end.
   */
  stopSweeping(): void {
    this.stopping = true;
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
      log.warn(`could not claim a join request: ${loggable(sanitizeError(err))}`);
      return null;
    });
    if (!live) {
      // Not silence, as this once was: a row that is skipped every pass is
      // the shape of the bug this logging exists to make visible.
      log.debug(`join request for ${printable(record.pluginKey)} is held elsewhere — leaving it`);
      return;
    }

    // One beat, and the answer to "is this row still mine". Both questions
    // are the same statement, so asking the second costs nothing beyond the
    // first — which is why the guard before each side effect can afford to
    // ask it rather than trust a flag last refreshed up to thirty seconds ago.
    //
    // THREE answers, not two, and the third is the point. A beat that THREW
    // has not said the claim is held and has not said it is lost: it has said
    // nothing at all. Collapsing that into either boolean is a bug in one
    // direction or the other, and the two callers below want opposite
    // defaults — so the ambiguity is kept in the type and each decides.
    let held = true;
    const beat = async (): Promise<ClaimState> => {
      if (!held) return 'lost';
      try {
        const still = await this.store.heartbeat(live.id, live.claimToken);
        if (!still) held = false;
        return still ? 'held' : 'lost';
      } catch (err: unknown) {
        log.warn(`could not refresh a join-request claim: ${loggable(sanitizeError(err))}`);
        return 'unknown';
      }
    };

    // The periodic beat TOLERATES the unknown. Its only job is to push the
    // claim forward, it takes no action on the answer, and the window is
    // three beats wide precisely so that a database blip costs one of them
    // rather than the work. Giving up here would abandon a clone that is
    // going perfectly well because one UPDATE timed out.
    const heartbeat = setInterval(() => void beat(), CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      // The GUARD refuses it, for the exact opposite reason. It stands in
      // front of a side effect that cannot be taken back, and "I could not
      // find out whether I still own this row" is not a licence to push a
      // branch or open a change request — a replacement may well have claimed
      // it while the database was unreachable. So anything short of a
      // confirmed `held` stops the work. Stopping is cheap and recoverable:
      // the row stays `pending`, this process stops beating, the claim goes
      // stale, and the next sweep picks it up and does the whole thing again.
      await this.attempt(record, live, async () => {
        const state = await beat();
        if (state !== 'held') throw new ClaimLostError(state);
      });
    } catch (err) {
      const reason = sanitizeError(err);
      // `pluginKey` is a persisted folder path, so it is escaped before it
      // reaches a log line: a folder carrying control characters could
      // otherwise write newlines of its own into the log.
      const key = printable(record.pluginKey);
      if (err instanceof ClaimLostError) {
        // Nothing is written, deliberately — see ClaimLostError. Logged all
        // the same, because a process that keeps losing claims it holds is
        // either stalling for minutes at a time or racing an erasure, and
        // both are worth being able to see.
        log.warn(`join request for ${key} stopped: ${loggable(reason)}`);
        return;
      }
      if (err instanceof JoinRequestNotReadyError) {
        // Nothing is wrong with the request, so nothing is said to the person
        // who made it. The claim goes back so the next sweep — or their next
        // click — can pick the row up immediately rather than waiting out a
        // claim held by a process that never really started.
        log.warn(`join request for ${key} postponed: ${loggable(reason)}`);
        await this.store.release(record.id, live.claimToken).catch((releaseErr: unknown) => {
          log.warn(`could not release that claim: ${loggable(sanitizeError(releaseErr))}`);
        });
        return;
      }
      log.error(`join request for ${key} failed: ${loggable(reason)}`);
      await this.store
        // Named with the token, so this lands only if the row is still this
        // process's. A worker that overran the window and had its row taken
        // writes nothing here rather than stamping its failure on the attempt
        // that replaced it — which would show the requester a failure for
        // work that is, at that moment, succeeding.
        .markFailed(record.id, live.claimToken, reason)
        // Nothing left to do if even that write fails: the row stays
        // `pending` and the next boot's sweep tries the whole thing again.
        .catch((writeErr: unknown) => {
          log.error(`could not record that failure: ${loggable(sanitizeError(writeErr))}`);
        });
    } finally {
      held = false;
      clearInterval(heartbeat);
    }
  }

  /**
   * The work itself. The caller has already claimed `record` and passes the
   * claim it holds, plus `stillOurs` — which beats the claim and throws
   * {@link ClaimLostError} if the row has moved on. That is called before each
   * step that touches the world, so a claim lost mid-clone costs a clone
   * rather than a duplicate change request.
   */
  private async attempt(
    record: JoinRequestRecord,
    claim: ClaimedJoinRequest,
    stillOurs: () => Promise<void>,
  ): Promise<void> {
    const { workflow, workspaceService, kb } = this.deps;
    const { kbDirName } = kb;
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
      await this.store.markOpened(record.id, claim.claimToken, open.number);
      return;
    }

    // Before the git. The listing above is a network round-trip, and the
    // target and requester lookups before it may each have been one; a claim
    // that lapsed across them belongs to somebody else by now, and a row that
    // was erased across them is owed to nobody.
    await stillOurs();

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
      // AFTER THE CLONE, and immediately before the first thing that changes
      // the shared workspace. `getOrCreateForBranch` above is the long step —
      // a first-ever request clones the whole plugins repository, which is
      // minutes — and a gate before it says nothing about who owns the row by
      // the time it returns. Two processes writing this file and pushing the
      // same branch into one shared workspace is the corruption the claim
      // exists to prevent, so the check belongs here as well as at the end.
      //
      // It NARROWS the window rather than closing it: nothing makes the check
      // and the write one atomic act, so a claim could still lapse in the
      // instant between them. What makes that harmless is that everything in
      // this block is idempotent — the same grant, spliced onto the same
      // branch, is the same commit — and the durable outcome is fenced
      // separately, so two racing workers still leave exactly one change
      // request. The alternative cubic offered, a lease that cannot expire
      // across these steps, is the one thing not available here: a claim that
      // outlives a crashed process is precisely the bug the heartbeat
      // replaced, and it left recorded requests owed forever.
      await stillOurs();
      await workspaceService.writeFile(ws.id, accessPath, spliced.text);
      await workflow.commitChanges(ws.id, user, `Request access to ${target.displayName}`);
    }
    // The last gate, and the one that matters most: everything above is
    // idempotent and reusable — a branch, a commit on it — but a change
    // request is a thing a manager sees, and a second one for the same
    // request is exactly what this ticket promises cannot happen. The clone
    // and the push just before can take minutes on a first-ever request, more
    // than enough for a stalled process to have lost its claim, and for an
    // administrator to have erased the account in the meantime.
    await stillOurs();
    // And the account itself, once more, as late as it can be asked: an
    // erasure deletes this row in the same transaction as the account, but
    // a claim confirmed a moment before that commit is still confirmed, and
    // the request would open in an erased person's name. The erasure runs
    // its anonymization once more after committing, for a request that
    // landed in that gap; this read keeps the gap to the open itself.
    // By IDENTITY, not by address: an account erased and made again with the
    // same email is a different person's row, and the request must not open
    // in the old one's name either.
    const still = await this.deps.requester(record.requesterEmail);
    if (!still || still.id !== user.id) {
      throw new Error('the account that asked no longer exists');
    }
    const detail = await workflow.openChangeRequest(ws.id, user, {
      sourceBranch: branch,
      targetBranch: kb.defaultBranch,
      // People read these: the display name, not the identifier.
      title: `Join request: ${target.displayName}`,
      description:
        `${user.name} asked to join ${target.displayName}. A manager of the plugin accepts by ` +
        `granting the access this branch proposes; the request closes itself once ` +
        `every proposal has landed.`,
    });
    await this.store.markOpened(record.id, claim.claimToken, detail.number);
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
    const wsId = this.deps.kb.defaultWorkspaceId();
    try {
      await this.deps.workflow.createBranch(wsId, branch, this.deps.kb.defaultBranch);
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

/**
 * An error as a LOG line may carry it.
 *
 * `sanitizeError` strips credentials — which is what makes the string safe to
 * show a requester — but it says nothing about control characters, and the
 * text it returns is very often a git remote's: a message from the other end
 * of the network, or from whatever a misconfigured host chose to print. ANSI
 * and C1 sequences in there steer an operator's terminal and can forge whole
 * log lines. So a reason is escaped on its way to the log, and only there:
 * the copy persisted on the row is the requester's sentence, rendered as
 * text by React, and escaping that would put \\u001b litter in front of them.
 */
function loggable(reason: string): string {
  return printable(reason);
}

/** Node's "there is no such file" errors, and only those. */
function isFileAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

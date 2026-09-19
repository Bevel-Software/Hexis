import {
  DEFAULT_BRANCH,
  joinBranchFor,
  type AuthUser,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { spliceGrant } from '../access-model/access-splice.js';
import { sanitizeError } from '../workflow/sanitize-error.js';
import { logger } from '../../shared/logging.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { pluginsWorkspaceId } from './plugins.service.js';
import type { JoinRequestRecord, JoinRequestStore } from './join-request-records.store.js';

const log = logger('plugins');

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
    'createBranch' | 'commitChanges' | 'openChangeRequest' | 'listChangeRequestsAuthoredBy'
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
 * ONE PROCESS SWEEPS, because the deployment runs one. The sweep is not under
 * the commit-worker lease — it is sequenced after the knowledge-base startup
 * phase instead, in `createCoreServer`, because it needs the default-branch
 * clone that phase maintains and the plugin catalog read from it, and a sweep
 * that ran first would mark every row failed for a knowledge base that was
 * merely not ready yet. So on a redeploy two processes can sweep the same
 * rows for the seconds the changeover takes; the single-flight map is
 * per-process and does not stop that. What keeps them to one change request
 * is the freshness check and the adoption check below, plus the change
 * requests' own open-pair uniqueness — not this class.
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
      log.error(`join request for ${record.pluginKey} failed: ${reason}`);
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
    // The row as it stands NOW, not as the caller read it. A second click
    // carries a snapshot taken before the first click's job finished, and
    // single-flight cannot catch that one — the first flight is already gone
    // from the map. Re-running the work from a stale `pending` is exactly how
    // two clicks would become two change requests.
    const live = await this.store.byId(record.id);
    if (!live || live.status === 'opened') return;

    const target = await this.deps.target(record.pluginKey);
    if (!target) throw new Error('the plugin is no longer available');
    const user = await this.deps.requester(record.requesterEmail);
    if (!user) throw new Error('the account that asked no longer exists');

    const branch = joinBranchFor(record.requesterEmail, record.pluginKey);
    // Adopt rather than duplicate. This is the check the endpoint used to do
    // inline, moved here because it costs a change-request listing and the
    // answer must not wait for one.
    const mine = await workflow.listChangeRequestsAuthoredBy(record.requesterEmail);
    const open = mine.find((cr) => cr.state === 'open' && cr.branch === branch);
    if (open) {
      await this.store.markOpened(record.id, open.number);
      return;
    }

    // A leftover branch from a rejected/withdrawn request is reused — the
    // grant commit is already on it and the splice below no-ops.
    try {
      await workflow.createBranch(pluginsWorkspaceId(), branch, DEFAULT_BRANCH);
    } catch {
      // exists (or raced) — proceed against it
    }
    const ws = await workspaceService.getOrCreateForBranch(branch);
    const accessPath = `${kbDirName}/${target.folder}/access.md`;
    const current = await workspaceService.readFile(ws.id, accessPath).catch(() => '');
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
}

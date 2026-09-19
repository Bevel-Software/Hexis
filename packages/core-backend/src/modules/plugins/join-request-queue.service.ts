import {
  DEFAULT_BRANCH,
  joinBranchFor,
  type AuthUser,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { spliceGrant } from '../access-model/access-splice.js';
import { logger } from '../../shared/logging.js';
import { pluginsWorkspaceId } from './plugins.service.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';

const log = logger('plugins');

/**
 * A recorded join request, as everything outside this module sees it.
 *
 * `pluginKey` is the plugin's primary FOLDER path below the plugins root —
 * the same key `joinBranchFor` cuts the branch from, and the same key the
 * plugin index looks a record up by.
 */
export interface JoinRequestRecord {
  id: string;
  pluginKey: string;
  status: 'pending' | 'opened' | 'failed';
  /** The change request, once the background work opened one. */
  changeRequestNumber: number | null;
  /** Why the background work gave up, when `status` is `failed`. */
  failureReason: string | null;
}

/** What a click hands the queue — everything the git work will need later. */
export interface JoinRequestInput {
  user: AuthUser;
  /** The plugin's primary folder path below the plugins root. */
  pluginKey: string;
  /** That folder's full repo-relative path (`Plugins/Finance`). */
  pluginFolder: string;
  /** What people call the plugin — the change request's title says it. */
  pluginDisplayName: string;
}

/**
 * The persistence the queue needs, named as a port so the queue's own rules
 * (single flight, retry-the-same-row, the sweep) can be tested without a
 * database. `PluginJoinRequestStore` is the drizzle implementation.
 */
export interface JoinRequestStore {
  /**
   * Record `input` as `pending`, or return the row that already exists for
   * this (requester, plugin) untouched.
   *
   * `inserted` says which happened, and it is the ONLY duplicate gate: it has
   * to come from the database's own uniqueness verdict (an
   * `ON CONFLICT DO NOTHING` insert), never a read-then-write, or two tabs
   * clicking together both read "nothing there" and both insert.
   */
  insertIfAbsent(input: StoredRequestSeed): Promise<{ row: StoredRequest; inserted: boolean }>;
  /** Reset a `failed` row to `pending` for a retry. No-op unless it is failed. */
  reopenIfFailed(id: string): Promise<StoredRequest | null>;
  byId(id: string): Promise<StoredRequest | null>;
  /** Every row this person has, newest state, keyed by `pluginKey`. */
  byRequester(email: string): Promise<StoredRequest[]>;
  /** Every row still waiting for its git work, in the order recorded. */
  allPending(): Promise<StoredRequest[]>;
  markOpened(id: string, changeRequestNumber: number): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
  /** Forget a row whose change request is gone — see `PluginJoinRequestsQueue`. */
  remove(id: string): Promise<void>;
}

export interface StoredRequestSeed {
  requesterEmail: string;
  requesterName: string;
  requesterUserId: string;
  pluginKey: string;
  pluginFolder: string;
  pluginDisplayName: string;
}

export interface StoredRequest extends StoredRequestSeed {
  id: string;
  status: 'pending' | 'opened' | 'failed';
  changeRequestNumber: number | null;
  failureReason: string | null;
  attempts: number;
}

/** The sanitised, human-readable form of whatever the git work threw. */
export function reasonOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // One line, bounded: this reaches a business user inside a sentence on the
  // plugin's page, and a git error can be a paragraph with a stack in it.
  const line = raw.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  const trimmed = line.replace(/[.\s]+$/, '');
  if (!trimmed) return 'the platform did not say why';
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed;
}

/**
 * Record the click, answer, then do the git work.
 *
 * `POST /plugins/:name/join-request` used to do all of it before answering:
 * create the branch, CLONE the plugins repository for that branch the first
 * time a person ever asks, splice the grant into the access file, commit,
 * push, and open the change request on the git host. The clone alone takes
 * many seconds on a real repository, and the button had nothing to say in the
 * meantime. The route now calls {@link request}, which writes one row and
 * returns; everything else runs here, afterwards.
 *
 * What the managers see is unchanged — the same branch, the same commit, the
 * same change request with the same title and description. This moves WHEN
 * that happens, not what it is.
 *
 * Three rules hold the flow together:
 *
 *  - **One record per (requester, plugin)**, decided by the store's unique
 *    index, so two tabs or two clicks record one request and open one change
 *    request. Only the caller whose INSERT won starts the background work.
 *  - **Single flight in this process**: a record already being worked on is
 *    never started twice. {@link whenIdle} awaits whatever is in flight, which
 *    is what a test (and a graceful shutdown) needs.
 *  - **`failed` is not terminal**: the next click resets the SAME row to
 *    `pending` and runs again, so a retry never opens a second request.
 *
 * ONE INSTANCE. The deployment runs a single platform process, and
 * {@link sweep} assumes it: a second instance booting would re-run the same
 * `pending` rows this one is already working. The work is idempotent enough to
 * survive that (the branch is reused, the splice no-ops, and the existing open
 * change request is found rather than duplicated) but it would do a redundant
 * clone. If this ever runs multi-instance, claim rows the way
 * `PendingCommitsWorker` does, under the commit-worker lease.
 */
export class PluginJoinRequestsQueue {
  /** Records being worked on right now, by id — the single-flight gate. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: JoinRequestStore,
    private readonly workspaceService: Pick<
      WorkspaceService,
      'getOrCreateForBranch' | 'readFile' | 'writeFile'
    >,
    private readonly workflow: Pick<
      IWorkflowService,
      'createBranch' | 'commitChanges' | 'openChangeRequest' | 'listChangeRequestsAuthoredBy'
    >,
    private readonly kbDirName: string,
  ) {}

  /**
   * Record the request and start (or resume) its background work. Returns as
   * soon as the row is written — the git work is deliberately NOT awaited.
   *
   * Idempotent per (requester, plugin): a second call while the first is
   * pending or opened returns that same record and starts nothing new; a call
   * against a failed record retries it.
   */
  async request(input: JoinRequestInput): Promise<JoinRequestRecord> {
    const seed: StoredRequestSeed = {
      requesterEmail: input.user.email.trim().toLowerCase(),
      requesterName: input.user.name,
      requesterUserId: input.user.id,
      pluginKey: input.pluginKey,
      pluginFolder: input.pluginFolder,
      pluginDisplayName: input.pluginDisplayName,
    };
    const { row, inserted } = await this.store.insertIfAbsent(seed);
    if (inserted) {
      this.start(row);
      return toRecord(row);
    }
    if (row.status === 'failed') {
      // Retry FROM THE RECORDED REQUEST: same row, same branch, so the git
      // host never sees a second request for the same person and plugin.
      const reopened = await this.store.reopenIfFailed(row.id);
      if (reopened) {
        this.start(reopened);
        return toRecord(reopened);
      }
      // Lost a race with another retry — whatever it left is the answer.
      return toRecord((await this.store.byId(row.id)) ?? row);
    }
    // Pending or opened: already recorded, already being finished. A pending
    // row with nothing in flight belongs to a process that died; the boot
    // sweep owns it, not this request — resuming it here would let a click
    // race the sweep for the same clone.
    return toRecord(row);
  }

  /** Everything `email` has asked for, keyed by plugin key. */
  async byRequester(email: string): Promise<Map<string, JoinRequestRecord>> {
    const rows = await this.store.byRequester(email.trim().toLowerCase());
    return new Map(rows.map((r) => [r.pluginKey, toRecord(r)]));
  }

  /**
   * Forget a record whose change request is no longer open — the plugin index
   * calls this when it sees an `opened` record with no open change request
   * behind it.
   *
   * A settled request (a manager granted what it asked for, or rejected it)
   * has to leave the button offerable again, exactly as it did when
   * `hasRequested` was read from the open change request alone. Retiring the
   * row lazily, on the listing that noticed, is the same shape
   * `JoinRequestsService` already uses to retire the change request itself:
   * nothing has to remember to.
   */
  async retire(id: string): Promise<void> {
    await this.store.remove(id);
  }

  /**
   * Re-run every `pending` record. Called ONCE at boot: a request recorded
   * before a restart was answered with "sent", so it has to end up opened or
   * failed rather than sitting in the table forever.
   *
   * Sequential on purpose — each record may clone the plugins repository, and
   * a restart with a backlog should not start ten clones at once.
   */
  async sweep(): Promise<void> {
    const rows = await this.store.allPending();
    if (rows.length === 0) return;
    log.info(`resuming ${rows.length} recorded plugin join request(s) after boot`);
    for (const row of rows) {
      this.start(row);
      await this.inFlight.get(row.id);
    }
  }

  /** Resolve once no background work is in flight. For tests and shutdown. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  /** Begin the background work for `row` unless it is already in flight. */
  private start(row: StoredRequest): void {
    if (this.inFlight.has(row.id)) return;
    const run = this.run(row)
      .catch((err) => {
        // `run` records its own failures; reaching here means the recording
        // itself failed, and the row stays pending for the next boot sweep.
        log.error(`join request ${row.id} could not be settled:`, { err });
      })
      .finally(() => {
        this.inFlight.delete(row.id);
      });
    this.inFlight.set(row.id, run);
  }

  /**
   * The git work, unchanged from what the route used to do inline: reuse or
   * cut the deterministic join branch, splice the read grant into the
   * plugin's access file, commit, and open the change request.
   */
  private async run(row: StoredRequest): Promise<void> {
    const email = row.requesterEmail;
    const branch = joinBranchFor(email, row.pluginKey);
    const user: AuthUser = {
      id: row.requesterUserId,
      email: row.requesterEmail,
      name: row.requesterName,
    };
    try {
      // Belt and braces, and the restart case's real answer: a change request
      // this row already opened (or one a previous release opened before this
      // table existed) is adopted, never duplicated.
      const existing = openJoinCrFor(
        await this.workflow.listChangeRequestsAuthoredBy(email),
        email,
        row.pluginKey,
      );
      if (existing) {
        await this.store.markOpened(row.id, existing.number);
        return;
      }

      // A leftover branch from a rejected/withdrawn request is reused — the
      // grant commit is already on it and the splice below no-ops.
      try {
        await this.workflow.createBranch(pluginsWorkspaceId(), branch, DEFAULT_BRANCH);
      } catch {
        // exists (or raced) — proceed against it
      }
      const ws = await this.workspaceService.getOrCreateForBranch(branch);
      const accessPath = `${this.kbDirName}/${row.pluginFolder}/access.md`;
      const current = await this.workspaceService.readFile(ws.id, accessPath).catch(() => '');
      const spliced = spliceGrant(
        current,
        'read',
        { kind: 'user', email: user.email, displayName: user.name },
        { target: 'folder' },
      );
      if (spliced.changed) {
        await this.workspaceService.writeFile(ws.id, accessPath, spliced.text);
        await this.workflow.commitChanges(ws.id, user, `Request access to ${row.pluginDisplayName}`);
      }
      const detail = await this.workflow.openChangeRequest(ws.id, user, {
        sourceBranch: branch,
        targetBranch: DEFAULT_BRANCH,
        // People read these: the display name, not the identifier.
        title: `Join request: ${row.pluginDisplayName}`,
        description:
          `${user.name} asked to join ${row.pluginDisplayName}. A manager of the plugin accepts by ` +
          `granting the access this branch proposes; the request closes itself once ` +
          `every proposal has landed.`,
      });
      await this.store.markOpened(row.id, detail.number);
    } catch (err) {
      log.error(`failed to open a join request for ${row.pluginKey}:`, { err });
      await this.store.markFailed(row.id, reasonOf(err));
    }
  }
}

/** The caller's open join change request for `pluginKey`, or null. */
export function openJoinCrFor(
  mine: ChangeRequest[],
  email: string,
  pluginKey: string,
): ChangeRequest | null {
  return mine.find((cr) => cr.state === 'open' && cr.branch === joinBranchFor(email, pluginKey)) ?? null;
}

function toRecord(row: StoredRequest): JoinRequestRecord {
  return {
    id: row.id,
    pluginKey: row.pluginKey,
    status: row.status,
    changeRequestNumber: row.changeRequestNumber,
    failureReason: row.failureReason,
  };
}

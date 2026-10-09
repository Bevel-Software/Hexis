/**
 * Per-(workspace, branch, path) edit lock store. The spec calls for
 * file-scoped locks acquired on first edit and released either explicitly
 * (with an autosave commit) or implicitly by TTL expiry — preventing a
 * disconnected client from holding a file hostage.
 *
 * Lock state lives in Postgres because workspaces share state across
 * backend instances eventually. The hot read path (does someone hold this
 * lock?) is one indexed lookup; the hot write path (heartbeat) is a single
 * row update. We don't bother caching in process memory — the lock table
 * is the source of truth and any cache would lose its purpose the moment
 * a different replica takes over.
 *
 * Path identity: every method here canonicalises the path it was handed
 * before it touches a row, so `./x//a.md` and `x/a.md` are ONE lock no
 * matter which caller spelled which. It happens HERE rather than in the
 * routes because the lock row is the coordination point: the routes are only
 * today's callers, and a caller that reaches this service directly (the
 * agent's lock-aware filesystem, a future route family) has to land on the
 * same identity or it is not coordinating with anyone. Canonicalisation also
 * REFUSES a path that escapes the workspace or that only looks relative, with
 * the statuses the file verbs answer for the same input, so a lock row can
 * never be keyed on a path no file verb would accept. See
 * `canonicalFileIdentity`.
 *
 * Workspace identity works the same way. The lock routes pass the `:id`
 * path param, which Express URL-decodes, so a slashed branch's workspace
 * arrives as `alice/feature`; the deletion gate and the git status probe ask
 * with the encoded `alice%2Ffeature`. Every method keys rows on
 * `canonicalWorkspaceId`, so both spellings are one workspace and a held file
 * is seen whichever spelling asks.
 *
 * Unlike raw path spellings (below), rows written under the decoded workspace id before this
 * landed are still honoured until they go: every read, heartbeat and release
 * also matches that spelling, and an acquire is refused while a live row
 * under it holds the same file. Otherwise a lock held across the upgrade
 * would be invisible for up to its TTL — to the deletion gate and to a second
 * editor alike. Nothing new is ever written under it, so once the last such
 * row has expired or been released the extra spelling matches nothing.
 *
 * This covers rows LEFT by the previous version, not rows it is still
 * writing: a previous-version process never looks at a canonical row, so no
 * check here could make the two contend while both run. They never do — one
 * server process owns the workspaces directory (see `branchLifecycle` in the
 * workflow service; this service's deletion gate is in-process for the same
 * reason), and an upgrade stops the old process before the new one starts.
 *
 * There is no transition handling for rows written under a raw spelling
 * before this landed: such a row is now unreachable by name and expires on
 * its own TTL. For one deploy an in-flight edit's lock can linger up to the
 * TTL below; nothing migrates and nothing dual-matches, because a dual match
 * would be a second identity and the whole point is that there is one.
 *
 * Stale-lock semantics: `get`, `acquire`, and `heartbeat` all treat a row
 * with `expires_at <= now()` as if the lock didn't exist. We purge it
 * lazily on next access rather than running a sweeper — the row count is
 * bounded by concurrent editors, not history, so lazy GC is fine.
 */

import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { fileLocks } from '../database/schema.js';
import type { AcquireLockResult, AuthUser, FileLock } from '@bevel-software/platform-shared';
import { WorkflowValidationError } from '../../shared/domain-errors.js';
import { canonicalFileIdentity } from '../../shared/canonical-file-identity.js';
import { branchForWorkspaceId, canonicalWorkspaceId } from '../../shared/workspace-id.js';

/**
 * Lock lifetime without a heartbeat. The client is expected to heartbeat
 * every ~half this interval so a single missed ping doesn't release the
 * lock out from under them. Bumping the TTL trades off "how long does a
 * crashed client hold a file" against "how forgiving are we of network
 * blips" — 60s is a balance.
 */
const LOCK_TTL_MS = 60_000;

/**
 * The workspace ids a lock row of canonical workspace `workspaceId` can sit
 * under: the canonical one every write uses, then — for a slashed branch —
 * the decoded one rows were written under before workspace ids were
 * canonicalised. See the module comment.
 */
function workspaceSpellings(workspaceId: string): string[] {
  const legacy = branchForWorkspaceId(workspaceId);
  return legacy === workspaceId ? [workspaceId] : [workspaceId, legacy];
}

function rowToFileLock(row: typeof fileLocks.$inferSelect): FileLock {
  return {
    branch: row.branch,
    path: row.path,
    holderUserId: row.holderUserId,
    holderName: row.holderName,
    // The column carries a NOT NULL 'edit' default, so rows predating the
    // mode column read back as plain edit locks — the strictest reading.
    mode: row.mode === 'coordination' ? 'coordination' : 'edit',
    acquiredAt: row.acquiredAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export class FileLockService {
  constructor(private readonly db: Database) {}

  /**
   * Branches being deleted right now, with how many deletions hold each. No
   * lock is granted on them: a deletion checks that no save is landing and
   * then removes the branch, and a save that took its lock in between would
   * be lost with the checkout. See `whileNoneAcquired`.
   */
  private readonly closing = new Map<string, number>();

  /**
   * Acquires on each branch that passed the `closing` check and have not
   * settled yet. `whileNoneAcquired` waits for them: one whose row is still
   * being written when a deletion starts would otherwise land after the
   * deletion's last check.
   */
  private readonly acquiring = new Map<string, Set<Promise<unknown>>>();

  /**
   * Run `fn` while no lock can be acquired on `branch`, once every acquire
   * already under way on it has settled. The deletion paths re-check for
   * saves landing inside it, so that check sees every lock granted before it,
   * and the deletion meets no save that started in between.
   */
  async whileNoneAcquired<T>(branch: string, fn: () => Promise<T>): Promise<T> {
    this.closing.set(branch, (this.closing.get(branch) ?? 0) + 1);
    try {
      await Promise.allSettled([...(this.acquiring.get(branch) ?? [])]);
      return await fn();
    } finally {
      const n = (this.closing.get(branch) ?? 1) - 1;
      if (n > 0) this.closing.set(branch, n);
      else this.closing.delete(branch);
    }
  }

  /**
   * Acquire a lock for `(workspaceId, branch, path)` on behalf of `user`.
   *
   * Three outcomes folded into the same return shape:
   *   - No existing row: insert + return `{ acquired: true, lock }`.
   *   - Existing row, expired: take it over (update) + `{ acquired: true }`.
   *   - Existing row, live — ANY user, the holder included: return
   *     `{ acquired: false }` with the current holder's lock state so the UI
   *     can render "Locked by X" without a follow-up call. Re-acquiring your
   *     own live lock is refused on purpose (see the comment in the body):
   *     refresh a held lock with `heartbeat()`, and ask "do I already hold
   *     it?" with `get()`.
   *
   * `opts.coordination` stamps the row's `mode` as `'coordination'` — a
   * pure-mutex hold that grants no write authority (see
   * `IWorkflowService.acquireLock`). The mode is persisted so the workflow
   * service's write paths can refuse to treat the hold as write possession
   * for the row's whole lifetime; a takeover of an expired row re-stamps the
   * mode, so a stale coordination row can't launder a later edit acquire
   * (or vice versa).
   */
  async acquire(
    rawWorkspaceId: string,
    branch: string,
    rawPath: string,
    user: AuthUser,
    opts?: { coordination?: boolean },
  ): Promise<AcquireLockResult> {
    const targetPath = canonicalFileIdentity(rawPath);
    const workspaceId = canonicalWorkspaceId(rawWorkspaceId);
    if (this.closing.has(branch)) {
      throw new WorkflowValidationError(`"${branch}" is being deleted, so "${targetPath}" cannot be held for editing.`, {
        kind: 'branch-being-deleted',
        branch,
        path: targetPath,
      });
    }
    const pending = this.acquireUnchecked(workspaceId, branch, targetPath, user, opts);
    const inFlight = this.acquiring.get(branch) ?? new Set<Promise<unknown>>();
    inFlight.add(pending);
    this.acquiring.set(branch, inFlight);
    try {
      return await pending;
    } finally {
      inFlight.delete(pending);
      if (inFlight.size === 0 && this.acquiring.get(branch) === inFlight) this.acquiring.delete(branch);
    }
  }

  /** `acquire` past the deletion gate. */
  private async acquireUnchecked(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
    opts?: { coordination?: boolean },
  ): Promise<AcquireLockResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    // Atomic acquire-or-takeover, in a single statement. Two callers
    // racing on the same `(workspace, branch, path)` would otherwise
    // both SELECT no row → both INSERT (one PK-fails) or both SELECT a
    // stale row → both UPDATE (one silently overwrites the other's
    // takeover). PostgreSQL's INSERT ... ON CONFLICT DO UPDATE WHERE
    // collapses both paths into one atomic statement:
    //
    //   - No existing row → INSERT succeeds, RETURNING our new row.
    //   - Existing row, WHERE matches (stale OR same user) → UPDATE
    //     fires, RETURNING the updated row.
    //   - Existing row, WHERE doesn't match (live + different user) →
    //     the conflict is silently absorbed (PG's documented behavior),
    //     RETURNING is empty. We then read the live holder for the
    //     "Locked by X" payload.
    //
    // **Only expired rows can be taken over.** The same-user clause used
    // to be here as an "idempotent refresh" shortcut, but it had a nasty
    // side effect: the AGENT and the HUMAN EDITOR share the same `user.id`
    // (agent edits attribute to the human), so the agent's
    // `LockingFilesystem.withLock` would silently steal a lock the human
    // had taken via the Edit button — overwriting their in-flight edits
    // and dropping their lock on agent-release. Removing same-user from
    // setWhere makes acquire strict: a non-expired lock is contended even
    // by yourself, so the agent's retry/skip path kicks in and the human
    // keeps editing. Real refresh-while-holding goes through
    // `heartbeat()` (which has its own same-user UPDATE), and the
    // editor's save flow detects "I already hold it" via `getLock` in
    // `workspace.routes.withLock` rather than re-acquiring.
    // A live row under the pre-canonical spelling holds this file as surely
    // as one under the canonical id; the upsert below cannot see it.
    const legacy = workspaceSpellings(workspaceId).slice(1);
    if (legacy.length > 0) {
      const [held] = await this.db
        .select()
        .from(fileLocks)
        .where(
          and(
            inArray(fileLocks.workspaceId, legacy),
            eq(fileLocks.branch, branch),
            eq(fileLocks.path, targetPath),
            gt(fileLocks.expiresAt, now),
          ),
        )
        .limit(1);
      if (held) return { acquired: false, lock: rowToFileLock(held) };
    }

    const mode = opts?.coordination ? 'coordination' : 'edit';
    const upsertResult = await this.db
      .insert(fileLocks)
      .values({
        workspaceId,
        branch,
        path: targetPath,
        holderUserId: user.id,
        holderName: user.name,
        mode,
        acquiredAt: now,
        lastHeartbeatAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [fileLocks.workspaceId, fileLocks.branch, fileLocks.path],
        set: {
          holderUserId: user.id,
          holderName: user.name,
          mode,
          acquiredAt: now,
          lastHeartbeatAt: now,
          expiresAt,
        },
        setWhere: lte(fileLocks.expiresAt, now),
      })
      .returning();

    if (upsertResult.length > 0) {
      return { acquired: true, lock: rowToFileLock(upsertResult[0]) };
    }

    // Live lock held by another user. Fetch it for the "Locked by X" UI
    // payload. We don't filter on `expiresAt > now` here because the
    // upsert above already proved an unreclaimable row exists; the only
    // way this read returns null is a tight race where the holder
    // released between the upsert and this select — rare enough to
    // surface as a retryable error rather than complicate the happy path.
    const [holder] = await this.db
      .select()
      .from(fileLocks)
      .where(
        and(
          eq(fileLocks.workspaceId, workspaceId),
          eq(fileLocks.branch, branch),
          eq(fileLocks.path, targetPath),
        ),
      )
      .limit(1);
    if (!holder) {
      throw new WorkflowValidationError(
        `Lock contention race on "${targetPath}" — please retry.`,
        { kind: 'lock-contention-race', branch, path: targetPath },
      );
    }
    return { acquired: false, lock: rowToFileLock(holder) };
  }

  /**
   * Extend the lock's TTL. Refuses if the lock is held by someone else or
   * doesn't exist — the client is then expected to re-call `acquire`,
   * which will either succeed (taking over a stale lock) or surface the
   * current holder.
   */
  async heartbeat(
    rawWorkspaceId: string,
    branch: string,
    rawPath: string,
    user: AuthUser,
  ): Promise<FileLock> {
    const targetPath = canonicalFileIdentity(rawPath);
    const workspaceId = canonicalWorkspaceId(rawWorkspaceId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
    // The expiry guard (`expiresAt > now`) matters because an expired
    // lock is conceptually released, even if its row hasn't been swept
    // and no other user has taken it yet. Without it, a client whose
    // tab was suspended past the TTL would silently extend a lock that
    // the rest of the system considers "free for the next acquire" —
    // any subsequent `acquire()` by another user could already have
    // taken it (the upsert's `lte(expiresAt, now)` predicate matches),
    // and the heartbeat would race with that takeover. Failing here
    // forces the client to re-acquire (which goes through the proper
    // takeover path) and surfaces the "your session went stale" state
    // honestly.
    const [updated] = await this.db
      .update(fileLocks)
      .set({ lastHeartbeatAt: now, expiresAt })
      .where(
        and(
          inArray(fileLocks.workspaceId, workspaceSpellings(workspaceId)),
          eq(fileLocks.branch, branch),
          eq(fileLocks.path, targetPath),
          eq(fileLocks.holderUserId, user.id),
          gt(fileLocks.expiresAt, now),
        ),
      )
      .returning();
    if (!updated) {
      throw new WorkflowValidationError(
        `Cannot heartbeat lock on "${targetPath}": not held by you (or no longer exists).`,
        { kind: 'lock-not-held', branch, path: targetPath },
      );
    }
    return rowToFileLock(updated);
  }

  /**
   * Idempotent release. Deletes the lock row when the caller holds it;
   * silently no-ops otherwise (the lock may have expired and been taken
   * over by someone else — that's not an error from the caller's POV).
   */
  async release(
    rawWorkspaceId: string,
    branch: string,
    rawPath: string,
    user: AuthUser,
  ): Promise<void> {
    const targetPath = canonicalFileIdentity(rawPath);
    const workspaceId = canonicalWorkspaceId(rawWorkspaceId);
    await this.db
      .delete(fileLocks)
      .where(
        and(
          inArray(fileLocks.workspaceId, workspaceSpellings(workspaceId)),
          eq(fileLocks.branch, branch),
          eq(fileLocks.path, targetPath),
          eq(fileLocks.holderUserId, user.id),
        ),
      );
  }

  /**
   * Read the current lock for `(workspace, branch, path)`. Returns null when
   * no one holds it, OR when the existing row is expired — expired locks
   * are purged here lazily.
   */
  async get(
    rawWorkspaceId: string,
    branch: string,
    rawPath: string,
  ): Promise<FileLock | null> {
    const targetPath = canonicalFileIdentity(rawPath);
    const workspaceId = canonicalWorkspaceId(rawWorkspaceId);
    const rows = await this.db
      .select()
      .from(fileLocks)
      .where(
        and(
          inArray(fileLocks.workspaceId, workspaceSpellings(workspaceId)),
          eq(fileLocks.branch, branch),
          eq(fileLocks.path, targetPath),
        ),
      );
    // At most one row per spelling; the canonical one first.
    rows.sort((x, y) => Number(x.workspaceId !== workspaceId) - Number(y.workspaceId !== workspaceId));
    let live: (typeof rows)[number] | null = null;
    for (const row of rows) {
      if (row.expiresAt.getTime() > Date.now()) {
        live ??= row;
        continue;
      }
      // Lazy GC — drop the stale row so the next `acquire` doesn't have
      // to bypass it. Bind the delete to this exact row's `expiresAt` so
      // a concurrent acquire that wrote a fresh row in the gap between
      // our SELECT and DELETE doesn't get clobbered. Primary key
      // `(workspaceId, branch, path)` alone isn't enough — a new acquire
      // for the same triple updates that row in place with a future
      // expiry, and a path-only delete here would silently nuke it.
      await this.db
        .delete(fileLocks)
        .where(
          and(
            eq(fileLocks.workspaceId, row.workspaceId),
            eq(fileLocks.branch, branch),
            eq(fileLocks.path, targetPath),
            eq(fileLocks.expiresAt, row.expiresAt),
          ),
        );
    }
    return live ? rowToFileLock(live) : null;
  }

  /**
   * Drop every lock held on `branch`, whoever holds it and whichever
   * workspace it sits in, and answer how many rows went.
   *
   * The one caller is a change request being closed because the
   * knowledge-base repository was REPLACED: the branch the lock names belongs
   * to a repository this deployment no longer has, so the holder can neither
   * publish their bytes nor release the lock themselves — and the row would
   * otherwise sit there refusing the path to everyone until its TTL ran out
   * on every heartbeat a still-connected client keeps sending.
   *
   * Expired rows go too: they are already nobody's lock, and leaving them for
   * the lazy sweep would only make this answer harder to read.
   *
   * Deliberately NOT a release in the ordinary sense — nothing is committed
   * and nothing is enqueued. The bytes belonged to a repository that is gone.
   *
   * What an ORDINARY release already enqueued is a different matter, and not
   * this method's to fix: a release queues the bytes and only then drops its
   * lock, so rows can be waiting for a branch whose locks this deletes. The
   * caller takes those out of the worker's reach in the same breath — see
   * `PendingCommitsService.markNeedsAttentionOnBranch`.
   */
  async releaseAllOnBranch(branch: string): Promise<number> {
    const gone = await this.db
      .delete(fileLocks)
      .where(eq(fileLocks.branch, branch))
      .returning({ path: fileLocks.path });
    return gone.length;
  }

  /**
   * Is ANY unexpired lock held anywhere in this workspace? Feeds the git
   * status sanity check: a held lock means a mutation is mid-flight — the
   * file may already be changed (or deleted) on disk while its commit is only
   * queued at RELEASE — so a dirty tree during that window is expected, not
   * the "missed lock-release commit" the loud warning is for. Expired rows
   * don't count (their holder is gone; they explain nothing).
   */
  async hasAnyActive(rawWorkspaceId: string): Promise<boolean> {
    const workspaceId = canonicalWorkspaceId(rawWorkspaceId);
    const rows = await this.db
      .select({ path: fileLocks.path })
      .from(fileLocks)
      .where(and(inArray(fileLocks.workspaceId, workspaceSpellings(workspaceId)), gt(fileLocks.expiresAt, new Date())))
      .limit(1);
    return rows.length > 0;
  }
}

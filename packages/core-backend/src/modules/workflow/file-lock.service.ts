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
 * Stale-lock semantics: `get`, `acquire`, and `heartbeat` all treat a row
 * with `expires_at <= now()` as if the lock didn't exist. We purge it
 * lazily on next access rather than running a sweeper — the row count is
 * bounded by concurrent editors, not history, so lazy GC is fine.
 */

import { and, eq, gt, lte } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { fileLocks } from '../database/schema.js';
import type { AcquireLockResult, AuthUser, FileLock } from '@bevel-software/shared';
import { WorkflowValidationError } from './workflow.errors.js';

/**
 * Lock lifetime without a heartbeat. The client is expected to heartbeat
 * every ~half this interval so a single missed ping doesn't release the
 * lock out from under them. Bumping the TTL trades off "how long does a
 * crashed client hold a file" against "how forgiving are we of network
 * blips" — 60s is a balance.
 */
const LOCK_TTL_MS = 60_000;

function rowToFileLock(row: typeof fileLocks.$inferSelect): FileLock {
  return {
    branch: row.branch,
    path: row.path,
    holderUserId: row.holderUserId,
    holderName: row.holderName,
    acquiredAt: row.acquiredAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export class FileLockService {
  constructor(private readonly db: Database) {}

  /**
   * Acquire a lock for `(workspaceId, branch, path)` on behalf of `user`.
   *
   * Three outcomes folded into the same return shape:
   *   - No existing row: insert + return `{ acquired: true, lock }`.
   *   - Existing row, expired: take it over (update) + `{ acquired: true }`.
   *   - Existing row, live, different user: return `{ acquired: false }`
   *     with the current holder's lock state so the UI can render
   *     "Locked by X" without a follow-up call.
   *   - Existing row, live, same user: refresh TTL + `{ acquired: true }`
   *     so re-acquiring your own lock is idempotent.
   */
  async acquire(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
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
    const upsertResult = await this.db
      .insert(fileLocks)
      .values({
        workspaceId,
        branch,
        path: targetPath,
        holderUserId: user.id,
        holderName: user.name,
        acquiredAt: now,
        lastHeartbeatAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [fileLocks.workspaceId, fileLocks.branch, fileLocks.path],
        set: {
          holderUserId: user.id,
          holderName: user.name,
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
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<FileLock> {
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
          eq(fileLocks.workspaceId, workspaceId),
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
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<void> {
    await this.db
      .delete(fileLocks)
      .where(
        and(
          eq(fileLocks.workspaceId, workspaceId),
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
    workspaceId: string,
    branch: string,
    targetPath: string,
  ): Promise<FileLock | null> {
    const rows = await this.db
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
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.expiresAt.getTime() <= Date.now()) {
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
            eq(fileLocks.workspaceId, workspaceId),
            eq(fileLocks.branch, branch),
            eq(fileLocks.path, targetPath),
            eq(fileLocks.expiresAt, row.expiresAt),
          ),
        );
      return null;
    }
    return rowToFileLock(row);
  }
}

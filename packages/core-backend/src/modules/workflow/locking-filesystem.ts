/**
 * A `LocalFilesystem` that wraps every mutating operation in a workflow
 * lock acquire → super-call → release-with-auto-commit-and-push cycle.
 * This is the agent's file edit surface — Mastra hands the agent the
 * workspace's filesystem tools (write_file / edit_file / etc.), and those
 * call directly into this class, so the agent's edits go through the same
 * lock + commit + push pipeline as the human editor's saves.
 *
 * Per the workflow spec (PLAN.md §2):
 *   - Each tool call is one acquire/release cycle. The agent never holds a
 *     lock while it's "thinking" between tool calls — a fast human editor
 *     can always grab a file the agent isn't actively writing.
 *   - On lock contention (someone else holds the lock) we retry 3× at
 *     2-second intervals (~6s ceiling) then surface a structured error
 *     so the agent can skip the file and continue with the rest of its
 *     turn rather than aborting the whole call.
 *   - Lock-release inside `WorkflowService.releaseLock` is the thing that
 *     actually commits + pushes the file — see that method for the
 *     `commitFile → release → push` sequence. We don't repeat the commit
 *     step here; releasing IS committing.
 *   - `rmdir` is refused. The workflow invariant is "each change touches
 *     exactly one file" and a recursive directory delete violates that.
 *     The agent must delete entries individually via `deleteFile`.
 *   - `mkdir` followed by a `.gitkeep` write is the canonical way to land
 *     "create empty folder" as a one-file change — the locking write of
 *     `.gitkeep` carries the commit.
 *
 * Path conventions: Mastra's `inputPath` is workspace-relative (e.g.
 * `knowledge-base/Knowledge/Foo.md`) — the same shape the human
 * editor's `openFilePath` carries, so locks acquired by the agent and
 * the user collide on the same key. That's why the human can't sneak
 * an edit in while the agent is writing the same file.
 */

import fs from 'node:fs/promises';
import {
  LocalFilesystem,
  type LocalFilesystemOptions,
  type CopyOptions,
  type FileContent,
  type RemoveOptions,
  type WriteOptions,
} from '@mastra/core/workspace';
import type { AuthUser, Change, IWorkflowService } from '@bevel-software/platform-shared';
import type { FileChangeNotifier } from './file-change-notifier.js';
import type { CreationGrantPlan, ICreatorAccess } from '../access/creator-access.js';

/** How many times to retry a contended acquire before giving up. */
const ACQUIRE_RETRY_ATTEMPTS = 3;
/** Backoff between retries (ms). 3 attempts × 2s ≈ 6s ceiling. */
const ACQUIRE_RETRY_DELAY_MS = 2_000;

/**
 * Dependencies the wrapper needs to talk to the workflow lock service.
 * Captured at construction time so every per-method call resolves to the
 * same `(workspace, branch, user)` triple — the agent can't accidentally
 * target a different workspace through this filesystem.
 */
export interface LockingFilesystemContext {
  workflow: IWorkflowService;
  workspaceId: string;
  branch: string;
  user: AuthUser;
  /**
   * Optional pre-disk write validator. Invoked with the (workspace-relative
   * path, full content) of every WHOLE-FILE write BEFORE the bytes land. Throw
   * to refuse the write — nothing hits disk and the lock is released without a
   * commit. Used to reject a `roles.yaml` edit that would lock out admins; see
   * `roles-yaml-guard.ts`. Whole-file writes only (`writeFile` / `writeFiles`);
   * partial ops (`appendFile`) are not validated.
   */
  validateWrite?: (path: string, content: FileContent) => void;
  /**
   * Post-commit hook for the BATCH `writeFiles` path (which commits via
   * `commitChanges` and so skips `runPendingCommit`'s emit). Single-file ops
   * emit through the queue instead, so they don't need this. Optional.
   */
  fileChanges?: FileChangeNotifier;
  /**
   * Optional creator read-grant planner (see `modules/access/creator-access`).
   * When present, a write/mkdir that CREATES a KB node the acting user can't
   * read gets an automatic `read:` grant — seeded into a new directory's
   * `access.md` or folded into a new markdown file's frontmatter — so the
   * agent's creations don't vanish from the driving user's explorer under
   * default-deny reads. Absent (tests, non-KB filesystems) → no grants.
   */
  creatorAccess?: ICreatorAccess;
}

export class LockingFilesystem extends LocalFilesystem {
  private readonly lockContext: LockingFilesystemContext;

  constructor(
    options: LocalFilesystemOptions,
    lockContext: LockingFilesystemContext,
  ) {
    super(options);
    this.lockContext = lockContext;
  }

  override async writeFile(
    inputPath: string,
    content: FileContent,
    options?: WriteOptions,
  ): Promise<void> {
    // Pre-disk gate (e.g. reject a roles.yaml edit that would lock out admins).
    // Runs OUTSIDE the lock so a refusal never acquires/holds one.
    this.lockContext.validateWrite?.(inputPath, content);
    // Creator read grant (see LockingFilesystemContext.creatorAccess): planned
    // BEFORE the write so the topmost-new-directory detection sees the
    // pre-creation tree. A subtree seed lands first in its own lock+commit
    // cycle so the grant is on disk before the file it makes visible.
    const plan = await this.planCreate(inputPath, 'file');
    if (plan?.kind === 'seed-access-md') await this.seedAccessMd(plan);
    const toWrite =
      plan?.kind === 'frontmatter' && typeof content === 'string'
        ? plan.apply(content)
        : content;
    return this.withLock(inputPath, () => super.writeFile(inputPath, toWrite, options));
  }

  override async appendFile(inputPath: string, content: FileContent): Promise<void> {
    return this.withLock(inputPath, () => super.appendFile(inputPath, content));
  }

  override async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    return this.withLock(inputPath, () => super.deleteFile(inputPath, options));
  }

  override async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    // Lock on `dest`. `src` is read-only from this op's perspective — copy
    // creates a new file at dest without disturbing src on disk.
    return this.withLock(dest, () => super.copyFile(src, dest, options));
  }

  override async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    // A move mutates two paths: the source is deleted and the destination
    // is created. Only locking `dest` would let a concurrent writer hold
    // the source's lock and mutate it under us, and would also leave the
    // source's deletion uncommitted (commitFile is path-scoped — it stages
    // only the path the lock release names, not "everything dirty").
    //
    // Lock both, in deterministic string order so two concurrent moves
    // can't deadlock by acquiring locks in opposite orders. The releases
    // unwind in reverse: the outer lock's release commits its path, then
    // the inner lock's release commits its path — each move lands as two
    // single-file changes (one delete, one create). Git's rename
    // detection on log/blame still plugins them visually after the fact.
    if (src === dest) {
      return this.withLock(dest, () => super.moveFile(src, dest, options));
    }
    const [first, second] = src < dest ? [src, dest] : [dest, src];
    return this.withLock(first, () =>
      this.withLock(second, () => super.moveFile(src, dest, options)),
    );
  }

  /**
   * Write several files and commit them as ONE atomic change — the multi-file
   * counterpart to `writeFile`, for the rare case where a set of files must
   * land together or not at all (e.g. a role rename rewriting `roles.yaml` plus
   * every reference; a partial rewrite would be a silent access drop). Where
   * `writeFile` takes one lock cycle per file and lets the deferred queue commit
   * it, this wraps the WHOLE batch in one cycle: acquire every path's lock up
   * front, write every file to disk, then commit the whole set synchronously as
   * one change via the workflow service's `commitChanges` (one `git add` + one
   * `git commit`, then push), and release WITHOUT a per-file commit. Fail-closed:
   * if any lock can't be acquired, or a write/commit throws, nothing is committed
   * (the failure-path `releaseLockNoCommit` discards the uncommitted bytes).
   *
   * `writes[].path` is workspace-relative (like `writeFile`). We do the disk
   * write here; `commitChanges` only stages + commits what's on disk (the git
   * layer never writes content).
   */
  async writeFiles(
    writes: { path: string; content: FileContent }[],
    summary: string,
    deletes: string[] = [],
  ): Promise<Change | null> {
    const { workflow, workspaceId, branch, user } = this.lockContext;
    // Creator read grants for the batch: transform new markdown files'
    // content in place, and fold any subtree access.md seeds into the SAME
    // atomic batch (deduped — several files landing in one new folder share
    // one seed). Plans are computed against the pre-batch disk state, which
    // is exactly right: nothing below has hit disk yet. A seed whose path the
    // caller explicitly writes in this batch is skipped — the caller's bytes
    // win.
    const seeds = new Map<string, (current: string) => string>();
    const grantedWrites: { path: string; content: FileContent }[] = [];
    for (const w of writes) {
      const plan = await this.planCreate(w.path, 'file');
      if (plan?.kind === 'seed-access-md' && !writes.some((x) => x.path === plan.wsRelPath)) {
        seeds.set(plan.wsRelPath, plan.apply);
      }
      grantedWrites.push(
        plan?.kind === 'frontmatter' && typeof w.content === 'string'
          ? { path: w.path, content: plan.apply(w.content) }
          : w,
      );
    }
    writes = grantedWrites;
    // Pre-disk gate every file BEFORE acquiring any lock (fail-closed): a
    // refusal must not leave a lock held or a partial batch on disk.
    if (this.lockContext.validateWrite) {
      for (const w of writes) this.lockContext.validateWrite(w.path, w.content);
    }
    // Deterministic lock order (string sort) so two concurrent batch writes
    // can't deadlock by acquiring the same paths in opposite orders — the same
    // discipline `moveFile` uses for its two paths, generalized to N. Deletes are
    // locked too (a delete mutates that path just like a write).
    const paths = [...new Set([...writes.map((w) => w.path), ...deletes])].sort();
    const acquired: string[] = [];
    const releaseAll = async (): Promise<void> => {
      for (const p of acquired) {
        try {
          await workflow.releaseLockNoCommit(workspaceId, branch, p, user);
        } catch (releaseErr) {
          console.warn(
            `[locking-fs] releaseLockNoCommit failed for "${p}" during writeFiles:`,
            releaseErr instanceof Error ? releaseErr.message : releaseErr,
          );
        }
      }
    };

    // Acquire every lock before committing a single byte (fail-closed).
    for (const p of paths) {
      let holderName: string | null = null;
      let ok = false;
      for (let attempt = 0; attempt < ACQUIRE_RETRY_ATTEMPTS; attempt++) {
        const result = await workflow.acquireLock(workspaceId, branch, p, user);
        if (result.acquired) {
          ok = true;
          break;
        }
        holderName = result.lock.holderName;
        if (attempt < ACQUIRE_RETRY_ATTEMPTS - 1) await sleep(ACQUIRE_RETRY_DELAY_MS);
      }
      if (!ok) {
        await releaseAll();
        throw new Error(
          `Skipped editing "${p}" — locked by ${holderName ?? 'another user'}. ` +
            `Continuing with other edits; try this one again later.`,
        );
      }
      acquired.push(p);
    }

    // Creator-grant seed locks are BEST-EFFORT, single attempt, acquired
    // after the caller's paths: a contended access.md must drop that seed
    // (with a warning), never fail or stall the batch the caller asked for.
    // Single non-blocking attempts also can't deadlock against another batch.
    for (const p of [...seeds.keys()].sort()) {
      if (paths.includes(p)) continue; // already locked as a caller path
      const result = await workflow.acquireLock(workspaceId, branch, p, user);
      if (result.acquired) {
        acquired.push(p);
      } else {
        seeds.delete(p);
        console.warn(
          `[locking-fs] creator access.md seed skipped for "${p}" — locked by ${result.lock.holderName ?? 'another user'}`,
        );
      }
    }

    let change: Change | null;
    try {
      // Write/delete every file to disk inside the locks (workspace-relative;
      // LocalFilesystem resolves against basePath), then commit + push the whole
      // set as ONE change. `commitChanges` only stages + commits what's on disk.
      for (const w of writes) await super.writeFile(w.path, w.content);
      for (const p of deletes) await super.deleteFile(p);
      // Seeds merge into the CURRENT on-disk bytes (read under the lock) so a
      // concurrent creator's grant survives; per-seed failures are best-effort.
      for (const [p, apply] of seeds) {
        try {
          let current = '';
          const absolute = this.resolveAbsolutePath(p);
          if (absolute) {
            try {
              current = await fs.readFile(absolute, 'utf-8');
            } catch {
              // Not there yet — the normal case for a brand-new directory.
            }
          }
          const next = apply(current);
          if (next !== current) await super.writeFile(p, next);
        } catch (err) {
          console.warn(
            `[locking-fs] creator access.md seed failed for "${p}":`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      change = await workflow.commitChanges(workspaceId, user, summary);
      if (seeds.size > 0) this.lockContext.creatorAccess?.noteAccessFileWritten(workspaceId);
    } catch (err) {
      // A write or the commit threw — nothing should land. releaseLockNoCommit
      // discards the uncommitted bytes for each acquired path.
      await releaseAll();
      throw err;
    }
    // Commit already landed synchronously — release WITHOUT a per-file commit,
    // else `releaseLock` would enqueue a second (duplicate) commit per path.
    await releaseAll();
    // This batch path commits via `commitChanges`, NOT the per-file queue, so it
    // skips `runPendingCommit`'s emit — fire the post-commit hook here with the
    // WHOLE batch as one event, so an expensive subscriber (id-repair rebuilds the
    // id index) reacts once per batch, not once per file. A no-op commit (clean
    // tree) changed nothing, so it emits nothing.
    if (change) {
      // `acquired` = caller paths + any creator-grant seeds that landed in the
      // same commit — the exact set this batch may have touched.
      this.lockContext.fileChanges?.emit({ workspaceId, branch, paths: acquired, byUser: user });
    }
    return change;
  }

  override async mkdir(inputPath: string, options?: { recursive?: boolean }): Promise<void> {
    // Creator read grant: planned BEFORE the dir exists (the plan's
    // new-directory detection needs the pre-creation tree), seeded right
    // after — so the new folder's access.md names the acting user under
    // `read:` before anything else lands in it. Seeding also makes the dir
    // non-empty, so the .gitkeep below is skipped when the seed targets this
    // very dir (a deeper mkdir under a seeded ancestor still gets one).
    const plan = await this.planCreate(inputPath, 'dir');
    // mkdir itself is not a lockable op (it touches no file content), so we
    // do the bare super-call without acquiring. The lock + commit happens on
    // the `.gitkeep` write below — that's the file the workflow change
    // attaches to. If the dir already has content (rare; e.g. recursive
    // create where a sibling already exists), we skip the .gitkeep — empty-
    // folder placeholders are only useful for actually-empty folders.
    await super.mkdir(inputPath, options);
    if (plan?.kind === 'seed-access-md') await this.seedAccessMd(plan);
    const absolutePath = this.resolveAbsolutePath(inputPath);
    if (!absolutePath) return;
    let entries: string[];
    try {
      entries = await fs.readdir(absolutePath);
    } catch {
      // Read-back failed (raced delete? permissions?). Skip the .gitkeep —
      // recovering here is more complex than the value gained.
      return;
    }
    if (entries.length === 0) {
      const gitkeepPath = inputPath.endsWith('/')
        ? `${inputPath}.gitkeep`
        : `${inputPath}/.gitkeep`;
      // The .gitkeep write goes through our own lock-aware writeFile, so
      // the change is committed + pushed on release exactly like any
      // other agent edit.
      await this.writeFile(gitkeepPath, '');
    }
  }

  override async rmdir(_inputPath: string, _options?: RemoveOptions): Promise<void> {
    // Recursive directory removal would commit N file deletions in one
    // change — violates the one-change-per-file invariant. Force the
    // caller to delete files one at a time; each `deleteFile` lands as
    // its own change. The empty parent directory disappears with the
    // last file (git doesn't track empty folders).
    throw new Error(
      'Recursive directory removal is not supported through the lock-aware filesystem. ' +
        'Delete files individually so each removal lands as its own change.',
    );
  }

  /**
   * Land a `seed-access-md` creation-grant plan: under the access.md's own
   * lock (single acquire+release cycle → one commit), re-read the CURRENT
   * bytes and splice the grant into them — never a blind overwrite, so a
   * concurrent creator's just-landed grant on the same new directory
   * survives. Best-effort by contract: a contended lock, read, write, or
   * release failure here logs and returns — it must never fail the creation
   * that triggered the seed.
   */
  private async seedAccessMd(
    plan: Extract<CreationGrantPlan, { kind: 'seed-access-md' }>,
  ): Promise<void> {
    try {
      await this.withLock(plan.wsRelPath, async () => {
        let current = '';
        const absolute = this.resolveAbsolutePath(plan.wsRelPath);
        if (absolute) {
          try {
            current = await fs.readFile(absolute, 'utf-8');
          } catch {
            // Not there yet — the normal case for a brand-new directory.
          }
        }
        const next = plan.apply(current);
        if (next !== current) await super.writeFile(plan.wsRelPath, next);
      });
      this.lockContext.creatorAccess?.noteAccessFileWritten(this.lockContext.workspaceId);
    } catch (err) {
      console.warn(
        `[locking-fs] creator access.md seed failed for "${plan.wsRelPath}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Plan the creator read grant for a pending creation at `inputPath`
   * (workspace-relative, same shape every override receives). Null when no
   * planner is wired, the path isn't a grantable KB creation, or planning
   * fails — the grant is best-effort UX and must never block the write.
   */
  private async planCreate(
    inputPath: string,
    kind: 'file' | 'dir',
  ): Promise<CreationGrantPlan | null> {
    const { creatorAccess, workspaceId, user } = this.lockContext;
    if (!creatorAccess) return null;
    try {
      return await creatorAccess.planForCreate(workspaceId, user, inputPath, kind);
    } catch (err) {
      console.warn(
        `[locking-fs] creator read-grant planning failed for "${inputPath}":`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Acquire the lock, run `op`, release. The release does the commit +
   * push via `WorkflowService.releaseLock`. On contention we retry a few
   * times before surfacing a structured failure — long enough to ride
   * out a human typing a quick edit, short enough that the agent doesn't
   * stall a whole turn waiting for someone to step away from a file.
   */
  private async withLock<T>(inputPath: string, op: () => Promise<T>): Promise<T> {
    const { workflow, workspaceId, branch, user } = this.lockContext;

    let lastHolderName: string | null = null;
    let acquired = false;
    for (let attempt = 0; attempt < ACQUIRE_RETRY_ATTEMPTS; attempt++) {
      const result = await workflow.acquireLock(workspaceId, branch, inputPath, user);
      if (result.acquired) {
        acquired = true;
        break;
      }
      lastHolderName = result.lock.holderName;
      if (attempt < ACQUIRE_RETRY_ATTEMPTS - 1) {
        await sleep(ACQUIRE_RETRY_DELAY_MS);
      }
    }
    if (!acquired) {
      throw new Error(
        `Skipped editing "${inputPath}" — locked by ${lastHolderName ?? 'another user'}. ` +
          `Continuing with other edits; try this one again later.`,
      );
    }

    let result: T;
    try {
      result = await op();
    } catch (err) {
      // Op failed — drop the lock without committing, so a partial write
      // before the throw doesn't accidentally land as a committed change
      // (the normal `releaseLock` would `commitFile` whatever's on disk
      // for `inputPath`, including the partial state). Best-effort: a
      // failure to release here surfaces in logs but doesn't override
      // the original op error the caller actually cares about.
      try {
        await workflow.releaseLockNoCommit(workspaceId, branch, inputPath, user);
      } catch (releaseErr) {
        console.warn(
          `[locking-fs] releaseLockNoCommit failed for "${inputPath}" after op error:`,
          releaseErr instanceof Error ? releaseErr.message : releaseErr,
        );
      }
      throw err;
    }

    // Op succeeded — release. Under the pending-commits queue the release
    // just drops the lock and enqueues a commit; the worker handles the
    // actual `commitFile + push` out of band. The agent's tool call
    // returns once disk + lock + enqueue are done — the commit lands
    // moments later (typically <1s) without blocking the agent's turn.
    await workflow.releaseLock(workspaceId, branch, inputPath, user);
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

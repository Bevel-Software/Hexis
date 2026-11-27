/**
 * A `LocalFilesystem` that wraps every mutating operation in a version-control
 * lock acquire → super-call → release-with-auto-commit-and-push cycle.
 * This is the agent's file edit surface — Mastra hands the agent the
 * workspace's filesystem tools (write_file / edit_file / etc.), and those
 * call directly into this class, so the agent's edits go through the same
 * lock + commit + push pipeline as the human editor's saves.
 *
 * Per the version-control spec (PLAN.md §2):
 *   - Each tool call is one acquire/release cycle. The agent never holds a
 *     lock while it's "thinking" between tool calls — a fast human editor
 *     can always grab a file the agent isn't actively writing.
 *   - On lock contention (someone else holds the lock) we retry 3× at
 *     2-second intervals (~6s ceiling) then surface a structured error
 *     so the agent can skip the file and continue with the rest of its
 *     turn rather than aborting the whole call.
 *   - Lock-release inside `VersionControlService.releaseLock` is the thing that
 *     actually commits + pushes the file — see that method for the
 *     `commitFile → release → push` sequence. We don't repeat the commit
 *     step here; releasing IS committing.
 *   - `rmdir` is refused. The version-control invariant is "each change touches
 *     exactly one file" and a recursive directory delete violates that.
 *     The agent must delete entries individually via `deleteFile`.
 *   - `mkdir` followed by a `.gitkeep` write is the canonical way to land
 *     "create empty folder" as a one-file change — the locking write of
 *     `.gitkeep` carries the commit. The same placeholder keeps a folder
 *     whose last file was deleted or moved out: `delete_file` / `move_file`
 *     write it through `writeFile` here (see `keepFolderOf` in the tools),
 *     because a folder exists until it is deleted explicitly.
 *
 * Path conventions: Mastra's `inputPath` is workspace-relative (e.g.
 * `knowledge-base/Knowledge/Foo.md`) — the same shape the human
 * editor's `openFilePath` carries, so locks acquired by the agent and
 * the user collide on the same key. That's why the human can't sneak
 * an edit in while the agent is writing the same file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../shared/logging.js';

const log = logger('locking-fs');
import {
  type LocalFilesystemOptions,
  type CopyOptions,
  type FileContent,
  type RemoveOptions,
  type WriteOptions,
} from '@mastra/core/workspace';
import type { AuthUser, Change, IVersionControlService } from '@bevel-software/platform-shared';
import { PushNeedsAgentResolutionError, VersionControlDomainError } from '../../shared/domain-errors.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { DestinationTakenError, lstatOrNull, renameNoReplace, takenError } from '../../shared/rename-no-replace.js';
import { linkedAncestor } from '../../shared/no-link-below.js';
import { mapPooled } from '../../shared/map-pooled.js';
import { assertNoGitInternalsSegment } from '../../shared/git-internals.js';
import { assertInsideRepo } from './repo-path.js';
import { GitGuardedFilesystem } from './git-guarded-filesystem.js';
import type { CreationGrantPlan, ICreatorAccess } from '../access-model/index.js';

/** How many times to retry a contended acquire before giving up. */
const ACQUIRE_RETRY_ATTEMPTS = 3;
/** Backoff between retries (ms). 3 attempts × 2s ≈ 6s ceiling. */
const ACQUIRE_RETRY_DELAY_MS = 2_000;
/**
 * The lease a batch assumes when the lock it was granted does not say how long
 * it lasts (no `acquiredAt` / `expiresAt` to read it from): the lock service's
 * own lease today.
 */
const FALLBACK_LEASE_MS = 60_000;
/** How many heartbeats a batch sends at once, when it renews or confirms the locks it holds. */
const HEARTBEATS_AT_ONCE = 16;

/**
 * A write could not keep `path`'s lock. Either another holder kept it past the
 * retries, and nothing of that write was written; or (`lapsed`) `writeFiles`
 * could not confirm that it still held a lock it took (see there), and nothing
 * was committed, though bytes it wrote may be on disk under the lock's new
 * holder. A 409 whose payload is `{ kind: 'path-held', path }`, so a route or
 * tool that passes it on answers it as the conflict it is. The message names
 * the path and says which of the two happened; a caller that answers in its
 * own words reads `path` and `holderName` (null when lapsed) rather than the
 * message.
 */
export class PathHeldError extends VersionControlDomainError {
  readonly kind = 'path-held' as const;
  constructor(
    readonly path: string,
    readonly holderName: string | null,
    /** True when the write lost a lock it held (see above), not when it could not take one. */
    readonly lapsed = false,
  ) {
    super(
      lapsed
        ? `Skipped editing "${path}" — this write could not confirm it still held its lock. Nothing was committed; try again later.`
        : `Skipped editing "${path}" — locked by ${holderName ?? 'another user'}. Nothing of this write was written; try again later.`,
      409,
      { kind: 'path-held', path },
    );
    this.name = 'PathHeldError';
  }
}

/**
 * Whatever a lock cycle's `check` threw — an Error or any other value — carried
 * out of `lockedCycle`: nothing was written, so every lock it unwinds releases
 * untouched. `withLock` hands the caller the original `reason`.
 */
class CheckRefusal {
  constructor(readonly reason: unknown) {}
}

/**
 * `moveWithEdits` could not take a lock: another writer held `path` past the
 * retries. Nothing was moved or written.
 */
export class MoveLockedError extends Error {
  constructor(
    readonly path: string,
    readonly holderName: string | null,
  ) {
    super(
      `"${path}" is being edited by ${holderName ?? 'another user'}, so nothing was moved and no link was changed. ` +
        'Try the move again later.',
    );
    this.name = 'MoveLockedError';
  }
}

/**
 * `moveWithEdits` found a file in the folder that was not there when the
 * locks were planned: somebody saved into the folder meanwhile. Nothing was
 * moved; the caller plans again against the folder as it is now.
 */
export class MoveRacedError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" was added to the folder while the move was being prepared, so nothing was moved. Run the move again.`);
    this.name = 'MoveRacedError';
  }
}

/**
 * `moveWithEdits` failed after the rename and could not put the folder back.
 * The locks were released with the discard, so the working tree is reset to
 * the last commit rather than left half-moved; the error carries both
 * failures for the log.
 */
export class MoveUndoError extends Error {
  constructor(
    readonly src: string,
    readonly dest: string,
    readonly cause: unknown,
    readonly undoFailure: unknown,
  ) {
    super(
      `Moving "${src}" to "${dest}" failed (${cause instanceof Error ? cause.message : String(cause)}), and the move ` +
        `could not be undone (${undoFailure instanceof Error ? undoFailure.message : String(undoFailure)}). ` +
        'The working copy has been reset to the last commit; check the folder before trying again.',
    );
    this.name = 'MoveUndoError';
  }
}

/**
 * A pre-disk write validator: called with the (workspace-relative path, full
 * candidate content) of a write; throw (or reject) to refuse it. `appliesTo`
 * names the paths it guards — only a validator that declares it is also run
 * for the ops whose candidate has to be read first (append, copy, move), so an
 * unrelated copy never pays for reading its source.
 */
export type WriteValidator = ((path: string, content: FileContent) => void | Promise<void>) & {
  appliesTo?: (path: string) => boolean;
};

/**
 * Dependencies the wrapper needs to talk to the version-control lock service.
 * Captured at construction time so every per-method call resolves to the
 * same `(workspace, branch, user)` triple — the agent can't accidentally
 * target a different workspace through this filesystem.
 */
export interface LockingFilesystemContext {
  versionControl: IVersionControlService;
  workspaceId: string;
  branch: string;
  user: AuthUser;
  /**
   * The clone folder at the workspace root (`knowledge-base`). The filesystem
   * is rooted one level ABOVE the repository, so containment alone lets a
   * repo-relative path (`KnowledgeBase/…`) land beside the clone, where git
   * never sees it and the release commit quietly no-ops. Every op that
   * creates or modifies bytes is refused unless its path starts with this
   * folder; removals stay open so a stray the old behaviour left there can
   * still be cleaned up.
   */
  kbDirName: string;
  /**
   * Optional pre-disk write validator. Invoked with the (workspace-relative
   * path, full content) of every WHOLE-FILE write BEFORE the bytes land. Throw
   * to refuse the write — nothing hits disk. It runs before the lock (so an
   * ordinary refusal takes none) and again once the lock is held, on exactly
   * the bytes that land, so a validator reading the current file judges the
   * state it replaces; a refusal there releases the lock untouched. Used to
   * reject a `roles.yaml` edit that would lock out admins (and, for agents,
   * one that creates a role); see `roles-yaml-guard.ts`. `appendFile`,
   * `copyFile` and `moveFile` are validated too, with the resulting content,
   * when the destination is a path the validator's `appliesTo` claims.
   */
  validateWrite?: WriteValidator;
  /**
   * Optional creator read-grant planner (see `modules/access/creator-access`).
   * When present, a write/mkdir that starts a NEW FOLDER directly under one
   * of the three roots the acting user can't read gets an automatic `read:`
   * grant seeded into that folder's `access.md`, so the agent's creations
   * don't vanish from the driving user's explorer under default-deny reads.
   * Any other creation the user could not see is refused by the lock's read
   * gate. Absent (tests, non-KB filesystems) → no grants.
   */
  creatorAccess?: ICreatorAccess;
}

export class LockingFilesystem extends GitGuardedFilesystem {
  private readonly lockContext: LockingFilesystemContext;

  constructor(
    options: LocalFilesystemOptions,
    lockContext: LockingFilesystemContext,
  ) {
    super(options);
    this.lockContext = lockContext;
  }

  /**
   * `check` is the CALLER's under-lock judgement: it runs once the path's lock
   * is held and before a byte lands — the same slot `validateWrite` uses,
   * opened up so a caller whose verdict depends on what the path CURRENTLY
   * holds (the write tools' `mode` gate: does this path exist?) reads a state
   * nobody else can move. Judged before the lock instead, such a verdict is a
   * guess: a human editor saving between the stat and the write would have its
   * file replaced by a `create` that then reported `created`. Throwing refuses
   * the write and releases the lock untouched; the caller gets what it threw.
   */
  override async writeFile(
    inputPath: string,
    content: FileContent,
    options?: WriteOptions,
    check?: () => void | Promise<void>,
  ): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    this.assertInsideRepo(inputPath);
    // Pre-disk gate (e.g. reject a roles.yaml edit that would lock out admins).
    // Runs OUTSIDE the lock first so an ordinary refusal never acquires one,
    // then again under the lock on the bytes that land (see withLock's check).
    const validate = this.lockContext.validateWrite;
    await validate?.(inputPath, content);
    // Creator read grant (see LockingFilesystemContext.creatorAccess): planned
    // BEFORE the write so the new-folder detection sees the pre-creation
    // tree. The seed lands first in its own lock+commit cycle so the grant is
    // on disk before the file it makes visible.
    const plan = await this.planCreate(inputPath, 'file');
    if (plan?.kind === 'seed-access-md') await this.seedAccessMd(plan);
    const toWrite = content;
    // An EXCLUSIVE write (`overwrite: false`, the `wx` flag) that finds the
    // name taken is refused as a copy is (`asTakenRefusal`): the refusal is a
    // `DestinationTakenError`, so the lock is released untouched. Left as the
    // raw failure it would be a failed op, and the discard that follows resets
    // the PATH — throwing away the winner's file, whose commit is still queued.
    const land = () => super.writeFile(inputPath, toWrite, options);
    return this.withLock(
      inputPath,
      () => (options?.overwrite === false ? this.asTakenRefusal(inputPath, land) : land()),
      (check || validate) &&
        (async () => {
          // The caller's verdict first: it decides whether this write happens
          // at all, so the content validator only judges bytes that will land.
          await check?.();
          await validate?.(inputPath, toWrite);
        }),
    );
  }

  /**
   * Write a file whose new content DEPENDS on what it holds: the read, the
   * computing of the new bytes and the write all happen with the path's lock
   * held, so what lands is derived from the very bytes it replaces.
   *
   * `writeFile` cannot give that. Its content is fixed before the lock is
   * taken, so a caller that read the file first is writing over a state
   * anyone may have moved in between: an `edit_file` replacing an empty owner
   * field with one name would silently overwrite another name written a
   * moment earlier, and both callers would be told their edit landed.
   *
   * `rewrite` receives the file as it is under the lock (null when nothing is
   * there) and answers the bytes to write. Throwing refuses: nothing is
   * written, the lock is released untouched, and the caller gets what was
   * thrown.
   */
  async rewriteFile(
    inputPath: string,
    rewrite: (current: Buffer | null) => FileContent | Promise<FileContent>,
  ): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    this.assertInsideRepo(inputPath);
    const validate = this.lockContext.validateWrite;
    let toWrite: FileContent | null = null;
    return this.withLock(
      inputPath,
      () => super.writeFile(inputPath, toWrite as FileContent),
      async () => {
        const next = await rewrite(await this.readIfExists(inputPath));
        // The pre-disk gate judges the bytes that will land, as it does for
        // every other write, and here those exist only now.
        await validate?.(inputPath, next);
        toWrite = next;
      },
    );
  }

  override async appendFile(inputPath: string, content: FileContent): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    this.assertInsideRepo(inputPath);
    const candidate = async () =>
      Buffer.concat([asBuffer((await this.readIfExists(inputPath)) ?? ''), asBuffer(content)]);
    await this.validateResultingWrite(inputPath, candidate);
    // Under the lock the resulting file is judged again and, when a validator
    // claims the path, written whole — so the bytes that land are the ones judged.
    let checked: Buffer | null = null;
    return this.withLock(
      inputPath,
      () => (checked === null ? super.appendFile(inputPath, content) : super.writeFile(inputPath, checked)),
      async () => {
        checked = await this.validateResultingWrite(inputPath, candidate);
      },
    );
  }

  override async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    return this.withLock(inputPath, () => super.deleteFile(inputPath, options));
  }

  override async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.assertNotGitInternals(src);
    await this.assertNotGitInternals(dest);
    this.assertInsideRepo(dest);
    await this.validateResultingWrite(dest, () => this.readFile(src));
    // Lock on `dest`. `src` is read-only from this op's perspective — copy
    // creates a new file at dest without disturbing src on disk. Because `src`
    // is not locked, a claimed destination gets the source bytes read and
    // judged under the lock, and exactly those bytes are written.
    //
    // A copy lands bytes at a name of its own, so it never replaces what is
    // already there — the rule a move follows. Unless the caller explicitly
    // asks to overwrite, both landings below run exclusively: `copyFile` with
    // `overwrite: false` uses `COPYFILE_EXCL` and `writeFile` the `wx` flag,
    // each of which FAILS rather than replaces if the name was taken in the
    // meantime. That is what makes the tool's own look at the destination a
    // message rather than the whole guarantee.
    const noReplace: CopyOptions = { ...options, overwrite: options?.overwrite === true };
    let checked: FileContent | null = null;
    return this.withLock(
      dest,
      () =>
        this.asTakenRefusal(dest, () =>
          checked === null
            ? super.copyFile(src, dest, noReplace)
            : super.writeFile(dest, checked, { overwrite: noReplace.overwrite }),
        ),
      async () => {
        checked = await this.validateResultingWrite(dest, () => this.readFile(src));
      },
    );
  }

  /**
   * Run `landing` and turn the filesystem's own "that name is taken" failure
   * into the refusal every surface answers with — `A file named … already
   * exists in ….` — so a copy that loses the race reads exactly like a copy
   * that was refused by the look before it.
   */
  private async asTakenRefusal(dest: string, landing: () => Promise<void>): Promise<void> {
    try {
      await landing();
    } catch (err) {
      // Mastra's `FileExistsError` by name (this file avoids importing its
      // error classes, and the name is its stable surface), plus the raw codes
      // the exclusive flags answer with when the name is taken by something
      // other than a plain file.
      const name = (err as { name?: string } | null)?.name;
      const code = (err as NodeJS.ErrnoException | null)?.code;
      const taken = name === 'FileExistsError' || code === 'EEXIST' || code === 'EISDIR';
      const absolute = taken ? this.resolveAbsolutePath(dest) : undefined;
      // Only when something really is there: a code alone must not turn an
      // unrelated failure into "already exists". `lstat`, not an existence
      // probe that follows links — a DANGLING link holds the name against an
      // exclusive create while resolving to nothing, and it is an entry the
      // user can see, so it gets the clash sentence like any other.
      if (absolute !== undefined && (await lstatOrNull(absolute)) !== null) {
        throw await takenError(absolute, dest);
      }
      throw err;
    }
  }

  override async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.assertNotGitInternals(src);
    await this.assertNotGitInternals(dest);
    // Only the destination is gated: moving a stray INTO the repository is how
    // a file the old behaviour left beside the clone gets rescued.
    this.assertInsideRepo(dest);
    await this.validateResultingWrite(dest, () => this.readFile(src));
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
    // detection on log/blame still groups them visually after the fact.
    //
    // The destination is judged again once BOTH locks are held (the inner
    // lock's check): the source cannot change under its lock, so the bytes
    // judged there are the bytes the move lands.
    const check = async () => {
      await this.validateResultingWrite(dest, () => this.readFile(src));
    };
    const move = () => this.moveNoReplace(src, dest, options);
    if (src === dest) {
      return this.withLock(dest, move, check);
    }
    const [first, second] = src < dest ? [src, dest] : [dest, src];
    // The inner cycle is the raw one, so its refusal reaches the outer lock
    // still marked as a refusal and both release untouched.
    return this.withLock(first, () => this.lockedCycle(second, move, check));
  }

  /**
   * The move itself, refusing a destination that is taken instead of replacing
   * it — `fs.rename`, which `LocalFilesystem.moveFile` calls, replaces an
   * existing file on every platform, and that is how a `.docx` renamed onto an
   * existing `.md` handed the markdown file the Word bytes.
   *
   * The caller above (`move_file`) has already looked at the destination and
   * refused a taken one with the sentence naming what is in the way. This runs
   * with both paths' locks held and is the backstop under that look: a
   * destination created in between — by a writer this process does not
   * serialize with, the sidebar's own `moveEntry` among them — is refused
   * atomically by the filesystem rather than overwritten. See
   * `shared/rename-no-replace.ts`.
   *
   * `overwrite: true` is still honoured, for a caller that means it; nothing
   * in the app passes it today.
   */
  private async moveNoReplace(src: string, dest: string, options?: CopyOptions): Promise<void> {
    if (options?.overwrite === true) return super.moveFile(src, dest, options);
    const srcAbsolute = this.resolveAbsolutePath(src);
    const destAbsolute = this.resolveAbsolutePath(dest);
    // A path this filesystem cannot resolve is not one to do raw `fs` calls
    // on; the base class refuses it with the message it always has.
    if (srcAbsolute === undefined || destAbsolute === undefined) {
      return super.moveFile(src, dest, options);
    }
    // `LocalFilesystem.moveFile` makes the destination's parent, and callers
    // rely on a move into a new folder working.
    await fs.mkdir(path.dirname(destAbsolute), { recursive: true });
    try {
      return await renameNoReplace(srcAbsolute, destAbsolute, dest);
    } catch (err) {
      // Across a mount point inside the workspace nothing can be renamed at
      // all; the base class's copy-then-remove is the only way through, and
      // `overwrite: false` keeps it exclusive (`COPYFILE_EXCL`) so it cannot
      // replace anything either.
      if ((err as NodeJS.ErrnoException | null)?.code !== 'EXDEV') throw err;
      return this.asTakenRefusal(dest, () =>
        super.moveFile(src, dest, { ...options, overwrite: false }),
      );
    }
  }

  /**
   * A move and the link edits it brings, as ONE change: `move_file` with link
   * rewriting on. Where `moveFile` lands a move as two queued single-path
   * commits (a delete, a create), this takes every lock first — both ends of
   * the move, every file a moved folder holds at its old and its new path, and
   * every file it edits — in deterministic order, renames,
   * writes the edits, and commits the whole set synchronously in one commit,
   * so git sees the move as a rename beside the edits.
   *
   * `edits[].path` is where each file sits AFTER the move (a moved file's
   * edit lands at its new path); `edits[].lockAt` is where it sits now, and is
   * the path locked. `check` runs once every lock is held and before anything
   * changes — the caller confirms there that the bytes its edits were computed
   * from are still the bytes on disk.
   *
   * Fail-closed: a lock still held by another writer after the retries throws
   * {@link MoveLockedError} naming that path, with nothing moved and nothing
   * written; a failure after the rename puts every edited file's bytes back and
   * the move undone before the error leaves. Only edited text passes through
   * memory: a folder's other files, binaries among them, are renamed on disk.
   */
  async moveWithEdits(
    src: string,
    dest: string,
    edits: { path: string; lockAt: string; content: string }[],
    summary: string,
    check?: () => Promise<void>,
  ): Promise<Change | null> {
    const { versionControl, workspaceId, branch, user } = this.lockContext;
    await this.assertNotGitInternals(src);
    await this.assertNotGitInternals(dest);
    this.assertInsideRepo(dest);
    for (const e of edits) {
      await this.assertNotGitInternals(e.path);
      this.assertInsideRepo(e.path);
    }
    await this.validateResultingWrite(dest, () => this.readFile(src));
    if (this.lockContext.validateWrite) {
      for (const e of edits) await this.lockContext.validateWrite(e.path, e.content);
    }
    // A folder's files are locked one by one at both ends: a save to one of
    // them mid-move would otherwise recreate the old path, or ride this
    // move's commit, whose scope names every one of them.
    const movedNow = src === dest ? [] : await this.filesBelow(src);
    const paths = [
      ...new Set([
        src,
        dest,
        ...movedNow.flatMap((f) => [f, dest + f.slice(src.length)]),
        ...edits.map((e) => e.lockAt),
      ]),
    ].sort();
    const acquired: string[] = [];
    // Locked paths left holding bytes this move wrote and could not put back:
    // released with the discard (reset to HEAD), so those bytes cannot ride
    // the next save's commit as if they were this move's result.
    const dirtyLeft = new Set<string>();
    // The paths the commit names (set once it is built): the only ones a
    // release with a commit may enqueue. The folder locks at either end
    // coordinate and name nothing committed, so they go back untouched —
    // enqueued, a later write under those folders would be this move's.
    let scope: string[] = [];
    const release = async (mode: 'untouched' | 'enqueue'): Promise<void> => {
      for (const p of acquired) {
        try {
          if (mode === 'enqueue' && scope.includes(p)) await versionControl.releaseLock(workspaceId, branch, p, user);
          else if (mode === 'enqueue') await versionControl.releaseLockUntouched(workspaceId, branch, p, user);
          else if (dirtyLeft.has(p)) await versionControl.releaseLockNoCommit(workspaceId, branch, p, user);
          else await versionControl.releaseLockUntouched(workspaceId, branch, p, user);
        } catch (releaseErr) {
          log.warn(`lock release failed for "${p}" during moveWithEdits:`, { err: releaseErr });
        }
      }
    };
    for (const p of paths) {
      let holderName: string | null = null;
      let ok = false;
      try {
        for (let attempt = 0; attempt < ACQUIRE_RETRY_ATTEMPTS; attempt++) {
          const result = await versionControl.acquireLock(workspaceId, branch, p, user);
          if (result.acquired) {
            ok = true;
            break;
          }
          holderName = result.lock.holderName;
          if (attempt < ACQUIRE_RETRY_ATTEMPTS - 1) await sleep(ACQUIRE_RETRY_DELAY_MS);
        }
      } catch (err) {
        // The lock store failing is no reason to keep the locks already held
        // until their TTL runs out.
        await release('untouched');
        throw err;
      }
      if (!ok) {
        await release('untouched');
        throw new MoveLockedError(p, holderName);
      }
      acquired.push(p);
    }
    // Judged again under the locks, on the bytes that land: a validator that
    // reads the current file must see the state each edit replaces.
    try {
      // The folder's files, listed again now that every lock is held: a file
      // saved into it between the listing above and the locks would ride
      // this move's commit without its lock — refused, and the caller tries
      // again against the folder as it is now.
      if (src !== dest) {
        const locked = new Set(paths);
        const arrived = (await this.filesBelow(src)).find((f) => !locked.has(f));
        if (arrived !== undefined) throw new MoveRacedError(arrived);
      }
      // Placement, re-judged where the rename happens: a link introduced on
      // the way to either end since the caller's preflight would carry the
      // rename outside the repository.
      // The entries themselves included: an edit destination replaced by a
      // link since planning would have the write follow it.
      await this.assertNoLinkBelowBase(src);
      await this.assertNoLinkBelowBase(dest);
      for (const e of edits) await this.assertNoLinkBelowBase(e.path);
      await this.validateResultingWrite(dest, () => this.readFile(src));
      if (this.lockContext.validateWrite) {
        for (const e of edits) await this.lockContext.validateWrite(e.path, e.content);
      }
      await check?.();
    } catch (err) {
      await release('untouched');
      throw err;
    }

    // Done in this order, and undone in the reverse one.
    let moved = false;
    const written: { path: string; lockAt: string; before: Buffer | null }[] = [];
    try {
      await this.moveNoReplace(src, dest);
      moved = true;
      for (const e of edits) {
        const before = await this.readIfExists(e.path);
        written.push({ path: e.path, lockAt: e.lockAt, before });
        await super.writeFile(e.path, e.content);
      }
      // The commit names every file at both ends: a folder's files one by one,
      // because the scope matches files, not the folders holding them. From
      // the files LOCKED, not the destination as it is now: a file saved into
      // the new place since the rename is somebody else's, under no lock of
      // this move, and stays out of its commit.
      const movedFiles = src === dest ? [] : movedNow.map((f) => dest + f.slice(src.length));
      scope = [
        ...new Set([
          ...movedFiles.flatMap((f) => [f, src + f.slice(dest.length)]),
          ...edits.map((e) => e.path),
        ]),
      ].sort();
      const change = await versionControl.commitChanges(workspaceId, user, summary, scope);
      await release('untouched');
      return change;
    } catch (err) {
      if (err instanceof PushNeedsAgentResolutionError) {
        // The commit landed; only its push needs help. Releasing with a commit
        // arms the pending-commits worker's push retry (see `writeFiles`).
        await release('enqueue');
        throw err;
      }
      for (const w of written.reverse()) {
        try {
          if (w.before === null) {
            const absolute = this.resolveAbsolutePath(w.path);
            if (absolute) await fs.rm(absolute, { force: true });
          } else {
            await super.writeFile(w.path, w.before);
          }
        } catch (restoreErr) {
          log.warn(`could not restore "${w.path}" after a failed move:`, { err: restoreErr });
          dirtyLeft.add(w.path);
          dirtyLeft.add(w.lockAt);
        }
      }
      if (moved) {
        try {
          await this.moveNoReplace(dest, src);
        } catch (undoErr) {
          // The folder is still at its new place, holding bytes this move
          // wrote. Nothing may release that as "untouched": every locked path
          // is let go with the discard, so the half-done move is reset rather
          // than left for a later writer to publish, and the failure says so.
          log.warn(`could not undo the move of "${src}" after a failure:`, { err: undoErr });
          for (const p of acquired) dirtyLeft.add(p);
          await release('untouched');
          throw new MoveUndoError(src, dest, err, undoErr);
        }
      }
      await release('untouched');
      throw err;
    }
  }

  /**
   * Refuse a path when any folder between this filesystem's root and it is a
   * link — judged by `lstat` on each ancestor, under the locks, right before
   * the rename that would otherwise follow the link out of the repository.
   */
  private async assertNoLinkBelowBase(inputPath: string): Promise<void> {
    const absolute = this.resolveAbsolutePath(inputPath);
    if (!absolute) return;
    if ((await linkedAncestor(this.basePath, absolute)) !== null) {
      throw new Error(`"${inputPath}" is reached through a link, so nothing was moved.`);
    }
  }

  /** Every file at or under `inputPath` (workspace-relative), the path itself when it is a file. */
  private async filesBelow(inputPath: string): Promise<string[]> {
    const absolute = this.resolveAbsolutePath(inputPath);
    if (!absolute) return [inputPath];
    const stat = await lstatOrNull(absolute);
    if (!stat?.isDirectory()) return [inputPath];
    const out: string[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      for (const e of await fs.readdir(abs, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(abs, e.name), `${rel}/${e.name}`);
        else out.push(`${rel}/${e.name}`);
      }
    };
    await walk(absolute, inputPath);
    return out;
  }

  /**
   * Write several files and commit them as ONE atomic change — the multi-file
   * counterpart to `writeFile`, for the rare case where a set of files must
   * land together or not at all (e.g. a role rename rewriting `roles.yaml` plus
   * every reference; a partial rewrite would be a silent access drop). Where
   * `writeFile` takes one lock cycle per file and lets the deferred queue commit
   * it, this wraps the WHOLE batch in one cycle: acquire every path's lock up
   * front, write every file to disk, then commit the whole set synchronously as
   * one change via the version-control service's `commitChanges` (one `git add` + one
   * `git commit`, then push), and release WITHOUT a per-file commit. Fail-closed:
   * if any lock can't be acquired, or a write/commit throws, nothing is committed
   * (the failure-path `releaseLockNoCommit` discards the uncommitted bytes). A
   * lock another holds past the retries refuses the batch with
   * {@link PathHeldError}, naming the path and the holder; a lock the lock's own
   * gates refuse refuses it with the gate's error, unless `refused` (below)
   * takes that refusal as its path's alone.
   * The ONE exception is `PushNeedsAgentResolutionError` — a POST-commit
   * failure (the commit landed, the push didn't): locks release via
   * `releaseLock` so the enqueued release commit arms the pending-commits
   * worker's push retry, and the error still propagates to the caller.
   *
   * The batch keeps the `acquiredAt` of every lock it is granted, and a lock
   * is still its own only while a heartbeat (`heartbeatLock`) succeeds and
   * answers that same `acquiredAt`. A heartbeat that throws, or answers
   * another `acquiredAt` (the lease lapsed and the path was taken since, by
   * the same person's editor or second session too), marks the lock lost. The
   * locks it holds are renewed every third of the lease they were granted,
   * from the first grant until the last of them is given back, the release
   * loop included; a released path is renewed no more. Before its first
   * write, and again right before its commit, the batch sends one heartbeat
   * for every lock it holds. A lock lost by then refuses the batch with
   * {@link PathHeldError} naming that path (`lapsed`), and nothing is
   * committed. Refused before its first write, the batch gives back every lock
   * still its own untouched. Refused before its commit, it releases the paths
   * still its own as a failed commit does, and leaves a lost path as it is:
   * no discard and no release, since both are keyed on the user and would
   * reset the file and drop the lock its new holder holds; what the batch
   * wrote there stays on disk. A lock the batch knows it lost is never
   * released, on any of its unwinds. Nothing looks for a lock lost after the
   * last heartbeat before the commit, during the commit and its push.
   *
   * `writes[].path` is workspace-relative (like `writeFile`). We do the disk
   * write here; `commitChanges` only stages + commits what's on disk (the git
   * layer never writes content).
   *
   * `check` is the batch counterpart of `writeFile`'s: it runs once EVERY
   * path's lock is held and before any byte lands, is handed this batch's
   * writes in the order it was given them, and returns the subset that may
   * still land (the same objects — the creator-grant transform has already
   * been applied to their content). It is where a per-path verdict that
   * depends on what a path currently holds belongs, because only here is that
   * state one no other writer can move. A write it drops is never written: its
   * path releases untouched, stays out of the commit's scope, and takes its
   * creator-grant seed with it when no surviving write still wants one. A
   * `check` that THROWS refuses the whole batch, untouched.
   *
   * `refused` is asked when taking a WRITE's lock throws — the lock's own gates
   * refusing that path (`acquireLock`'s write rule or read-before-write), or
   * the lock service failing. Returning drops that write as `check` drops one:
   * its path is not locked, written or committed, and the batch goes on. Throwing
   * refuses the whole batch with what it threw, untouched. Without it, the
   * error refuses the batch as it is. A delete's lock is never offered: a
   * delete the gates refuse refuses the batch.
   */
  async writeFiles<C extends FileContent>(
    writes: { path: string; content: C }[],
    summary: string,
    deletes: string[] = [],
    check?: (writes: readonly { path: string; content: C }[]) => Promise<{ path: string; content: C }[]>,
    refused?: (path: string, err: unknown) => void,
  ): Promise<Change | null> {
    const { versionControl, workspaceId, branch, user } = this.lockContext;
    // Fail the whole batch before any plan, validator or lock: one stray path
    // must not let its siblings land while it silently misses git. Here only
    // what the spelling says; where a path resolves on disk is asked once its
    // lock is held (below).
    for (const w of writes) assertNoGitInternalsSegment(w.path);
    for (const d of deletes) assertNoGitInternalsSegment(d);
    for (const w of writes) this.assertInsideRepo(w.path);
    // Creator read grants for the batch: fold any new-root-folder access.md
    // seeds into the SAME atomic batch (deduped — several files landing in
    // one new folder share one seed). Plans are computed against the
    // pre-batch disk state, which is exactly right: nothing below has hit
    // disk yet. A seed whose path the caller explicitly writes in this batch
    // is skipped — the caller's bytes win.
    const seeds = new Map<string, (current: string) => string>();
    // Which of the caller's writes asked for each seed. A seed exists only to
    // make the files below it visible to their creator, so one whose every
    // origin `check` drops has nothing left to make visible and is dropped too.
    const seedOrigins = new Map<string, string[]>();
    for (const w of writes) {
      const plan = await this.planCreate(w.path, 'file');
      if (plan?.kind === 'seed-access-md' && !writes.some((x) => x.path === plan.wsRelPath)) {
        seeds.set(plan.wsRelPath, plan.apply);
        seedOrigins.set(plan.wsRelPath, [...(seedOrigins.get(plan.wsRelPath) ?? []), w.path]);
      }
    }
    /** Drop every seed none of the writes still in the batch asked for. */
    const pruneSeeds = (): void => {
      for (const [seedPath, origins] of seedOrigins) {
        if (!origins.some((o) => writes.some((w) => w.path === o))) seeds.delete(seedPath);
      }
    };
    // Pre-disk gate every file BEFORE acquiring any lock (fail-closed): a
    // refusal must not leave a lock held or a partial batch on disk.
    if (this.lockContext.validateWrite) {
      for (const w of writes) await this.lockContext.validateWrite(w.path, w.content);
    }
    // Deterministic lock order (string sort) so two concurrent batch writes
    // can't deadlock by acquiring the same paths in opposite orders — the same
    // discipline `moveFile` uses for its two paths, generalized to N. Deletes are
    // locked too (a delete mutates that path just like a write).
    const paths = [...new Set([...writes.map((w) => w.path), ...deletes])].sort();
    const acquired: string[] = [];
    // Paths whose on-disk bytes THIS batch replaced (caller writes/deletes,
    // recorded just before each disk op so a mid-write throw still counts).
    // Deliberately NOT the seed paths: a seed write is an additive merge of
    // the CURRENT bytes, and a failed one restores its pre-image itself —
    // only a seed whose restore ALSO failed joins the discard set, via
    // `failedSeedDiscards` (see the seed loop).
    const dirtied = new Set<string>();
    // Seed paths left holding known-partial bytes: the seed write threw
    // mid-write AND the pre-image restore failed too. These must release
    // with the discard so the corrupt bytes can't outlive the batch.
    const failedSeedDiscards = new Set<string>();
    // Every lock the batch is granted is renewed, and checked, until
    // `releaseAll` gives it back (see the doc above).
    const leases = this.renewLeases();
    // Release every acquired lock, each with the semantics its outcome
    // earned. Three shapes (mirroring the three VersionControlService releases):
    //
    //   'discard'   → releaseLockNoCommit: resets the path's working tree to
    //     HEAD. Only for bytes this batch itself owns — its committed paths
    //     (clean tree, the discard no-ops), its own failed writes, and a
    //     failed-restore seed (fail-closed: partial bytes must not land).
    //   'enqueue'   → releaseLock: enqueues a commit-on-release row. Only
    //     for the push-retry unwind, and only on the batch's OWN committed
    //     paths — the enqueued row is the vehicle that retries the push.
    //   'untouched' → releaseLockUntouched: drops the lock row and nothing
    //     else. For every path the batch merely LOCKED (a creator seed that
    //     no-op'd or fully restored itself, a caller path never reached):
    //     such a path may hold a PRIOR save's dirty bytes whose commit is
    //     still queued — a discard would silently destroy that landed save,
    //     and an enqueue would re-attribute its queued row to THIS user and
    //     reset its retry ladder.
    //   'keep'      → no call at all. A path whose lock this batch knows it
    //     lost is kept whatever mode it is handed: every release is keyed on
    //     the user, so any of them would drop the lock its new holder (the same
    //     person's editor too) now holds.
    const releaseAll = async (
      modeOf: (p: string) => 'discard' | 'enqueue' | 'untouched' | 'keep',
    ): Promise<void> => {
      // The locks not yet given back are renewed while the loop runs: with
      // thousands of paths it can outlast a lease. A path leaves the
      // renewals once its release has returned, so even a slow release
      // gives back a lock that is still its own.
      for (const p of acquired) {
        const mode = leases.lost(p) ? 'keep' : modeOf(p);
        if (mode === 'keep') {
          leases.released(p);
          continue;
        }
        try {
          if (mode === 'discard') {
            await versionControl.releaseLockNoCommit(workspaceId, branch, p, user);
          } else if (mode === 'enqueue') {
            await versionControl.releaseLock(workspaceId, branch, p, user);
          } else {
            await versionControl.releaseLockUntouched(workspaceId, branch, p, user);
          }
        } catch (releaseErr) {
          log.warn(`lock release failed for "${p}" during writeFiles:`, { err: releaseErr });
        } finally {
          leases.released(p);
        }
      }
      await leases.stop();
    };

    /**
     * Take `p`'s lock, retrying a held one up to `attempts` times. The ONE way
     * this batch takes a lock, the caller's paths and the creator seeds alike:
     * when the lock cannot be had — held past the retries ({@link
     * PathHeldError}), refused by the lock's gates, or the lock service
     * failing — every lock already held goes back untouched before the
     * refusal goes on. Nothing is written yet, so every held lock is a
     * merely-locked path, and the unwind leaves disk and queue exactly as they
     * are. The one exception: `alone`, handed a throw, may take it as this
     * path's refusal only, and the answer is then false with every other lock
     * still held.
     */
    const acquireOrGiveBack = async (
      p: string,
      attempts: number,
      alone?: (err: unknown) => void,
    ): Promise<boolean> => {
      let holderName: string | null = null;
      for (let attempt = 0; attempt < attempts; attempt++) {
        let result: Awaited<ReturnType<typeof versionControl.acquireLock>>;
        try {
          result = await versionControl.acquireLock(workspaceId, branch, p, user);
        } catch (refusal) {
          let reason: unknown = refusal;
          if (alone) {
            try {
              alone(refusal);
              return false;
            } catch (verdict) {
              reason = verdict;
            }
          }
          await releaseAll(() => 'untouched');
          throw reason;
        }
        if (result.acquired) {
          acquired.push(p);
          leases.granted(p, result.lock);
          return true;
        }
        holderName = result.lock.holderName;
        if (attempt < attempts - 1) await sleep(ACQUIRE_RETRY_DELAY_MS);
      }
      await releaseAll(() => 'untouched');
      throw new PathHeldError(p, holderName);
    };

    // Acquire every lock before committing a single byte (fail-closed). A
    // write whose lock the caller's `refused` takes as that path's refusal
    // alone leaves the batch here, as a write `check` drops does.
    const droppedAtLock = new Set<string>();
    for (const p of paths) {
      const alone = refused && !deletes.includes(p) ? (err: unknown) => refused(p, err) : undefined;
      if (!(await acquireOrGiveBack(p, ACQUIRE_RETRY_ATTEMPTS, alone))) droppedAtLock.add(p);
    }
    if (droppedAtLock.size > 0) {
      writes = writes.filter((w) => !droppedAtLock.has(w.path));
      pruneSeeds();
      if (writes.length === 0 && deletes.length === 0) {
        // Nothing left to write: no commit, for the reason given below.
        await releaseAll(() => 'untouched');
        return null;
      }
    }

    // Judge every file again now that its lock is held: a validator that reads
    // the current file (the agent roles.yaml gate) must see the bytes this
    // batch replaces, not the ones before the locks. Nothing is written yet,
    // so a refusal leaves every locked path exactly as it was.
    if (this.lockContext.validateWrite) {
      try {
        for (const w of writes) await this.lockContext.validateWrite(w.path, w.content);
      } catch (err) {
        await releaseAll(() => 'untouched');
        throw err;
      }
    }

    // The caller's own under-lock judgement (see the doc above): with every
    // lock held, it decides which writes may still land. Nothing is on disk
    // yet, so both a dropped write and an outright refusal leave every locked
    // path exactly as it was.
    if (check) {
      try {
        writes = await check(writes);
      } catch (err) {
        await releaseAll(() => 'untouched');
        throw err;
      }
      pruneSeeds();
      if (writes.length === 0 && deletes.length === 0) {
        // Every write dropped and nothing to delete: no bytes, so no commit
        // either. An unscoped one here would sweep in whatever another save
        // left dirty on the paths we merely locked.
        await releaseAll(() => 'untouched');
        return null;
      }
    }

    // The git-folder rule on disk (a path that resolves into the folder, a
    // link on the way included), once every lock is held and the locks'
    // gates and the caller's check have let the paths through: where a path
    // resolves is a fact about its folders, not for an answer to a caller
    // those gates refuse. It still refuses the whole batch, untouched.
    try {
      for (const w of writes) await this.assertNotGitInternals(w.path);
      for (const d of deletes) await this.assertNotGitInternals(d);
    } catch (err) {
      await releaseAll(() => 'untouched');
      throw err;
    }

    // Creator-grant seed locks: single attempt, acquired after the caller's
    // paths (a single non-blocking attempt cannot deadlock against another
    // batch). A contended access.md fails the batch the same way a contended
    // caller path does, with nothing written, and so does a seed lock the
    // gates refuse or the lock service fails to give: the seed exists to keep
    // a new root folder visible to the person creating it, and a batch that
    // landed without it would leave that folder invisible to them.
    for (const p of [...seeds.keys()].sort()) {
      if (paths.includes(p)) continue; // already locked as a caller path
      await acquireOrGiveBack(p, 1);
    }

    // Ownership before the first byte (see the doc above): a lock lost while
    // the batch judged refuses it here with nothing written. The locks still
    // its own go back untouched; a lost one is left to its new holder.
    const lostBeforeWrites = await leases.verify();
    if (lostBeforeWrites !== null) {
      await releaseAll(() => 'untouched');
      throw new PathHeldError(lostBeforeWrites, null, true);
    }

    // The paths this batch actually TOUCHED — the caller's writes + deletes,
    // plus each seed whose bytes really landed below. Kept separate from
    // `acquired` (which only tracks held LOCKS): a seed lock is taken before
    // we know whether the seed write happens, and scoping the commit to a
    // merely-locked path would sweep in another save's still-queued dirty
    // bytes on that path under this batch's author/summary.
    // Normally every locked caller path; after a `check` drop, only the
    // survivors — a path this batch does not write must stay out of the
    // commit's scope, or the commit sweeps in another save's queued bytes.
    const touched = [...new Set([...writes.map((w) => w.path), ...deletes])].sort();
    // Seeds whose bytes LANDED, with the pre-image read under their lock:
    // if the batch's commit then fails, these must be rolled back to that
    // pre-image (not to HEAD — the pre-image may be a prior save's queued
    // bytes) so an uncommitted grant can't sit on disk as if it were real.
    const landedSeeds = new Map<string, { current: string; existedBefore: boolean }>();
    // Set when the check right before the commit refuses the batch: its
    // unwind then leaves every lost path, bytes and lock, to its new holder.
    let refusedForLoss = false;
    const kept = (p: string): boolean => refusedForLoss && leases.lost(p);
    let change: Change | null;
    try {
      // Write/delete every file to disk inside the locks (workspace-relative;
      // LocalFilesystem resolves against basePath), then commit + push the whole
      // set as ONE change. `commitChanges` only stages + commits what's on disk.
      for (const w of writes) {
        dirtied.add(w.path);
        await super.writeFile(w.path, w.content);
      }
      for (const p of deletes) {
        dirtied.add(p);
        await super.deleteFile(p);
      }
      // Seeds merge into the CURRENT on-disk bytes (read under the lock) so a
      // concurrent creator's grant survives; per-seed failures are best-effort.
      for (const [p, apply] of seeds) {
        let current = '';
        let existedBefore = false;
        const absolute = this.resolveAbsolutePath(p);
        if (absolute) {
          try {
            current = await fs.readFile(absolute, 'utf-8');
            existedBefore = true;
          } catch {
            // Not there yet — the normal case for a brand-new directory.
          }
        }
        let next: string;
        try {
          next = apply(current);
        } catch (err) {
          // Plan failed before any bytes moved — the path is untouched.
          log.warn(`creator access.md seed failed for "${p}":`, { err });
          continue;
        }
        if (next === current) continue;
        try {
          await super.writeFile(p, next);
          touched.push(p);
          landedSeeds.set(p, { current, existedBefore });
        } catch (err) {
          // The write itself threw — it may have died MID-WRITE, leaving
          // partial bytes on disk. Left alone, those bytes would ride the
          // path's release (or the next save) as if they were real content.
          // Restore the pre-image we read under this very lock: on success
          // the path is byte-identical to before the batch and releases as
          // merely-locked; only when even the restore fails does the path
          // join the discard set (reset to HEAD on release — fail-closed,
          // partial bytes must never land). Residual risk, documented: in
          // that double-failure case a prior save's still-queued dirty bytes
          // on this path are lost to the discard — accepted, because the
          // alternative is committing known-corrupt bytes under their name.
          log.warn(`creator access.md seed failed for "${p}":`, { err });
          let restored = false;
          try {
            if (existedBefore) {
              await super.writeFile(p, current);
              restored = true;
            } else if (absolute) {
              // Didn't exist before — remove whatever the failed write left.
              await fs.rm(absolute, { force: true });
              restored = true;
            }
          } catch {
            // Fall through to the discard set.
          }
          if (!restored) {
            failedSeedDiscards.add(p);
            log.warn(`could not restore pre-seed bytes for "${p}" — releasing with discard`);
          }
        }
      }
      // Ownership again before the commit: a lock lost while the batch wrote
      // must not have this batch's bytes committed over its new holder's.
      const lostBeforeCommit = await leases.verify();
      if (lostBeforeCommit !== null) {
        refusedForLoss = true;
        throw new PathHeldError(lostBeforeCommit, null, true);
      }
      // Scope the commit to this batch's own paths (caller paths + landed
      // seeds): on the shared per-branch workspace another save's bytes may be
      // dirty with their commit still queued, and an unscoped commit would
      // sweep them in under this batch's author/summary.
      change = await versionControl.commitChanges(workspaceId, user, summary, touched);
      if (seeds.size > 0) this.lockContext.creatorAccess?.noteAccessFileWritten(workspaceId);
    } catch (err) {
      if (err instanceof PushNeedsAgentResolutionError) {
        // POST-commit failure: the commit LANDED and only the push needs help
        // (thrown "with the commit intact"). Routing this through the discard
        // release would strand the landed commit with nothing to retry the
        // push — the next identical write no-ops against the committed bytes
        // and the change stays unpublished forever. Release the batch's OWN
        // committed paths WITH commit-on-release instead (the same posture
        // AdminLockedCommits takes): each enqueued release commit no-ops on
        // the clean tree, and the pending-commits worker then notices the
        // unpushed commits and re-runs the cooperative push ladder. Merely-
        // locked paths still release untouched — arming the retry never
        // justifies re-attributing someone else's queued row (see
        // releaseAll), and `touched` is never empty here (the commit that
        // just landed had to have paths in scope).
        const committed = new Set(touched);
        await releaseAll((p) =>
          committed.has(p) ? 'enqueue' : failedSeedDiscards.has(p) ? 'discard' : 'untouched',
        );
        throw err;
      }
      // A write or the commit threw — nothing of THIS batch should land.
      // Landed seed bytes are uncommitted now too: roll each back to the
      // pre-image read under its lock (which may be a prior save's queued
      // bytes — a discard to HEAD would destroy those), and only a seed
      // whose rollback ALSO fails joins the discard set, same fail-closed
      // posture as a failed seed write. A seed whose lock was lost is not
      // this batch's to roll back.
      for (const [p, pre] of landedSeeds) {
        if (kept(p)) continue;
        try {
          if (pre.existedBefore) {
            await super.writeFile(p, pre.current);
          } else {
            const absolute = this.resolveAbsolutePath(p);
            if (absolute) await fs.rm(absolute, { force: true });
          }
        } catch {
          failedSeedDiscards.add(p);
          log.warn(`could not roll back seed bytes for "${p}" after a failed batch — releasing with discard`);
        }
      }
      // The batch's own dirtied paths (and any failed-restore seed) release
      // no-commit (the discard reverts them). Merely-locked paths — rolled-
      // back seeds included — release untouched (see releaseAll). A path
      // whose lock was lost is not released at all.
      await releaseAll((p) =>
        kept(p) ? 'keep' : dirtied.has(p) || failedSeedDiscards.has(p) ? 'discard' : 'untouched',
      );
      throw err;
    }
    // Commit already landed synchronously — the `touched` paths are clean
    // (nothing to discard, nothing to enqueue), so they release no-commit
    // like the batch's other own-bytes paths; the discard no-ops on the
    // clean tree, and a failed-restore seed's discard reverts its partial
    // bytes. A seed lock whose write no-op'd (or fully restored itself)
    // releases untouched: it was never this batch's to discard OR enqueue.
    const committed = new Set(touched);
    await releaseAll((p) =>
      committed.has(p) || failedSeedDiscards.has(p) ? 'discard' : 'untouched',
    );
    // The commit, if one landed, was reported by the git layer as it landed
    // (`VersionControlHooks.onCommitLanded`) with the paths it committed —
    // `touched` plus any creator-grant seed in the same commit. Nothing to
    // announce here.
    return change;
  }

  override async mkdir(inputPath: string, options?: { recursive?: boolean }): Promise<void> {
    await this.assertNotGitInternals(inputPath);
    this.assertInsideRepo(inputPath);
    // Creator read grant: planned BEFORE the dir exists (the plan's
    // new-directory detection needs the pre-creation tree), seeded right
    // after — so the new folder's access.md names the acting user under
    // `read:` before anything else lands in it. Seeding also makes the dir
    // non-empty, so the .gitkeep below is skipped when the seed targets this
    // very dir (a deeper mkdir under a seeded ancestor still gets one).
    const plan = await this.planCreate(inputPath, 'dir');
    // mkdir itself is not a lockable op (it touches no file content), so we
    // do the bare super-call without acquiring. The lock + commit happens on
    // the `.gitkeep` write below — that's the file the version-control change
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
    // its own change.
    throw new Error(
      'Recursive directory removal is not supported through the lock-aware filesystem. ' +
        'Delete files individually so each removal lands as its own change.',
    );
  }

  /**
   * Refuse a path that would put bytes beside the repository instead of in
   * it. Runs before any side effect (plan, validator, lock, disk) so a refusal
   * leaves nothing behind. See `LockingFilesystemContext.kbDirName`.
   */
  private assertInsideRepo(inputPath: string): void {
    assertInsideRepo(inputPath, this.lockContext.kbDirName);
  }

  /**
   * Validate an op whose resulting bytes at `dest` are not in hand (append,
   * copy, move): `candidate` is read only when the validator claims `dest`.
   * Runs before the lock, like `writeFile`'s gate, and again under it. Returns
   * the bytes judged, or null when no validator claims `dest`.
   */
  private async validateResultingWrite<C extends FileContent>(
    dest: string,
    candidate: () => Promise<C>,
  ): Promise<C | null> {
    const validate = this.lockContext.validateWrite;
    if (!validate?.appliesTo?.(dest)) return null;
    const bytes = await candidate();
    await validate(dest, bytes);
    return bytes;
  }

  /**
   * Renew the locks a batch is granted, and know which are still its own. A
   * lock is its own while a heartbeat succeeds and answers the `acquiredAt` it
   * was `granted` with; a heartbeat that throws, or answers another
   * `acquiredAt`, marks it `lost` for good, and a lost lock gets no more
   * heartbeats. From the first grant, every lock granted and not yet
   * `released` is renewed every third of that first lease (`expiresAt -
   * acquiredAt`, or {@link FALLBACK_LEASE_MS} when the lock does not say).
   * `verify` sends one heartbeat for every such lock now and answers the
   * first lost one, or null. `stop` ends the renewals and waits for one in
   * flight.
   */
  private renewLeases(): {
    granted(path: string, lock: { acquiredAt?: string; expiresAt?: string }): void;
    verify(): Promise<string | null>;
    lost(path: string): boolean;
    released(path: string): void;
    stop(): Promise<void>;
  } {
    const { versionControl, workspaceId, branch, user } = this.lockContext;
    /** Every lock granted, in grant order: the `acquiredAt` it was granted with, and whether it is lost. */
    const grants = new Map<string, { acquiredAt: string | undefined; lost: boolean }>();
    /** The locks still renewed: granted and not yet released. */
    const renewing = new Set<string>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let inFlight: Promise<void> | undefined;
    const heartbeat = async (p: string): Promise<void> => {
      const grant = grants.get(p);
      if (grant === undefined || grant.lost) return;
      try {
        const lock = await versionControl.heartbeatLock(workspaceId, branch, p, user);
        if (lock.acquiredAt !== grant.acquiredAt) {
          grant.lost = true;
          log.warn(`lock on "${p}" was acquired anew during writeFiles; this batch no longer holds it`);
        }
      } catch (err) {
        grant.lost = true;
        log.warn(`lease renewal failed for "${p}" during writeFiles; this batch no longer counts it as its own:`, { err });
      }
    };
    const beatAll = async (): Promise<void> => {
      await mapPooled([...renewing], HEARTBEATS_AT_ONCE, heartbeat);
    };
    return {
      granted: (p, lock) => {
        grants.set(p, { acquiredAt: lock.acquiredAt, lost: false });
        renewing.add(p);
        if (timer !== undefined) return;
        const lease = Date.parse(lock.expiresAt ?? '') - Date.parse(lock.acquiredAt ?? '');
        const every = (Number.isFinite(lease) && lease > 0 ? lease : FALLBACK_LEASE_MS) / 3;
        timer = setInterval(() => {
          inFlight ??= beatAll().finally(() => {
            inFlight = undefined;
          });
        }, every);
        timer.unref?.();
      },
      verify: async () => {
        await beatAll();
        for (const [p, grant] of grants) if (renewing.has(p) && grant.lost) return p;
        return null;
      },
      lost: (p) => grants.get(p)?.lost === true,
      released: (p) => {
        renewing.delete(p);
      },
      stop: async () => {
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  /** The bytes at `inputPath`, or null when nothing is there. */
  private async readIfExists(inputPath: string): Promise<Buffer | null> {
    const absolute = this.resolveAbsolutePath(inputPath);
    if (!absolute) return null;
    try {
      return await fs.readFile(absolute);
    } catch (err) {
      if (isAbsence(err)) return null;
      throw err;
    }
  }

  /**
   * Land a `seed-access-md` creation-grant plan: under the access.md's own
   * lock (single acquire+release cycle → one commit), re-read the CURRENT
   * bytes and splice the grant into them — never a blind overwrite, so a
   * concurrent creator's just-landed grant on the same new directory
   * survives. A contended lock, read, write, or release failure here FAILS
   * the creation that triggered the seed: the seed is planned only for a new
   * folder at a root the acting user cannot read, and without the grant the
   * folder would come into existence invisible to them — the very thing the
   * read gate exists to prevent.
   */
  private async seedAccessMd(
    plan: Extract<CreationGrantPlan, { kind: 'seed-access-md' }>,
  ): Promise<void> {
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
      log.warn(`creator read-grant planning failed for "${inputPath}":`, { err });
      return null;
    }
  }

  /**
   * Acquire the lock, run `op`, release. The release does the commit +
   * push via `VersionControlService.releaseLock`. On contention we retry a few
   * times before surfacing a structured failure — long enough to ride
   * out a human typing a quick edit, short enough that the agent doesn't
   * stall a whole turn waiting for someone to step away from a file.
   *
   * `check` runs once the lock is held and before `op`: a validator that
   * depends on what is on disk judges the state the op will actually replace.
   * A check refusal releases the lock UNTOUCHED — nothing was written, and the
   * no-commit release would reset the path to HEAD, destroying a prior save's
   * still-queued bytes — and so does every enclosing lock cycle it unwinds
   * through. The caller receives exactly what `check` threw.
   */
  private async withLock<T>(
    inputPath: string,
    op: () => Promise<T>,
    check?: () => Promise<void>,
  ): Promise<T> {
    try {
      return await this.lockedCycle(inputPath, op, check);
    } catch (err) {
      throw err instanceof CheckRefusal ? err.reason : err;
    }
  }

  /**
   * `withLock` without the unwrap: a `check` refusal leaves as a
   * {@link CheckRefusal}, so a cycle nested inside another (a move's second
   * lock) tells the enclosing one to release untouched too.
   */
  private async lockedCycle<T>(
    inputPath: string,
    op: () => Promise<T>,
    check?: () => Promise<void>,
  ): Promise<T> {
    const { versionControl, workspaceId, branch, user } = this.lockContext;

    let lastHolderName: string | null = null;
    let acquired = false;
    for (let attempt = 0; attempt < ACQUIRE_RETRY_ATTEMPTS; attempt++) {
      const result = await versionControl.acquireLock(workspaceId, branch, inputPath, user);
      if (result.acquired) {
        acquired = true;
        break;
      }
      lastHolderName = result.lock.holderName;
      if (attempt < ACQUIRE_RETRY_ATTEMPTS - 1) {
        await sleep(ACQUIRE_RETRY_DELAY_MS);
      }
    }
    if (!acquired) throw new PathHeldError(inputPath, lastHolderName);

    let result: T;
    try {
      if (check) {
        try {
          await check();
        } catch (reason) {
          throw new CheckRefusal(reason);
        }
      }
      result = await op();
    } catch (err) {
      // Op failed — drop the lock without committing, so a partial write
      // before the throw doesn't accidentally land as a committed change
      // (the normal `releaseLock` would `commitFile` whatever's on disk
      // for `inputPath`, including the partial state). A check refusal wrote
      // nothing, so it releases untouched instead — and so does a move or
      // copy refused because the destination is taken: its no-clobber call
      // (`link`, `mkdir`, `open` with `O_EXCL`) fails without creating
      // anything. That one matters beyond tidiness. The discard resets the
      // PATH rather than this call's changes, so on the destination of a lost
      // race — where the winner's move has landed and its commit is still
      // queued — discarding would throw the winner's file away on the way to
      // reporting the loser's refusal. Best-effort: a failure to release here
      // surfaces in logs but doesn't override the original op error the
      // caller actually cares about.
      try {
        if (err instanceof CheckRefusal || err instanceof DestinationTakenError) {
          await versionControl.releaseLockUntouched(workspaceId, branch, inputPath, user);
        } else {
          await versionControl.releaseLockNoCommit(workspaceId, branch, inputPath, user);
        }
      } catch (releaseErr) {
        log.warn(`lock release failed for "${inputPath}" after op error:`, { err: releaseErr });
      }
      throw err;
    }

    // Op succeeded — release. Under the pending-commits queue the release
    // just drops the lock and enqueues a commit; the worker handles the
    // actual `commitFile + push` out of band. The agent's tool call
    // returns once disk + lock + enqueue are done — the commit lands
    // moments later (typically <1s) without blocking the agent's turn.
    await versionControl.releaseLock(workspaceId, branch, inputPath, user);
    return result;
  }
}

function asBuffer(content: FileContent): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

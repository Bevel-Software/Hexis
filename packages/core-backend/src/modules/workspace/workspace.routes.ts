import fs from 'node:fs/promises';
import { logger } from '../../shared/logging.js';

const log = logger('workspace.routes');
import path from 'node:path';
import { IGNORE_FILENAME, isAbsence, type ITreeWalker } from '../../shared/fs.contract.js';
import { printable } from '../../shared/printable.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import express from 'express';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import {
  DEFAULT_BRANCH,
  KNOWLEDGE_DIR,
  canonicalRelativePath,
  folderPlaceholderPath,
  isPlatformFile,
  isPlatformRestoreShape,
  platformFileCreationRefusal,
  platformFileRefusal,
  reservedRootDirNames,
} from '@bevel-software/platform-shared';
import { FolderTooLargeError, type ReadTreeFilter } from './workspace.service.js';
import { branchForWorkspaceId } from '../../shared/workspace-id.js';
import { EntryExistsError, type WorkspaceService } from './workspace.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { canReadWorkspacePath, resolveReadableMap, toKbRelative } from '../access-model/kb-read-filter.js';
import type { ICreatorAccess } from '../access-model/creator.js';
import type { IChangeReadGate } from '../access-model/change-gate.js';
import { isRolesYamlPath, assertRolesYamlParsable } from '../access-model/roles-yaml-guard.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import { PathTraversalError, WorkflowDomainError } from '../../shared/domain-errors.js';
import { domainErrorBody } from '../../shared/http-errors.js';
import { assertWithinDirectory } from '../../shared/path-containment.js';
import { normalizeWorkspacePath } from '../kb-fs/repo-path.js';
import { hasGitInternalsSegment } from '../../shared/git-internals.js';
import { createGitInternalsRouteGuard } from './git-internals.middleware.js';
import { removeEmptyDirs } from './empty-dirs.js';
import '../auth/auth.middleware.js'; // Express Request augmentation
import type { SkillSaveCheck } from './workspace.tools.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * One file identity from one request field, or `null` when the caller sent
 * nothing usable.
 *
 * TYPED, not cast: a repeated `?path=a&path=b` arrives as an array and a JSON
 * body can hold anything, so `as string` would hand a non-string to the
 * canonicaliser and throw a 500 on what is a client mistake.
 *
 * CANONICAL, because the mutating verbs on this surface coordinate on the
 * path: `PUT` takes an in-process write turn on it, all of them take the
 * workflow lock row keyed by it, and the bytes live at it. A save spelled
 * `x/a.md` and a delete spelled `./x//a.md` would otherwise take two
 * different lock rows for one file and interleave. See
 * `canonicalRelativePath` for what it refuses to touch.
 */
function requestPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return canonicalRelativePath(value);
}

/**
 * Workspaces are per-branch (PLAN §3). Any authenticated user can access
 * any branch's workspace; coordination of concurrent edits lives in the
 * file-lock service, not in giving each user their own clone. We therefore
 * gate every handler on authentication only — there is no "this is my
 * workspace" ownership check.
 *
 * Every file-mutating route on this surface — `PUT /file`, `DELETE /file`,
 * `PATCH /file` (move), `POST /directory`, `POST /upload`, `POST /unzip` —
 * routes its write through `withLock(path, op)`: acquire the per-file
 * workflow lock, perform the op, then release. The release commits the
 * file as a one-file change attributed to the user and pushes it to origin,
 * exactly like the lock-aware filesystem the agent writes through. There
 * is no separate "share" step; save and share are fused.
 */
export function createWorkspaceRoutes(
  workspaceService: WorkspaceService,
  authService: AuthService,
  workflowService: IWorkflowService,
  eventBus: WorkflowEventBus,
  accessControl: IAccessControl,
  kbDirName: string,
  creatorAccess: ICreatorAccess,
  adminAccess: IAdminAccessService,
  disk: ITreeWalker,
  /** Save-time skill check: `PUT /file` on a SKILL.md answers with `warnings` (advisory, never a refusal). */
  skillSaveCheck?: SkillSaveCheck,
  /**
   * Read-before-write, asked ahead of the lock where a route puts bytes on
   * disk BEFORE it locks them (archive extraction). Every other route's writes
   * meet the same gate inside `acquireLock`. Optional so route harnesses that
   * exercise other behaviour need not wire it.
   */
  changeGate?: IChangeReadGate,
): express.Router {
  const router = express.Router();
  const gitInternalsRouteGuard = createGitInternalsRouteGuard(workspaceService);

  // The git folder is refused ahead of every route here by
  // `createGitInternalsRouteGuard`, which the app mounts once for the whole
  // `/workspace/:id` prefix (see `git-internals.middleware.ts`). Mounted here
  // too so this router carries the rule wherever it is mounted on its own.
  router.use("/workspace/:id", gitInternalsRouteGuard);

  /**
   * The REPOSITORY path a request names, or `null` once the refusal has been
   * sent.
   *
   * Every handler on this surface calls this FIRST, before the access check and
   * before the service, so one path is what is checked and what is written.
   * That was the hole: the access helpers stripped `<kbDirName>/` when it was
   * there and otherwise took the path as written, so an unprefixed
   * `KnowledgeBase/Reports` was judged as a repository path and then created
   * beside the repository — a folder, eight documents and a `Plugins/` tree on
   * core-staging, none of it ever committed. The normaliser closes it by making
   * the unprefixed spelling MEAN the repository path it was judged as.
   */
  function inRepo(res: express.Response, wsPath: string): string | null {
    try {
      return normalizeWorkspacePath(wsPath, kbDirName);
    } catch (err) {
      sendError(res, err);
      return null;
    }
  }

  /**
   * A repository path's absolute location, checked against the repository root.
   *
   * The ONE place this router resolves a workspace path — the delete fast-path,
   * the platform-restore look and the folder-keep all used to call
   * `path.resolve(workspaceDir, …)` for themselves, against the WORKSPACE dir,
   * which is the containment an unprefixed path satisfied on its way to being
   * written beside the checkout. A drift-guard test fails if a second one
   * appears.
   */
  async function absoluteInRepo(workspaceId: string, repoRelative: string): Promise<string> {
    const workspaceDir = await workspaceService.getWorkspacePath(workspaceId);
    const absolute = path.resolve(workspaceDir, repoRelative);
    assertWithinDirectory(absolute, path.join(workspaceDir, kbDirName));
    return absolute;
  }

  function authenticated(
    req: express.Request,
    res: express.Response,
  ): string | null {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return null;
    }
    const id = req.params.id;
    if (id !== undefined && typeof id !== 'string') {
      res.status(400).json({ error: 'Invalid workspace id' });
      return null;
    }
    return typeof id === 'string' ? id : '';
  }

  /**
   * Resolve `req.userId` to the full `AuthUser` record. Mirrors the helper
   * in `workflow.routes.ts` so file-mutation routes can pass the user into
   * `acquireLock`/`releaseLock` (which need name + email for commit
   * attribution). Returns `null` and writes the response if unauthenticated.
   */
  async function requireUser(
    req: express.Request,
    res: express.Response,
  ): Promise<AuthUser | null> {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return null;
    }
    try {
      const user = await authService.getUserById(req.userId);
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return null;
      }
      return user;
    } catch (err) {
      log.error('requireUser failed:', { err });
      res.status(500).json({ error: 'Internal server error' });
      return null;
    }
  }

  /**
   * Whether a failed op is one that provably touched no bytes, so its lock
   * may be released with the disk and the commit queue left exactly as they
   * are (`releaseLockUntouched`) rather than reset to HEAD.
   *
   * This is not tidiness. A release that discards resets the PATH, not "this
   * request's changes" — git has no notion of the latter — so when the path
   * holds a landed save whose commit is still queued (commits run out of band
   * in the pending-commits worker), the discard destroys that save. Two moves
   * racing onto the same free name are exactly that situation: the winner
   * lands and enqueues, the loser then takes the same destination lock, is
   * refused because the name is now taken, and its unwind would throw the
   * winner's file away. One refusal, two lost files.
   *
   * A destination-taken refusal qualifies because nothing it can do writes:
   * the preflight throws before the move is attempted, and the move's own
   * no-clobber calls (`link`, `mkdir`, `open` with `O_EXCL` — see
   * `shared/rename-no-replace.ts`) fail without creating anything, with the
   * folder claim rolling itself back. `LockingFilesystem.withLock` draws the
   * same line for its `CheckRefusal`, in the same words: a refusal that wrote
   * nothing releases untouched.
   *
   * Deliberately a closed list of refusal TYPES rather than a guess at what
   * an op did. An unrecognised failure keeps the discarding release, which is
   * the fail-closed side: at worst it throws away bytes nobody promised to
   * keep, where the other mistake throws away bytes someone was told were
   * saved.
   *
   * One type, not two: the move's lower-level `DestinationTakenError` never
   * reaches this layer — `moveEntry` converts it into `EntryExistsError`, the
   * refusal this surface answers 409 with — so recognising it here as well
   * would be a branch nothing can take.
   */
  function wroteNothing(err: unknown): boolean {
    return err instanceof EntryExistsError;
  }

  /**
   * Acquire the workflow lock for `(workspaceId, branch, targetPath)`, run
   * `op`, then release. Release commits + pushes the file as a one-file
   * change attributed to `user` — same pipeline the lock-aware filesystem
   * uses for the agent. Contention surfaces immediately as a 409-style
   * error rather than retrying: human-initiated routes should feel
   * responsive, and the caller will see "locked by X" and can decide what
   * to do next.
   *
   * The release runs in a `finally` so the op's own failure (e.g. validator
   * 422, access denied, path traversal) still releases the lock — otherwise
   * a single bad upload would hold a file hostage. When the op succeeded
   * but the file wasn't actually dirty (e.g. mkdir of an already-populated
   * dir), the release commits nothing and returns `null`.
   */
  async function withLock<T>(
    workspaceId: string,
    user: AuthUser,
    targetPath: string,
    op: () => Promise<T>,
    /**
     * Batch-mode option used by the recursive folder-delete branch: skip
     * the per-file `fs-tree-changed` so the caller can emit a single
     * tree-refresh signal at the end instead of N noisy ones. (The old
     * `skipPush` option is gone — under the queue model commits +
     * pushes happen out of band in the worker, not inline here.)
     */
    options?: {
      skipFsTreeEvent?: boolean;
      /**
       * This acquire is the destination side of an admin putting a misplaced
       * platform file back, coming from `source`. Passed straight to
       * `acquireLock`, which VERIFIES both halves — that the move is a restore
       * at all, and that this caller may make it — rather than believing
       * either. See the `IWorkflowService.acquireLock` contract.
       */
      platformRestore?: { source: string };
    },
  ): Promise<T> {
    const branch = branchForWorkspaceId(workspaceId);
    // If the caller already holds the lock, do NOT acquire-and-release
    // here. The editor's lock-aware path (frontend `saveAndRelease`)
    // explicitly manages the lock lifecycle — acquire on Edit, release
    // on Save — and calls PUT /file in between to persist bytes. If
    // this route auto-released after the write, the subsequent explicit
    // `releaseLockApi` would find the lock gone and 400. Detect that
    // case by reading the lock first; when the caller is the holder,
    // run the op without touching the lock and let the caller release
    // it on their own schedule (which is what fuses commit + push into
    // one atomic step the user explicitly triggered).
    const existing = await workflowService.getLock(workspaceId, branch, targetPath);
    if (existing && existing.holderUserId === user.id) {
      const result = await op();
      // Disk write landed but no commit yet (caller will release later,
      // at which point releaseLock fires its own `file-changed` with a
      // real `newSha`). Emit a null-sha file-changed now so any other
      // session tailing this file refetches the latest bytes immediately
      // instead of waiting for the eventual release.
      eventBus.emit({
        kind: 'file-changed',
        workspaceId,
        branch,
        path: targetPath,
        newSha: null,
        byUserId: user.id,
        byUserName: user.name,
      });
      // Also signal "the file tree may have changed" — covers create /
      // delete / rename through this same path so sidebars refresh even
      // when no specific open tab matches the path.
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId, branch });
      return result;
    }
    const acquired = await workflowService.acquireLock(workspaceId, branch, targetPath, user, {
      platformRestore: options?.platformRestore,
    });
    if (!acquired.acquired) {
      const holder = acquired.lock.holderName || 'another user';
      const err: Error & { status?: number } = new Error(
        `"${targetPath}" is being edited by ${holder}. Try again in a moment.`,
      );
      err.status = 409;
      throw err;
    }
    // Three release modes, the same three `LockingFilesystem.withLock` uses,
    // depending on what the op did:
    //
    //   - op() FAILED having possibly WRITTEN → drop the lock WITHOUT
    //     enqueueing a commit. The op may have written partial bytes to disk
    //     before throwing (write that errored mid-stream, etc.). A normal
    //     `releaseLock` would enqueue a commit for whatever's on disk and the
    //     worker would silently persist that partial state as a real
    //     committed change. `releaseLockNoCommit` resets the path to HEAD, so
    //     partial bytes never become a committed change with the user's name
    //     on it.
    //
    //   - op() FAILED having written NOTHING → `releaseLockUntouched`: drop
    //     the lock row and leave both the disk and the commit queue exactly
    //     as they are. See `wroteNothing` for which refusals qualify and why
    //     the distinction is load-bearing rather than tidy.
    //
    //   - op() SUCCEEDED → release. The new releaseLock enqueues a
    //     pending-commit row (the actual `commitFile + push` runs out
    //     of band in the worker) and drops the lock immediately. We
    //     return success once disk + lock + enqueue are all done —
    //     the user-visible "save = share" guarantee is satisfied by
    //     the shared per-branch workspace, not by waiting on git.
    let opSucceeded = false;
    let result: T;
    try {
      result = await op();
      opSucceeded = true;
    } catch (err) {
      const untouched = wroteNothing(err);
      try {
        if (untouched) {
          await workflowService.releaseLockUntouched(workspaceId, branch, targetPath, user);
        } else {
          await workflowService.releaseLockNoCommit(workspaceId, branch, targetPath, user);
        }
      } catch (releaseErr) {
        log.warn(
          `${untouched ? 'releaseLockUntouched' : 'releaseLockNoCommit'} failed after op error for "${targetPath}":`,
          { err: releaseErr },
        );
      }
      throw err;
    }
    if (!opSucceeded) {
      // Unreachable — `opSucceeded` is set unconditionally after `op()`
      // returns and the catch arm above always rethrows. Keeping the
      // explicit branch makes the intent obvious to readers.
      throw new Error('unreachable: opSucceeded false after try');
    }
    await workflowService.releaseLock(workspaceId, branch, targetPath, user);
    // Signal sidebar / explorer to refresh even when no open tab matched
    // the changed path (e.g. someone else just created a new file).
    // `releaseLock` already fires `file-changed` for the path, but
    // file-changed's frontend handler short-circuits when no matching tab
    // exists. fs-tree-changed is the dedicated structural-change signal.
    //
    // The folder-delete batch suppresses this per-file emit and fires a
    // single `fs-tree-changed` after the loop, cutting ~30 redundant tree
    // refreshes down to 1 for a 30-file folder delete.
    if (!options?.skipFsTreeEvent) {
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId, branch });
    }
    return result;
  }

  /**
   * Keep the folder a removal just emptied. A folder exists until it is
   * deleted explicitly, so when deleting a file (or a subfolder), or moving
   * one out, leaves its parent empty, the parent gets the placeholder in its
   * own lock cycle — committed like any other save, within the same request.
   * Only folders inside the repository qualify, never the clone folder
   * itself.
   *
   * It runs in the folder's turn, which an explicit folder delete also takes,
   * and looks again inside it: a folder that is gone by then was deleted
   * explicitly and stays gone, and one that gained an entry needs nothing.
   * The placeholder is only ever written into a folder that exists, and never
   * through a link (see `writeFolderPlaceholder`).
   *
   * A failure is the request's failure: the removal landed, but a request
   * that answers success would leave a folder that vanishes on the next
   * clone, which is exactly what this rule forbids. It keeps its own status
   * (a contended placeholder lock is still a 409) and only gains the context.
   */
  async function keepFolderOf(
    workspaceId: string,
    user: AuthUser,
    removedPath: string,
  ): Promise<void> {
    const trimmed = removedPath.replace(/\/+$/, '');
    const dir = trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/')) : '';
    if (!dir.startsWith(`${kbDirName}/`)) return;
    try {
      const absolute = await absoluteInRepo(workspaceId, dir);
      await workspaceService.withFolderTurn(workspaceId, dir, async () => {
        if (!(await isEmptyFolder(absolute))) return;
        // One tree refresh per request: the removal already announced it.
        await withLock(
          workspaceId,
          user,
          folderPlaceholderPath(dir),
          () => workspaceService.writeFolderPlaceholder(workspaceId, dir),
          { skipFsTreeEvent: true },
        );
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`could not keep the folder ${printable(dir)} after removing ${printable(removedPath)}: ${printable(reason)}`);
      throw withKeptFolderContext(err, `"${removedPath}" was removed, but its folder "${dir}" could not be kept: ${reason}`);
    }
  }

  /**
   * Map any thrown error to an HTTP response. Centralises the response
   * shape so each route handler stays focused on its own logic.
   *   - `WorkflowDomainError` → its `.status` + `.payload` (a traversal is a
   *     403, an invalid path a 400, an unreadable archive a 422 — each by
   *     its TYPE; this surface used to recognise all three by their message)
   *   - Anything else with a `.status` → that status
   *   - Default → 500
   */
  function sendError(res: express.Response, err: unknown): void {
    if (err instanceof WorkflowDomainError) {
      res.status(err.status).json(domainErrorBody(err));
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const status = (err as { status?: number } | null)?.status;
    if (typeof status === 'number') {
      res.status(status).json({ error: msg });
      return;
    }
    res.status(500).json({ error: msg });
  }

  // GET /api/workspace[?branch=<branch>]
  // Bootstrap (or fetch) the workspace for a branch. Defaults to the
  // platform's working branch when no `branch` query param is given —
  // matches the previous "just give me a workspace" behavior except now
  // the workspace is keyed by branch instead of by user.
  router.get('/workspace', async (req, res) => {
    try {
      if (!req.userId) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const user = await authService.getUserById(req.userId);
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }
      const branch = typeof req.query.branch === 'string' && req.query.branch.length > 0
        ? req.query.branch
        : DEFAULT_BRANCH;
      const workspace = await workspaceService.getOrCreateForBranch(branch);
      // Bootstrap must use the same read-filtered tree as GET /workspace/:id/files.
      // Otherwise the first sidebar render can expose restricted nodes until the
      // next explicit tree refresh, and clicking one then correctly 403s.
      const fileTree = await workspaceService.listFiles(
        workspace.id,
        buildTreeReadFilter(workspace.id, user.email),
      );
      res.json({ workspace, fileTree });
    } catch (error) {
      // A typed domain answer — a branch origin no longer has (410), a name
      // git refuses (400) — is the client's to act on, not a failure of ours;
      // it keeps its status so the browser can say what happened.
      if (error instanceof WorkflowDomainError) {
        sendError(res, error);
        return;
      }
      // Log the full stack so the next 500 isn't a guessing game — the
      // bare `error.message` we returned before lost most diagnostic
      // signal (cause chain, stack frames, error class).
      log.error(`GET /workspace failed branch=${req.query.branch ?? '(default)'}:`, { err: error });
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/workspace/:id', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    try {
      await workspaceService.deleteWorkspace(id);
      res.json({ status: 'deleted' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  router.get('/workspace/:id/files', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      const fileTree = await workspaceService.listFiles(id, buildTreeReadFilter(id, user.email));
      res.json(fileTree);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  // Every `.md` under the KB repo, keyed by repo-root path, in one response.
  // The HTML renderer's `buildGraph()` bridge uses this instead of one fetch
  // per file (the KB is thousands of files — per-file fetching exhausts the
  // browser's connection pool: net::ERR_INSUFFICIENT_RESOURCES).
  router.get('/workspace/:id/kb-files', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      const files = await workspaceService.readAllKbFiles(id);
      // Keys are repo-relative KB-node paths — gate them with the FULL read
      // check (per-node frontmatter honoured, matching the embed graph). The
      // graph is fetched rarely, so the per-file cost is acceptable here. Drop
      // every node the caller can't read; fail-closed on anything not allowed.
      const keys = Object.keys(files);
      const verdict = await accessControl.canReadBatch(id, user.email, keys);
      const filtered: Record<string, string> = {};
      for (const k of keys) {
        if (verdict.get(k) === true) filtered[k] = files[k]!;
      }
      res.json({ files: filtered });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  // (The KB-graph read routes — `/workspace/:id/graph`, `/resolve-id`,
  // `/resolve-path` — moved to `modules/kb-graph/kb-graph.routes.ts`: they
  // are enterprise surfaces over the kb-graph service, mounted by the
  // enterprise server extension. Same paths, so the frontend is unchanged.)

  /**
   * Gate a download request on the dedicated `Download` role from roles.yaml.
   * Returns `true` if the request was authorised (the caller proceeds);
   * returns `false` if a response was already sent (401 / 403 / 500) and the
   * caller should bail. Centralised so the file and folder download routes
   * can't drift on the check, the role name, or the error wording.
   *
   * Orthogonal to admin: a user listed in `Admin` does NOT implicitly get
   * Download. The two roles are independent grants in roles.yaml.
   *
   * `hasRole` can throw `AccessConfigError` when `roles.yaml` / `access.md`
   * fails to load (missing role refs, malformed YAML). Without a catch the
   * async rejection bubbles past Express and the request hangs. Route it
   * through `sendError` so the rich `WorkflowDomainError` payload (status +
   * `accessConfigErrors`) surfaces to the caller — same shape the
   * `/access/has-role` endpoint returns.
   */
  async function requireDownloadPermission(
    req: express.Request,
    res: express.Response,
    workspaceId: string,
    relativePath: string,
  ): Promise<boolean> {
    const user = await requireUser(req, res);
    if (!user) return false;
    let allowed: boolean;
    try {
      // `download` is a per-path verb in access.md, resolved via the same
      // chain walk as `write`. The caller has already normalised the path into
      // the repository, so this only takes the prefix off — where it used to
      // pass an unprefixed path through untouched and judge a stray as if it
      // were inside.
      const repoRelative = toKbRelative(relativePath, kbDirName) ?? relativePath;
      allowed = await accessControl.canDownload(workspaceId, user.email, repoRelative);
    } catch (err) {
      sendError(res, err);
      return false;
    }
    if (!allowed) {
      res.status(403).json({ error: 'Download permission required' });
      return false;
    }
    return true;
  }

  /**
   * Gate a content read on the `read:` verb. Returns `true` if the caller may
   * read `relativePath`; otherwise sends a 403 and returns `false`. Uses the
   * FULL `canRead` (per-node frontmatter honoured) — this is a single-file
   * check, so the per-file read is cheap. Maps the workspace-relative path to
   * its KB-repo-relative form via the shared `toKbRelative`; a path outside the
   * KB repo (reserved workspace files, the KB dir itself) carries no `read:`
   * rules and is never gated — matching the agent tools and diff routes. `read`
   * is default-deny: a KB path must have an effective read grant, such as
   * `read: everyone`, a listed role/user, or an owner grant. Errors fail closed.
   */
  async function requireReadPermission(
    req: express.Request,
    res: express.Response,
    workspaceId: string,
    relativePath: string,
  ): Promise<boolean> {
    const user = await requireUser(req, res);
    if (!user) return false;
    let allowed: boolean;
    try {
      allowed = await canReadWorkspacePath(
        (w, e, p) => accessControl.canRead(w, e, p),
        workspaceId,
        user.email,
        kbDirName,
        relativePath,
      );
    } catch (err) {
      sendError(res, err);
      return false;
    }
    if (!allowed) {
      res.status(403).json({ error: `You don't have permission to read "${relativePath}".` });
      return false;
    }
    return true;
  }

  /**
   * Build the file-tree read filter for `userEmail`: a per-directory batched
   * verdict over workspace-relative paths, backed by the FULL `canReadBatch`
   * — folder `access.md` chain AND each node's own frontmatter, so the tree
   * shows exactly what the content routes will let the user open (a
   * frontmatter `read:` deny hides the file; a frontmatter grant makes it
   * discoverable). The per-file frontmatter reads are memoized inside the
   * access service (invalidated on commit/pull/switch), so repeat tree builds
   * don't re-walk the disk. Returns undefined-free `ReadTreeFilter`;
   * `listFiles(id)` with no filter is the unfiltered (pre-feature) behaviour
   * for callers that don't gate.
   */
  function buildTreeReadFilter(workspaceId: string, userEmail: string): ReadTreeFilter {
    return async (wsRelPaths) => {
      const verdict: Map<string, boolean | 'unlisted'> = await resolveReadableMap(
        (w, e, rels) => accessControl.canReadBatch(w, e, rels),
        workspaceId,
        userEmail,
        kbDirName,
        wsRelPaths,
      );
      // The structural top-level folders are always shown as folders, even to
      // a user who can't read into them. Their existence isn't sensitive
      // (every KB has them), and keeping them visible lets the explorer render
      // its Knowledge/Plugins section view instead of collapsing to an empty
      // flat tree. A ROOT-LEVEL `Knowledge/` is the legacy pre-split layout's
      // knowledge root (kb-layout.ts calls it the neutral bucket) and gets the
      // same treatment so legacy clones don't collapse. Only the folders
      // themselves are forced visible — their contents stay gated by the
      // verdict above.
      const structuralRoots = new Set([...reservedRootDirNames(), KNOWLEDGE_DIR]);
      for (const wp of wsRelPaths) {
        const rel = toKbRelative(wp, kbDirName);
        if (rel !== null && structuralRoots.has(rel)) verdict.set(wp, true);
      }

      // `.bevelignore` is ADMIN-ONLY. It is the file that decides what the file
      // tree and the agent view show at all, so it is deployment configuration
      // rather than knowledge — and it sits alone in being visible: its
      // siblings (`.gitignore`, `roles.yaml`, `access.md`, the agent guide) are
      // already hidden from every reader by the shipped ignore rules. Somebody
      // who cannot act on it gains a puzzle; somebody who can needs to reach it.
      //
      // Read permission is deliberately NOT the lever. Everyone can read it —
      // it has to be readable to be applied — so hiding it is a listing
      // decision, made here, rather than an ACL fiction maintained in a file.
      //
      // Resolved through `AdminAccessService` rather than by asking whether
      // this caller can write `roles.yaml` in THIS workspace: admin is settled
      // on the default branch precisely so that editing `roles.yaml` on your
      // own branch cannot promote you, and the same reasoning applies to
      // anything gated on being an admin.
      //
      // `'unlisted'`, not `false`: hiding it withholds no content, so a
      // non-admin in an empty knowledge base (every one ships this file) is
      // told it is empty, not that something is being kept from them.
      const ignoreFiles = wsRelPaths.filter((wp) => path.basename(wp) === IGNORE_FILENAME);
      if (ignoreFiles.length > 0 && !(await adminAccess.isAdmin(userEmail))) {
        for (const wp of ignoreFiles) verdict.set(wp, 'unlisted');
      }
      return verdict;
    };
  }

  /**
   * Land a `seed-access-md` creation-grant plan: merge the grant into the new
   * directory's `access.md` through the same lock+commit cycle as any other
   * save, then drop the resolver cache so the very next tree build sees the
   * grant. The current bytes are re-read UNDER the lock and the grant spliced
   * into them — never a blind overwrite, so a concurrent creator's just-landed
   * grant on the same new directory survives. Runs BEFORE the creation itself
   * so the explorer never shows-then-hides the new subtree; if the creation
   * subsequently fails, the leftover is an empty new folder readable only by
   * its creator.
   *
   * A failure here FAILS the creation, and propagates as it is. The seed is
   * planned only for a new folder at a root the creator cannot read — the one
   * creation the read gate lets past an unreadable spot — so without the
   * grant the folder would come into existence invisible to the person who
   * made it, which is exactly what the gate exists to prevent. The seed's
   * own lock passes that gate too: if the folder appeared under someone else
   * between the plan and this write, the refusal is theirs to see, and
   * nothing lands.
   */
  async function seedCreatorAccessMd(
    workspaceId: string,
    user: AuthUser,
    plan: { wsRelPath: string; apply: (current: string) => string },
  ): Promise<void> {
    await withLock(workspaceId, user, plan.wsRelPath, async () => {
      let current = '';
      try {
        current = await workspaceService.readFile(workspaceId, plan.wsRelPath);
      } catch {
        // Not there yet — the normal case for a brand-new directory.
      }
      const next = plan.apply(current);
      if (next !== current) {
        await workspaceService.writeFile(workspaceId, plan.wsRelPath, next);
      }
    });
    creatorAccess.noteAccessFileWritten(workspaceId);
  }

  /**
   * GET /workspace/:id/file/raw?path=<file>[&download=1][&v=<n>]
   *
   * The bytes of one workspace file: for the document renderers' fetches, the
   * file tree's Download, and the `<img>` tags the markdown pipeline emits for
   * `![alt](./assets/x.png)`. An `<img>` sends no Authorization header, so it
   * is the auth middleware's `bevel_token` cookie fallback that lets a plain
   * image tag through.
   *
   *   request ──▶ auth: Bearer, else the cookie
   *           ──▶ read gate on the path             403 if the caller may not read it
   *           ──▶ download gate, if ?download=1     403 without the download: verb
   *           ──▶ readFileBinary                    404 missing, 403 traversal
   *           ──▶ Content-Type from the extension, nosniff, a CSP sandbox for
   *               inline svg, attachment disposition for a download, and
   *               Cache-Control: private, no-cache
   *           ──▶ res.send(buffer): Express sets a weak ETag and answers 304 to
   *               a matching If-None-Match, so a revisited page costs a read
   *               and a hash per image rather than the bytes on the wire
   *
   * `?v=` is not read here. The frontend bumps it when it learns an image
   * changed, so the browser asks for a URL it has not cached.
   */
  router.get('/workspace/:id/file/raw', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const requested = req.query.path;
    if (typeof requested !== 'string' || requested.length === 0) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const filePath = inRepo(res, requested);
    if (filePath === null) return;
    // `?download=1` flips this from inline-serve (used by PdfRenderer and
    // the image renderers) to "save to disk" — and the save path is gated
    // on per-path `download:` rules in access.md. The inline path stays
    // open to any authenticated user so the PdfRenderer / image renderers
    // keep working for everyone.
    // Read gate first — inline serve (PdfRenderer/image renderers) was open to
    // any authenticated user; now a node the caller can't read is 403'd whether
    // or not `?download=1` is set. Download additionally needs the `download:` verb.
    if (!(await requireReadPermission(req, res, id, filePath))) return;
    const wantsDownload = req.query.download === '1';
    if (wantsDownload) {
      if (!(await requireDownloadPermission(req, res, id, filePath))) return;
    }
    try {
      const buffer = await workspaceService.readFileBinary(id, filePath);
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.pdf': 'application/pdf',
        '.docx':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
      // SVG is active web content (it can carry <script>), and it is active in
      // BOTH directions: a saved-to-disk SVG re-opened later runs its scripts
      // under the file:// origin, so a download is forced to octet-stream.
      const downloadMime = ext === '.svg' ? 'application/octet-stream' : (mimeTypes[ext] || 'application/octet-stream');
      res.setHeader('Content-Type', wantsDownload ? downloadMime : (mimeTypes[ext] || 'application/octet-stream'));
      // Block MIME-sniffing so a misdeclared file can't be promoted to
      // active content by the browser.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // …and inline is a DOCUMENT the moment somebody opens this URL in a tab
      // directly, where those scripts would run under THIS
      // origin with this user's session — stored XSS for anyone who can write
      // a file into the workspace. `sandbox` drops the document into a unique
      // origin with scripting off. It applies to documents only, so the
      // renderers' fetch → blob → <img> path is untouched, and that path is
      // why the type stays `image/svg+xml`: browsers do not sniff SVG, and an
      // octet-stream blob would simply not render.
      if (!wantsDownload && ext === '.svg') {
        res.setHeader('Content-Security-Policy', 'sandbox');
      }
      if (wantsDownload) {
        // RFC 5987 UTF-8 filename encoding so unicode + spaces round-trip;
        // CR/LF stripped to block header injection via a crafted path.
        const basename = (filePath.split('/').pop() || 'file').replace(/[\r\n]/g, '');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(basename)}`,
        );
      }
      // `private`: this is one person's authenticated file, and a shared cache
      // (a CDN, a corporate proxy) must not hand it to the next person.
      // `no-cache`: the browser may keep it but asks before reusing it, which
      // the ETag answers with a 304; a picture replaced under the same name is
      // therefore never older than one revalidation.
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(buffer);
    } catch (error) {
      // A traversal is the caller's 403; every other read failure here is the
      // route's honest 404 (the image either is not there or cannot be shown).
      if (error instanceof PathTraversalError) {
        sendError(res, error);
        return;
      }
      res.status(404).json({ error: 'File not found' });
    }
  });

  /**
   * GET /workspace/:id/folder/zip?path=<folder>&download=1
   *
   * Build a zip of the folder (respecting the file tree's skip rules: no
   * `.git/`, no `.gitkeep`, no `.bevelignore`d paths) and return it as an
   * attachment. Gated on `download:` access on the folder path — same
   * primitive as the file-download path. Entries inside the archive are
   * prefixed with the folder name so unzipping produces `<folderName>/…`
   * rather than spilling into the caller's working directory.
   *
   * `?download=1` is required to keep the URL shape consistent with the file
   * route — a stray inline request would have no other meaningful behavior
   * for a folder anyway.
   */
  router.get('/workspace/:id/folder/zip', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    // Reject array-shaped queries (`?path=a&path=b` → ['a','b']) and
    // non-string values explicitly — the old `as string` cast was a lie
    // and would crash on the downstream `.split('/')`.
    const rawPath = req.query.path;
    if (typeof rawPath !== 'string') {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    // Trim whitespace and strip trailing slashes — `foo/` would otherwise
    // basename to `''` and produce a misleading `.zip` filename. Done
    // before the empty check so `' / '` is also caught.
    const trimmedPath = rawPath.trim().replace(/\/+$/, '');
    if (!trimmedPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const folderPath = inRepo(res, trimmedPath);
    if (folderPath === null) return;
    if (req.query.download !== '1') {
      res.status(400).json({ error: 'download=1 is required for folder zip downloads' });
      return;
    }
    if (!(await requireDownloadPermission(req, res, id, folderPath))) return;
    try {
      const buffer = await workspaceService.createFolderZip(id, folderPath);
      // `|| 'folder'` covers the edge case where `folderPath` itself was
      // a single bare slash (`/`) that survived the trim — the service
      // would still reject it as path traversal, but the basename
      // default keeps the response sane if it ever gets here.
      const basename = (folderPath.split('/').pop() || 'folder').replace(/[\r\n]/g, '');
      const zipName = `${basename}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      );
      res.send(buffer);
    } catch (error) {
      if (error instanceof FolderTooLargeError) {
        res.status(413).json({ error: error.message });
        return;
      }
      if (error instanceof PathTraversalError) {
        sendError(res, error);
        return;
      }
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg === 'Not a directory') {
        res.status(400).json({ error: msg });
        return;
      }
      // ENOENT / other fs errors → 404 (matches the file route's fallback).
      res.status(404).json({ error: 'Folder not found' });
    }
  });

  router.get('/workspace/:id/file', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const requested = requestPath(req.query.path);
    if (requested === null) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const filePath = inRepo(res, requested);
    if (filePath === null) return;
    if (!(await requireReadPermission(req, res, id, filePath))) return;
    try {
      const content = await workspaceService.readFile(id, filePath);
      // No-store: this endpoint is used by the live-refresh path after a
      // teammate's save (file-changed SSE → refetch). A cached response
      // would yield stale bytes and silently defeat the auto-refresh.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.json({ content });
    } catch (error) {
      // 404 means ONE thing here: there is no file at this path. That is
      // ENOENT, a parent that is not a directory (ENOTDIR), and a directory
      // asked for as a file (EISDIR). Every other read failure keeps its own
      // status, because callers act on the difference: the inline
      // agent-description editor opens EMPTY on a 404 (a knowledge base older
      // than the template has no such file yet), so dressing an unreadable
      // file up as a missing one would offer an empty editor over content the
      // save then overwrites.
      if (isAbsence(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      // Traversal stays a 403 and a malformed workspace id its domain status:
      // both carry messages written to be read by the caller. (A traversal IS
      // a domain error now, so the one check covers both.)
      if (error instanceof WorkflowDomainError) {
        sendError(res, error);
        return;
      }
      // Anything else is a real failure, and it says so WITHOUT quoting
      // itself: an errno message carries absolute workspace paths and a
      // bootstrap failure carries git's stderr, neither of which belongs in a
      // response body. The distinction this route exists to make is still
      // made — an unreadable file is not a missing one — it is just not
      // narrated to the client.
      log.warn(`GET /file failed for "${filePath}" in "${id}":`, { err: error });
      res.status(500).json({ error: "Couldn't read the file." });
    }
  });

  router.delete('/workspace/:id/file', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const requested = requestPath(req.query.path);
    if (requested === null) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const filePath = inRepo(res, requested);
    if (filePath === null) return;
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      // Recursive dir delete decomposes into N per-file lock+commit cycles
      // — each file lands as its own one-file change so the per-file
      // commit-history invariant `GitService.commit` enforces still holds.
      // What we DO batch is the push: instead of N round-trips to origin
      // (the dominant cost — a 30-file folder previously took 30+s of
      // sequential pushes), we run each release with `{ skipPush: true }`
      // and call `pushBranch` once at the end. Per-file `fs-tree-changed`
      // emits are also coalesced into a single end-of-batch event so the
      // explorer doesn't refresh N times.
      const workspaceDir = await workspaceService.getWorkspacePath(id);
      // Boundary check before any `fs.*` call — against the REPOSITORY root,
      // which is where `absoluteInRepo` holds it. The single-file path bottoms
      // out in `workspaceService.deleteFile` (which resolves inside the
      // repository itself), but this fast-path needs the absolute for
      // `fs.stat` / `fs.rm` / `enumerateFilesUnder`.
      const absolute = await absoluteInRepo(id, filePath);
      let stat: { isDirectory: () => boolean } | null = null;
      try {
        stat = await fs.stat(absolute);
      } catch {
        // Not on disk — let workspaceService.deleteFile return its own 404.
      }
      if (stat?.isDirectory()) {
        const branch = branchForWorkspaceId(id);
        // In the folder's turn: keeping a folder under this one (a file delete
        // racing this one) waits until the sweep is done, and then finds the
        // folder gone instead of writing it back.
        let filesInDir: string[];
        try {
          filesInDir = await workspaceService.withFolderTurn(id, filePath, async () => {
            const files = await enumerateFilesUnder(disk, absolute, workspaceDir);
            for (const relFile of files) {
              await withLock(
                id,
                user,
                relFile,
                async () => {
                  await workspaceService.deleteFile(id, relFile);
                },
                { skipFsTreeEvent: true },
              );
            }
            // No explicit push here — each per-file release enqueues a
            // pending-commits row, and the background worker drains them
            // (commit + push) on its own schedule. The N round-trips that
            // the old skipPush+pushBranch pattern collapsed into one happen
            // serially in the worker; user perception is unchanged because
            // the disk-side delete is what other sessions see via
            // `fs-tree-changed`.
            // This is the EXPLICIT folder delete — the one operation that removes
            // a folder — so the walk above deleted the placeholders too, and the
            // now-empty directory subtree is swept off disk. Git doesn't track
            // empty folders, so there's nothing more to commit; this is disk
            // hygiene so the file tree stops showing the deleted containers.
            //
            // This MUST recurse: a folder that held *subfolders* still has those
            // (now-empty) subdirectory shells on disk after the per-file deletes,
            // so a single non-recursive `rmdir(absolute)` would see a non-empty
            // dir and bail — leaving the folder visible in the tree and looking
            // undeletable (BEVA-132). `removeEmptyDirs` walks bottom-up and only
            // removes dirs that are *actually empty* at the moment it visits them,
            // so a concurrent writer's new file (and its parent chain) is
            // preserved — the same safety property the old non-recursive check had.
            try {
              await removeEmptyDirs(absolute);
            } catch (rmErr) {
              // Directory already gone (raced delete), or a concurrent writer
              // repopulated it. Either way, skip removal — the per-file deletes
              // are what's load-bearing.
              const reason = rmErr instanceof Error ? rmErr.message : String(rmErr);
              log.warn(`dir cleanup skipped for ${printable(filePath)}: ${printable(reason)}`);
            }
            return files;
          });
          // The folder that HELD the deleted one was not asked to go.
          await keepFolderOf(id, user, filePath);
        } finally {
          // Single tree-refresh signal for the whole batch (we suppressed
          // the per-file ones via `skipFsTreeEvent`) — sent on failure too:
          // a batch that stops part way, or a parent that could not be kept,
          // has still changed the tree.
          eventBus.emit({ kind: 'fs-tree-changed', workspaceId: id, branch });
        }
        res.json({ status: 'deleted', count: filesInDir.length });
        return;
      }
      await withLock(id, user, filePath, () => workspaceService.deleteFile(id, filePath));
      // Deleting content is not deleting structure: an emptied folder stays.
      await keepFolderOf(id, user, filePath);
      res.json({ status: 'deleted' });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch('/workspace/:id/file', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const body = (req.body ?? {}) as { oldPath?: unknown; newPath?: unknown };
    const requestedOld = requestPath(body.oldPath);
    const requestedNew = requestPath(body.newPath);
    if (requestedOld === null || requestedNew === null) {
      res.status(400).json({ error: 'oldPath and newPath are required in body' });
      return;
    }
    // Both ends inside the repository before anything is judged: the platform-file
    // rules, the locks and the rename all read the same two paths.
    const oldPath = inRepo(res, requestedOld);
    if (oldPath === null) return;
    const newPath = inRepo(res, requestedNew);
    if (newPath === null) return;
    // Two spellings of one file are now ONE path, so a move can arrive with
    // both ends equal. `withLock` below would survive it — the inner
    // acquisition sees the lock the outer just took, held by this same user,
    // and runs straight through — but the move itself is a rename onto
    // itself that commits a change and tells the diff service the path was
    // both deleted and rewritten. It is a client mistake, so it is a 400.
    if (oldPath === newPath) {
      res.status(400).json({ error: 'oldPath and newPath must differ' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      // A platform file stays in the folder the platform reads it from —
      // rename, move and drag all arrive here, and all three are refused.
      // Moving one out is not a choice to confirm: once the root has no
      // `access.md`, write on the root denies everyone and the move that
      // would undo it is the move the gate refuses.
      //
      // The single exception is that repair: an admin putting a misplaced
      // copy BACK. `isPlatformRestoreShape` says whether the MOVE is that
      // repair — it is judged on the source's name and the destination, not
      // on the source being a platform file where it currently sits, because
      // a stray `roles.yaml` in a folder is ordinary content there and is
      // still the copy the root is missing. `canRestorePlatformFile` then
      // decides who may make it, and whether the disk agrees.
      const oldRel = toKbRelative(oldPath, kbDirName);
      const newRel = toKbRelative(newPath, kbDirName);
      let platformRestore = false;
      if (oldRel !== null && newRel !== null && isPlatformRestoreShape(oldRel, newRel)) {
        platformRestore = await accessControl.canRestorePlatformFile(id, user.email, newRel);
      }
      // A platform file stays where the platform reads it …
      if (oldRel !== null && isPlatformFile(oldRel) && !platformRestore) {
        res.status(409).json({ error: platformFileRefusal(oldRel) });
        return;
      }
      // … and nothing else becomes one. `moveEntry` is a plain rename, so
      // without this a note renamed to `access.md` would come back as the
      // folder's rules, and a note dragged ONTO the root's `access.md` would
      // replace the rules that are there — neither of which the rule above,
      // which reads only the SOURCE, says anything about. The agent's move
      // tool has refused both since it shipped; this is the same sentence,
      // from the same place. Only the restore lands on a platform path, and
      // only where the file is missing (`canRestorePlatformFile` checked the
      // disk; the destination lock below checks it again, under the lock).
      if (newRel !== null && isPlatformFile(newRel) && !platformRestore) {
        res.status(409).json({ error: platformFileCreationRefusal(newRel) });
        return;
      }
      // Move = rename on disk + commit on both sides. We lock-and-release
      // the destination first (commits the new file's appearance), then
      // lock-and-release the source path (commits its deletion). Two
      // commits rather than one — git's rename detection only kicks in
      // when both delete and create are staged together, and the current
      // `commitFile` is single-path. Lossy w.r.t. rename history, but
      // correct: the file ends up where it should and history shows both
      // ends of the move.
      // Acquire BOTH locks before the move so no other writer can grab
      // the source path under us during the rename window. We hold them
      // simultaneously by nesting `withLock` calls. The lock order is
      // lexical (the same deterministic order used in
      // `LockingFilesystem.moveFile`) so two concurrent moves on the
      // same pair of paths can never deadlock by acquiring in opposite
      // orders. The actual move runs inside the innermost callback;
      // the unwind commits each side's release in reverse order, which
      // produces two single-file commits (one create, one delete) —
      // not a single merge-style rename commit, but git's log/blame
      // rename detection still groups them visually after the fact.
      const [firstLock, secondLock] = oldPath < newPath ? [oldPath, newPath] : [newPath, oldPath];
      // Only the DESTINATION side carries the restore claim. The source is an
      // ordinary write the caller must already hold: the exception exists so a
      // file can land where the platform reads it, not so an admin can take
      // one out of a folder that denies them.
      const restoreAt = (p: string) => ({
        platformRestore: platformRestore && p === newPath ? { source: oldPath } : undefined,
      });
      // The restore was authorised against a destination that was missing when
      // the access module looked. Both locks are in hand by the time this runs,
      // so nothing else can take that path from under the rename — but between
      // the two a writer still could, and a restore that lands on a platform
      // file replaces the rules it came to bring back. So the last thing the
      // move does before renaming is look again, inside the window it holds.
      const move = async () => {
        if (platformRestore) {
          const absoluteNew = await absoluteInRepo(id, newPath);
          const taken = await fs.stat(absoluteNew).then(
            () => true,
            // Genuine absence is the only "free": anything else is not an
            // answer, and an unanswered question does not clear the way onto
            // a platform file.
            (err: unknown) => !isAbsence(err),
          );
          if (taken) {
            const err: Error & { status?: number } = new Error(platformFileRefusal(newPath));
            err.status = 409;
            throw err;
          }
        }
        return workspaceService.moveEntry(id, oldPath, newPath);
      };
      await withLock(
        id,
        user,
        firstLock,
        () => withLock(id, user, secondLock, move, restoreAt(secondLock)),
        restoreAt(firstLock),
      );
      // Moving the last entry out leaves its folder in place, like a delete.
      await keepFolderOf(id, user, oldPath);
      res.json({ status: 'moved' });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/workspace/:id/file', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    // ONE spelling of the target from here down. `x/a.md`, `./x/a.md` and
    // `x//a.md` are the same file and all pass the path validator, and this
    // route coordinates on that path three times over: the in-process write
    // turn, the workflow lock row, and the bytes themselves. Two clients
    // spelling one file differently would otherwise take two different locks
    // and both pass their own precondition.
    const requested = requestPath(req.query.path);
    if (requested === null) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const filePath = inRepo(res, requested);
    if (filePath === null) return;
    const { content, ifAbsent, ifMatch } = req.body as {
      content?: string;
      ifAbsent?: boolean;
      ifMatch?: unknown;
    };
    if (content === undefined) {
      res.status(400).json({ error: 'content is required in body' });
      return;
    }
    if (ifMatch !== undefined && typeof ifMatch !== 'string') {
      res.status(400).json({ error: 'ifMatch, if provided, must be a string' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    // A precondition ANSWERS A QUESTION ABOUT CONTENT, so it is gated on
    // READING, not writing. Write authorisation happens at `acquireLock`
    // inside `withLock` below, which is after the compare: without this gate
    // the 409-versus-403 difference is a content-equality oracle on a file the
    // caller may not read, and the confirming case is a write. Same gate and
    // same 403 as `GET /file`; a caller who may write but not read can still
    // save, just not ask questions about what is there.
    if (ifMatch !== undefined && !(await requireReadPermission(req, res, id, filePath))) return;
    try {
      // Refuse a hand-edit that would leave roles.yaml unparseable BEFORE any
      // byte hits disk — a broken roles.yaml is an app-wide admin lockout
      // (loadModel hard-throws). The dedicated App roles surface has its
      // own validate gate; this covers the raw-text editor path.
      if (isRolesYamlPath(filePath, kbDirName)) assertRolesYamlParsable(content);
      // One turn for the whole sequence, because the DECISION spans three
      // steps that must agree about the same file: check the precondition,
      // plan a creator-access grant that COMMITS, then write. A save landing
      // in between would leave that grant behind for a write about to be
      // refused, so the check is made here, before the plan, and nothing else
      // in this process may touch the path until the write is done. The write
      // inside takes the same turn re-entrantly.
      //
      // Across instances the workflow lock below is still the coordinator;
      // this only orders what this server is doing.
      await workspaceService.withPathTurn(id, filePath, async () => {
        // A stale `ifMatch` is refused before anything commits.
        if (ifMatch !== undefined) await workspaceService.assertContentMatches(id, filePath, ifMatch);
        // Creator read grant: a file that starts a new folder at a root the
        // creator cannot read would vanish from their own explorer (read is
        // default-deny). Plan BEFORE the write: the new folder gets its
        // access.md seeded first. Anywhere else the lock's read gate has
        // already decided — a creation the creator could not see is refused,
        // and one they can see needs no grant.
        const plan = await creatorAccess.planForCreate(id, user, filePath, 'file');
        if (plan?.kind === 'seed-access-md') await seedCreatorAccessMd(id, user, plan);
        const toWrite = content;
        // `ifAbsent` = exclusive create: the service's `wx` write turns a
        // concurrent or stale create against an existing file into a 409
        // instead of a silent replace. `withLock`'s failure arm releases
        // without committing, so the refusal leaves no trace.
        //
        // `ifMatch` = conditional write, the same 409 for a stale UPDATE: the
        // file must still hold the text the caller last read, re-checked at
        // the write itself as the decision that counts.
        await withLock(id, user, filePath, () =>
          workspaceService.writeFile(id, filePath, toWrite, {
            failIfExists: ifAbsent === true,
            expectedContent: ifMatch,
          }),
        );
      });
      // After the write, and only ever advisory: the check reports what the
      // saved skill names, it has no say in whether it saved.
      const warnings = skillSaveCheck ? await skillSaveCheck.checkSave(user.email, filePath, content) : [];
      res.json({ status: 'written', ...(warnings.length > 0 ? { warnings } : {}) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/workspace/:id/directory', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const { path: requested, defer } = req.body as { path?: string; defer?: boolean };
    const canonical = requestPath(requested);
    if (canonical === null) {
      res.status(400).json({ error: 'path is required in body' });
      return;
    }
    // The folder this call creates, as a repository path. `KnowledgeBase/Reports`
    // is `<kbDirName>/KnowledgeBase/Reports` — the access plan below, the
    // `.gitkeep` lock and the mkdir all use this one spelling.
    const dirPath = inRepo(res, canonical);
    if (dirPath === null) return;
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      // Creator read grant: a new folder in an unreadable spot gets its own
      // (or its topmost new ancestor's) access.md seeded FIRST, naming the
      // creator under `read:` — otherwise the default-deny tree filter hides
      // the folder from its own creator the moment it appears. Seeding first
      // also makes the dir non-empty, so the .gitkeep below is skipped and
      // the folder's first committed file IS its access.md.
      const plan = await creatorAccess.planForCreate(id, user, dirPath, 'dir');
      if (plan?.kind === 'seed-access-md') await seedCreatorAccessMd(id, user, plan);
      // `createDirectory` makes the dir and, if it ends up empty, drops a
      // `.gitkeep` so git can track the otherwise-untracked folder. The
      // lock-and-release on `<dir>/.gitkeep` commits whatever landed; if
      // the dir was already populated and no .gitkeep was created, the
      // release sees nothing dirty for that path and is a no-op.
      //
      // `defer: true` (folder-upload empty-dir pass) still skips the per-call
      // `fs-tree-changed` so the bulk caller can emit one combined refresh
      // after the burst. Per-file pushes are gone everywhere — the
      // pending-commits worker drains commits out of band — so the only
      // remaining option is the tree-event suppression.
      const gitkeepPath = dirPath.endsWith('/') ? `${dirPath}.gitkeep` : `${dirPath}/.gitkeep`;
      await withLock(
        id,
        user,
        gitkeepPath,
        async () => {
          await workspaceService.createDirectory(id, dirPath);
        },
        defer === true ? { skipFsTreeEvent: true } : undefined,
      );
      res.json({ status: 'created' });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/workspace/:id/unzip', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestedZip = body.path;
    const requestedDest = body.destination;
    if (typeof requestedZip !== 'string' || requestedZip.length === 0) {
      res.status(400).json({ error: 'path is required in body and must be a string' });
      return;
    }
    if (requestedDest !== undefined && (typeof requestedDest !== 'string' || requestedDest.length === 0)) {
      res.status(400).json({ error: 'destination, if provided, must be a non-empty string' });
      return;
    }
    const zipPath = inRepo(res, requestedZip);
    if (zipPath === null) return;
    let destination: string | undefined;
    if (requestedDest !== undefined) {
      const normalizedDest = inRepo(res, requestedDest);
      if (normalizedDest === null) return;
      destination = normalizedDest;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      // The destination is asked about BEFORE anything is extracted: this is
      // the one route whose bytes land on disk ahead of the lock, so the
      // lock's read gate would find them already there. Same verdict, same
      // refusal, one step earlier. A destination inside a folder the caller
      // cannot read is refused whole; a folder they can read — or a new
      // folder directly under a root — extracts, and each file then meets
      // the lock as any other write does.
      //
      // A new root folder gets its creator's access.md seeded first, as
      // every other creation route does: extraction would otherwise bring
      // the folder into existence itself, and the first file's lock would
      // then find an existing folder the caller cannot read.
      // Both spellings are already repository paths, so the inferred parent is
      // one too — the same destination the service resolves.
      const destDir = destination ?? path.posix.dirname(zipPath);
      const plan = await creatorAccess.planForCreate(id, user, destDir, 'dir');
      if (plan?.kind === 'seed-access-md') await seedCreatorAccessMd(id, user, plan);
      await changeGate?.assertMayChange(id, user.email, destDir, 'dir');
      // Extract first (all files land on disk), then sweep each extracted
      // file through a lock+release so it commits + pushes as its own
      // one-file change. Per-file commits mean the validator runs N times
      // on large archives — fine for the typical "few files" drop, slow
      // but correct for a 100-file zip. If a single file's release fails
      // (e.g. validator 422), the loop stops there so the user sees the
      // first concrete problem rather than a list of N similar failures.
      //
      // Each entry is asked about before it is written, through the same
      // gate: an archive can carry a path into a nested folder the caller
      // cannot read, which the destination check above cannot see. Such an
      // entry is skipped and reported, never written and then refused.
      const result = await workspaceService.unzipFile(id, zipPath, destination, async (entryPath) => {
        await changeGate?.assertMayChange(id, user.email, entryPath, 'file');
      });
      for (const relFile of result.extracted) {
        // The file is already on disk from the unzip; the release commits +
        // pushes it.
        await withLock(id, user, relFile, async () => undefined);
      }
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/workspace/:id/upload', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const requested = requestPath(req.query.path);
    if (requested === null) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    // An upload with no folder lands at the repository ROOT inside the
    // checkout, not beside it — eight staging test documents sat beside it
    // because this route took the path as written.
    const filePath = inRepo(res, requested);
    if (filePath === null) return;
    // `?defer=true` is the bulk-upload caller's signal to suppress the
    // per-file `fs-tree-changed` SSE — the caller emits one combined
    // refresh at end-of-burst via `POST /flush`. Pushing isn't deferred
    // anywhere anymore; every successful release enqueues a pending-commit
    // row and the worker drains commits + pushes out of band.
    const defer = req.query.defer === 'true';
    const declaredSize = parseInt(req.headers['content-length'] ?? '', 10);
    if (declaredSize > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: `File exceeds ${MAX_UPLOAD_BYTES} byte limit` });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;

    try {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalBytes += buf.length;
        if (totalBytes > MAX_UPLOAD_BYTES) {
          res.status(413).json({ error: `File exceeds ${MAX_UPLOAD_BYTES} byte limit` });
          return;
        }
        chunks.push(buf);
      }
      const data = Buffer.concat(chunks);
      // Creator read grant, mirroring PUT /file: an upload that starts a new
      // folder at a root seeds that folder's access.md first. An upload into
      // a folder the caller cannot read never gets this far — the lock's read
      // gate refuses it.
      const plan = await creatorAccess.planForCreate(id, user, filePath, 'file');
      if (plan?.kind === 'seed-access-md') await seedCreatorAccessMd(id, user, plan);
      await withLock(
        id,
        user,
        filePath,
        () => workspaceService.writeFileBinary(id, filePath, data),
        defer ? { skipFsTreeEvent: true } : undefined,
      );
      res.json({ status: 'uploaded' });
    } catch (err) {
      sendError(res, err);
    }
  });

  // `POST /workspace/:id/flush` — end-of-batch checkpoint for folder
  // uploads (and any future batch caller using `defer: true`). Under the
  // pending-commits queue, the "push everything we just committed" job
  // happens out of band in the worker, so this route's only remaining
  // responsibility is to emit the single combined `fs-tree-changed`
  // event the bulk caller suppressed per file.
  // It takes NO path: there is nothing for the normaliser to place, which is
  // why this route is the one on the surface that does not call it.
  router.post('/workspace/:id/flush', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      const branch = branchForWorkspaceId(id);
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId: id, branch });
      res.json({ status: 'flushed' });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

/**
 * Enumerate every file (not directory) under `absoluteDir`, returned as
 * workspace-relative POSIX paths. Used by the DELETE handler to decompose
 * a recursive directory delete into per-file lock+release cycles so each
 * deletion lands as its own one-file change.
 *
 * Skips the git folder, in any spelling (`hasGitInternalsSegment`), so a
 * folder delete never enumerates — or deletes — the repository's git data. Returns paths in the walk's order — stable
 * and lexical — for predictable commit sequencing. A link counts as a file:
 * it is deleted as one, never followed. A folder that cannot be listed is
 * the delete's error: an enumeration with a hole in it would delete what it
 * saw and report success over what it did not.
 */
async function enumerateFilesUnder(disk: ITreeWalker, absoluteDir: string, workspaceDir: string): Promise<string[]> {
  const out: string[] = [];
  const relOf = (dir: string, name: string) =>
    path.relative(workspaceDir, path.join(absoluteDir, dir, name)).replace(/\\/g, '/');
  try {
    await disk.walk(absoluteDir, { skip: (e) => hasGitInternalsSegment(e.name), unreadable: 'throw' }, [
      {
        onFile: (dir, name) => void out.push(relOf(dir, name)),
        onOther: (dir, e) => void out.push(relOf(dir, e.name)),
      },
    ]);
  } catch (err) {
    // The operator's line carries the errno and the path; the caller's answer
    // names only the folder they asked about — an OS message would leak the
    // server's spelling of the workspace, and would not help them anyway.
    // Both halves of the log line are user- or disk-controlled text, so both
    // go through `printable`: a folder name or an OS message carrying a
    // control character must not steer the terminal or forge a log line.
    const folder = path.relative(workspaceDir, absoluteDir).replace(/\\/g, '/');
    const reason = err instanceof Error ? err.message : String(err);
    logger('workspace').error(`could not list every file under ${printable(folder)} for a delete: ${printable(reason)}`);
    throw Object.assign(new Error(`Could not list every file under "${folder}" — nothing was deleted. Try again, or ask an admin.`), {
      status: 500,
    });
  }
  return out;
}

/**
 * The error a failed folder keep answers: the original one — its type,
 * status and payload decide the response — with `message` saying what
 * landed and what did not. Anything that is not an Error becomes one.
 */
function withKeptFolderContext(err: unknown, message: string): Error {
  if (!(err instanceof Error)) return new Error(message);
  err.message = message;
  return err;
}

/**
 * Whether a folder exists and holds nothing. A folder that is gone answers
 * false: it was deleted explicitly, and keeping it would bring it back.
 */
async function isEmptyFolder(absoluteDir: string): Promise<boolean> {
  try {
    return (await fs.readdir(absoluteDir)).length === 0;
  } catch (err) {
    if (isAbsence(err)) return false;
    throw err;
  }
}

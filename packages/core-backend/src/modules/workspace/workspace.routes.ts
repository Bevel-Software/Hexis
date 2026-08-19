import fs from 'node:fs/promises';
import path from 'node:path';
import { IGNORE_FILENAME } from './bevel-ignore.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import express from 'express';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import {
  AGENTS_DIR,
  DATA_DIR,
  DEFAULT_BRANCH,
  KNOWLEDGE_BASE_DIR,
  KNOWLEDGE_DIR,
  PIPELINES_DIR,
  PLUGINS_DIR,
} from '@bevel-software/platform-shared';
import { FolderTooLargeError, type ReadTreeFilter } from './workspace.service.js';
import { branchForWorkspaceId } from '../../shared/workspace-id.js';
import type { WorkspaceService } from './workspace.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { resolveReadableMap, toKbRelative } from '../access/kb-read-filter.js';
import type { ICreatorAccess } from '../access/creator-access.js';
import { isRolesYamlPath, assertRolesYamlParsable } from '../access/roles-yaml-guard.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

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
): express.Router {
  const router = express.Router();

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
      console.error('[workspace.routes] requireUser failed:', err);
      res.status(500).json({ error: 'Internal server error' });
      return null;
    }
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
    options?: { skipFsTreeEvent?: boolean },
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
    const acquired = await workflowService.acquireLock(workspaceId, branch, targetPath, user);
    if (!acquired.acquired) {
      const holder = acquired.lock.holderName || 'another user';
      const err: Error & { status?: number } = new Error(
        `"${targetPath}" is being edited by ${holder}. Try again in a moment.`,
      );
      err.status = 409;
      throw err;
    }
    // Two release modes, depending on whether the op succeeded:
    //
    //   - op() FAILED  → drop the lock WITHOUT enqueueing a commit. The
    //     op may have written partial bytes to disk before throwing
    //     (write that errored mid-stream, etc.). A normal `releaseLock`
    //     would enqueue a commit for whatever's on disk and the worker
    //     would silently persist that partial state as a real committed
    //     change. `releaseLockNoCommit` drops the lock row only —
    //     partial disk state stays where it is but never becomes a
    //     committed change with the user's name on it.
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
      try {
        await workflowService.releaseLockNoCommit(workspaceId, branch, targetPath, user);
      } catch (releaseErr) {
        console.warn(
          `[workspace.routes] releaseLockNoCommit failed after op error for "${targetPath}":`,
          releaseErr instanceof Error ? releaseErr.message : releaseErr,
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
   * Map any thrown error to an HTTP response. Centralises the response
   * shape so each route handler stays focused on its own logic.
   *   - `WorkflowDomainError` → its `.status` + `.payload`
   *   - Path traversal → 403
   *   - Invalid path / zip → 400 (Only .zip is also 400)
   *   - Could not read zip → 422
   *   - Anything else with a `.status` → that status
   *   - Default → 500
   */
  function sendError(res: express.Response, err: unknown): void {
    if (err instanceof WorkflowDomainError) {
      res.status(err.status).json({ error: err.message, ...(err.payload ?? {}) });
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const status = (err as { status?: number } | null)?.status;
    if (typeof status === 'number') {
      res.status(status).json({ error: msg });
      return;
    }
    if (msg === 'Path traversal detected') {
      res.status(403).json({ error: msg });
      return;
    }
    if (msg.startsWith('Invalid path') || msg.startsWith('Only .zip')) {
      res.status(400).json({ error: msg });
      return;
    }
    if (msg.startsWith('Could not read zip file')) {
      res.status(422).json({ error: msg });
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
      // Log the full stack so the next 500 isn't a guessing game — the
      // bare `error.message` we returned before lost most diagnostic
      // signal (cause chain, stack frames, error class).
      console.error(
        `[workspace.routes] GET /workspace failed branch=${req.query.branch ?? '(default)'}:`,
        error instanceof Error ? error.stack ?? error.message : error,
      );
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
      // chain walk as `write`. Strip the kbDirName prefix so the resolver
      // receives a repo-relative path (mirrors the lock-acquire gate's
      // strip in workflow.service.ts's assertCanWriteAtPath).
      const repoRelative = relativePath.startsWith(`${kbDirName}/`)
        ? relativePath.slice(kbDirName.length + 1)
        : relativePath;
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
    const repoRelative = toKbRelative(relativePath, kbDirName);
    if (repoRelative === null) return true; // non-KB path — no read rules apply
    let allowed: boolean;
    try {
      allowed = await accessControl.canRead(workspaceId, user.email, repoRelative);
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
      const verdict = await resolveReadableMap(
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
      const structuralRoots = new Set([
        KNOWLEDGE_BASE_DIR,
        DATA_DIR,
        AGENTS_DIR,
        PIPELINES_DIR,
        PLUGINS_DIR,
        KNOWLEDGE_DIR,
      ]);
      for (const wp of wsRelPaths) {
        const rel = toKbRelative(wp, kbDirName);
        if (rel !== null && structuralRoots.has(rel)) verdict.set(wp, true);
      }

      // `.bevelignore` is ADMIN-ONLY. It is the file that decides what the file
      // tree and the agent view show at all, so it is deployment configuration
      // rather than knowledge — and it sits alone in being visible: its
      // siblings (`.gitignore`, `roles.yaml`, `access.md`, `AGENTS.md`) are
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
      const ignoreFiles = wsRelPaths.filter((wp) => path.basename(wp) === IGNORE_FILENAME);
      if (ignoreFiles.length > 0 && !(await adminAccess.isAdmin(userEmail))) {
        for (const wp of ignoreFiles) verdict.set(wp, false);
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
   * its creator. Best-effort by contract: a failure here logs and never
   * blocks the creation.
   */
  async function seedCreatorAccessMd(
    workspaceId: string,
    user: AuthUser,
    plan: { wsRelPath: string; apply: (current: string) => string },
  ): Promise<void> {
    try {
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
    } catch (err) {
      console.warn(
        `[workspace.routes] creator access.md seed failed for "${plan.wsRelPath}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  router.get('/workspace/:id/file/raw', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
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
      res.send(buffer);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg === 'Path traversal detected') {
        res.status(403).json({ error: msg });
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
    const folderPath = rawPath.trim().replace(/\/+$/, '');
    if (!folderPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
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
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg === 'Path traversal detected') {
        res.status(403).json({ error: msg });
        return;
      }
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
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    if (!(await requireReadPermission(req, res, id, filePath))) return;
    try {
      const content = await workspaceService.readFile(id, filePath);
      // No-store: this endpoint is used by the live-refresh path after a
      // teammate's save (file-changed SSE → refetch). A cached response
      // would yield stale bytes and silently defeat the auto-refresh.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.json({ content });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg === 'Path traversal detected') {
        res.status(403).json({ error: msg });
        return;
      }
      res.status(404).json({ error: 'File not found' });
    }
  });

  router.delete('/workspace/:id/file', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
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
      const absolute = path.resolve(workspaceDir, filePath);
      // Boundary check before any `fs.*` call. The single-file path
      // bottoms out in `workspaceService.deleteFile` (which asserts the
      // boundary itself), but this fast-path resolves the absolute
      // ourselves and then `fs.stat` / `fs.rm` / `enumerateFilesUnder`
      // it. Without this guard, a `../escape` `filePath` would let the
      // dir-delete branch operate on directories outside the workspace.
      const workspaceRoot = path.resolve(workspaceDir);
      if (absolute !== workspaceRoot && !absolute.startsWith(workspaceRoot + path.sep)) {
        const err: Error & { status?: number } = new Error('Path traversal detected');
        err.status = 403;
        throw err;
      }
      let stat: { isDirectory: () => boolean } | null = null;
      try {
        stat = await fs.stat(absolute);
      } catch {
        // Not on disk — let workspaceService.deleteFile return its own 404.
      }
      if (stat?.isDirectory()) {
        const filesInDir = await enumerateFilesUnder(absolute, workspaceDir);
        const branch = branchForWorkspaceId(id);
        for (const relFile of filesInDir) {
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
        // Sweep the now-empty directory subtree off disk. Git doesn't track
        // empty folders, so there's nothing to commit; this is just disk
        // hygiene so the file tree stops showing the empty containers.
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
          console.warn(
            `[workspace.routes] dir cleanup skipped for "${filePath}":`,
            rmErr instanceof Error ? rmErr.message : rmErr,
          );
        }
        // Single tree-refresh signal for the whole batch (we suppressed
        // the per-file ones via `skipFsTreeEvent`).
        eventBus.emit({ kind: 'fs-tree-changed', workspaceId: id, branch });
        res.json({ status: 'deleted', count: filesInDir.length });
        return;
      }
      await withLock(id, user, filePath, () => workspaceService.deleteFile(id, filePath));
      res.json({ status: 'deleted' });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch('/workspace/:id/file', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const { oldPath, newPath } = req.body as { oldPath?: string; newPath?: string };
    if (!oldPath || !newPath) {
      res.status(400).json({ error: 'oldPath and newPath are required in body' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    try {
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
      await withLock(id, user, firstLock, () =>
        withLock(id, user, secondLock, () =>
          workspaceService.moveEntry(id, oldPath, newPath),
        ),
      );
      res.json({ status: 'moved' });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/workspace/:id/file', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const { content, ifAbsent } = req.body as { content?: string; ifAbsent?: boolean };
    if (content === undefined) {
      res.status(400).json({ error: 'content is required in body' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      // Refuse a hand-edit that would leave roles.yaml unparseable BEFORE any
      // byte hits disk — a broken roles.yaml is an app-wide admin lockout
      // (loadModel hard-throws). The dedicated Roles & Members surface has its
      // own validate gate; this covers the raw-text editor path.
      if (isRolesYamlPath(filePath, kbDirName)) assertRolesYamlParsable(content);
      // Creator read grant: a brand-new file at a spot whose access chain
      // doesn't grant the creator `read` would vanish from their own explorer
      // (read is default-deny). Plan BEFORE the write: a new subtree gets its
      // access.md seeded first; a loose .md carries the grant in its own
      // frontmatter as part of this same single write.
      const plan = await creatorAccess.planForCreate(id, user, filePath, 'file');
      if (plan?.kind === 'seed-access-md') await seedCreatorAccessMd(id, user, plan);
      const toWrite = plan?.kind === 'frontmatter' ? plan.apply(content) : content;
      // `ifAbsent` = exclusive create: the service's `wx` write turns a
      // concurrent or stale create against an existing file into a 409
      // instead of a silent replace. `withLock`'s failure arm releases
      // without committing, so the refusal leaves no trace.
      await withLock(id, user, filePath, () =>
        workspaceService.writeFile(id, filePath, toWrite, { failIfExists: ifAbsent === true }),
      );
      res.json({ status: 'written' });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/workspace/:id/directory', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const { path: dirPath, defer } = req.body as { path?: string; defer?: boolean };
    if (!dirPath) {
      res.status(400).json({ error: 'path is required in body' });
      return;
    }
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
    const zipPath = body.path;
    const destination = body.destination;
    if (typeof zipPath !== 'string' || zipPath.length === 0) {
      res.status(400).json({ error: 'path is required in body and must be a string' });
      return;
    }
    if (destination !== undefined && (typeof destination !== 'string' || destination.length === 0)) {
      res.status(400).json({ error: 'destination, if provided, must be a non-empty string' });
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      // Extract first (all files land on disk), then sweep each extracted
      // file through a lock+release so it commits + pushes as its own
      // one-file change. Per-file commits mean the validator runs N times
      // on large archives — fine for the typical "few files" drop, slow
      // but correct for a 100-file zip. If a single file's release fails
      // (e.g. validator 422), the loop stops there so the user sees the
      // first concrete problem rather than a list of N similar failures.
      const result = await workspaceService.unzipFile(id, zipPath, destination);
      for (const relFile of result.extracted) {
        await withLock(id, user, relFile, async () => {
          // The file is already on disk from the unzip; the release commits +
          // pushes it. If the extraction landed a markdown node the creator
          // can't read (default-deny chains), splice their read grant into
          // its frontmatter first so the committed change already carries it.
          // Best-effort: a failed grant write must not throw — withLock's
          // failure path releases WITHOUT committing and would discard the
          // extracted file from disk, turning a cosmetic grant failure into
          // data loss.
          try {
            const granted = await creatorAccess.grantInExtractedFile(id, user, relFile);
            if (granted !== null) await workspaceService.writeFile(id, relFile, granted);
          } catch (err) {
            console.warn(
              `[workspace.routes] creator grant on extracted "${relFile}" failed:`,
              err instanceof Error ? err.message : err,
            );
          }
        });
      }
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/workspace/:id/upload', async (req, res) => {
    const id = authenticated(req, res);
    if (id === null) return;
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
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
      // Creator read grant, mirroring PUT /file: seed a new subtree's
      // access.md first, or fold the grant into an uploaded markdown file's
      // frontmatter. Binary uploads into a pre-existing unreadable folder
      // can't carry a per-file grant (no frontmatter) and proceed ungranted.
      const plan = await creatorAccess.planForCreate(id, user, filePath, 'file');
      if (plan?.kind === 'seed-access-md') await seedCreatorAccessMd(id, user, plan);
      const toWrite =
        plan?.kind === 'frontmatter'
          ? Buffer.from(plan.apply(data.toString('utf8')), 'utf8')
          : data;
      await withLock(
        id,
        user,
        filePath,
        () => workspaceService.writeFileBinary(id, filePath, toWrite),
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
 * Skips `.git` to avoid trying to commit the internal git index when a
 * caller targets it accidentally. Returns paths in stable lexical order
 * for predictable commit sequencing.
 */
async function enumerateFilesUnder(absoluteDir: string, workspaceDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git' && entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else {
        out.push(path.relative(workspaceDir, child).replace(/\\/g, '/'));
      }
    }
  }
  await walk(absoluteDir);
  return out;
}

/**
 * Recursively remove empty directories under `absoluteDir`, bottom-up, then
 * remove `absoluteDir` itself if it ends up empty. A directory is removed only
 * if it contains nothing at the moment it's visited, so any file a concurrent
 * writer dropped in mid-delete — and every parent directory on its path —
 * survives. `.git` is left alone. Used after a recursive folder delete to
 * sweep the leftover empty-folder shells off disk so the file tree (which
 * lists on-disk directories, not just tracked files) stops showing the
 * deleted container.
 */
async function removeEmptyDirs(absoluteDir: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    // Already gone (raced delete) — nothing to do.
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' && entry.isDirectory()) continue;
    if (entry.isDirectory()) {
      await removeEmptyDirs(path.join(absoluteDir, entry.name));
    }
  }
  // Re-read after pruning children: a subdir we just emptied now lets this
  // dir become removable too. Any surviving file (or `.git`) keeps it.
  const remaining = await fs.readdir(absoluteDir);
  if (remaining.length === 0) {
    await fs.rmdir(absoluteDir);
  }
}

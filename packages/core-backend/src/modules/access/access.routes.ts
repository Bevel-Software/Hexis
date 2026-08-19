import express from 'express';
import type { AuthUser } from '@bevel-software/platform-shared';
import { isProtectedBranch, DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import type {
  IAccessControl,
  GrantPrincipal,
  GrantSources,
} from './access-control.interface.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { branchForWorkspaceId, workspaceIdForBranch } from '../workspace/workspace.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import { AccessDeniedError } from './access-errors.js';
import {
  AccessMutationService,
  AccessMutationError,
  accessMdPathForFolder,
  type TargetKind,
} from './access-mutation.service.js';
import {
  canonicalRoleName,
  EVERYONE_CANONICAL,
  ROLE_TOKEN_PREFIX,
  type Verb,
} from './access-control.service.js';
import { listAccessDeclarationsUnder } from './access-declarations.js';
import { toHttpError as sharedToHttpError, requireNonEmptyString as sharedRequireNonEmptyString } from './admin-route-helpers.js';
import { RolesAdminService } from './roles-admin.service.js';
import type { Principal } from './access-splice.js';
import type { Database } from '../database/connection.js';
import { users } from '../database/schema.js';
import '../auth/auth.middleware.js';

/** Verbs the share UI may grant. Verbs are independent — `download` is grantable on its own. */
const GRANTABLE_VERBS = new Set<string>(['read', 'write', 'owner', 'download']);

/** Shared access-family error shape (see admin-route-helpers): typed domain
 *  errors render themselves; anything else is logged and answered generically
 *  — a raw `err.message` never leaks through a 500. */
function toHttpError(err: unknown): { status: number; body: Record<string, unknown> } {
  return sharedToHttpError(err, 'access');
}

/** Shared non-empty-string coercion; 400s render as RolesAdminError-family. */
function requireNonEmptyString(value: unknown, field: string): string {
  return sharedRequireNonEmptyString(value, field);
}

export function createAccessRoutes(
  accessControl: IAccessControl,
  workspaceService: WorkspaceService,
  authService: AuthService,
  workflowService: WorkflowService,
  eventBus: WorkflowEventBus,
  db: Database,
  kbDirName: string,
  /** This deployment's configured admins — the break-glass recovery roster. */
  recoveryAdmins: readonly string[] = [],
): express.Router {
  const router = express.Router({ mergeParams: true });
  const mutation = new AccessMutationService(workspaceService, accessControl, kbDirName);
  const rolesAdmin = new RolesAdminService(
    workspaceService,
    workflowService,
    accessControl,
    kbDirName,
    () => DEFAULT_BRANCH,
    eventBus,
    recoveryAdmins,
  );

  // Roles and groups are authoritative on the DEFAULT branch — the Roles
  // admin screen only ever edits roles.yaml there, and the ACTIVE group
  // source (IdP-synced or manual) lives there. Resolve both from the
  // default-branch workspace's CACHED resolver model (one call, no per-
  // keystroke file reads) so the share dialog suggests — and the grant route
  // accepts — the same principals the admin screens manage, regardless of
  // which branch the caller is viewing. People stay branch-local (the
  // caller's own workspace).
  const defaultBranchPrincipals = async (): Promise<{ roles: string[]; groups: string[] }> => {
    await workspaceService.getOrCreateForBranch(DEFAULT_BRANCH);
    const { roles, groups } = await accessControl.kbPrincipals(workspaceIdForBranch(DEFAULT_BRANCH));
    return { roles, groups };
  };

  /**
   * What the mutation routes accept as a principal. `group` exists only at
   * this boundary: in the access.md entry grammar a group grant is a
   * bare-name token (bare names resolve GROUP-FIRST, then fall back to the
   * role), so it is spliced as a role-shaped principal — the separate kind
   * buys validation against the right namespace and honest 404s.
   */
  type RoutePrincipal = Principal | { kind: 'group'; group: string };

  /**
   * The role-shaped principal the splice layer actually writes/matches.
   *   - group     → its bare name (group-first precedence resolves it).
   *   - role      → the explicit `role/<Name>` token — the grant route WRITES
   *                 roles that way from now on (bare role tokens remain
   *                 read-compatible). The built-in `everyone` stays bare: it
   *                 is not a roles.yaml role and has no `role/` alias.
   */
  const asSplicePrincipal = (p: RoutePrincipal): Principal => {
    if (p.kind === 'group') return { kind: 'role', role: p.group };
    if (p.kind === 'role') {
      const canonical = canonicalRoleName(p.role);
      if (canonical === EVERYONE_CANONICAL || canonical.startsWith(ROLE_TOKEN_PREFIX)) return p;
      return { kind: 'role', role: `${ROLE_TOKEN_PREFIX}${p.role.trim()}` };
    }
    return p;
  };

  // Authentication gate only. Per PLAN §3 the workspace `:id` is a branch
  // identifier — any authenticated user can read its access tree.
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
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
      return null;
    }
  }

  /**
   * Strip the `<kbDirName>/` prefix the frontend sends (workspace-relative) to
   * the repo-relative form the access model speaks. Mirrors
   * `assertCanWriteAtPath`'s strip. Distinguish by CALLER (the frontend always
   * sends workspace-relative), not by string content — see the
   * `access-path-mismatch` learning.
   */
  function toRepoRelative(p: string): string {
    const prefix = `${kbDirName}/`;
    if (p === kbDirName) return '';
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  }

  /**
   * Reject a repo-relative target that could escape the KB repo once joined.
   * `toRepoRelative` only strips the prefix, so `${kbDirName}/../tmp` survives as
   * `../tmp` — inside the workspace but outside the KB. Refuse `..` segments,
   * backslashes, absolute paths, and NULs before any lock/edit-path derivation.
   */
  function assertRepoRelativeTarget(repoRelTarget: string, kind: TargetKind): void {
    if (kind === 'file' && !repoRelTarget) {
      throw new AccessMutationError('file path is required');
    }
    if (
      repoRelTarget.startsWith('/') ||
      repoRelTarget.includes('\\') ||
      repoRelTarget.includes('\0') ||
      repoRelTarget.split('/').some((segment) => segment === '..')
    ) {
      throw new AccessMutationError('path must stay inside the KB repo');
    }
  }

  /**
   * GET /api/workspace/:id/access?path=<relativePath>&kind=<folder|file>
   * Returns the resolved access view for the current user at a single path,
   * including a per-principal `sources` map (where each principal's access comes
   * from) so the dialog can show inherited-vs-direct. `kind` defaults to `file`
   * (the resolver treats a folder vs a file's own scope differently only for the
   * `sources` direct/ancestor split; the eligible/verdict fields are identical).
   */
  router.get('/workspace/:id/access', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;

    const rawPath = req.query.path;
    if (typeof rawPath !== 'string' || !rawPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const kind: TargetKind = req.query.kind === 'folder' ? 'folder' : 'file';

    try {
      // Same sanitize/validate the POST routes apply: strip any kbDir prefix and
      // refuse paths that escape the KB repo before handing to the resolver.
      const repoRelTarget = toRepoRelative(rawPath);
      assertRepoRelativeTarget(repoRelTarget, kind);
      res.json(await resolvedView(req.params.id, repoRelTarget, user.email, kind));
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  /**
   * GET /api/workspace/:id/access/overrides?path=<folder>
   *
   * Every access declaration living INSIDE a folder — the descendant
   * `access.md` files and the node frontmatter that override the folder's own
   * rules for the principals they name. Display-only: the folder access surface
   * shows it so nobody reads a folder's share list as the whole story.
   *
   * Gating is stricter than the sibling `GET /access`, which hands its eligible
   * lists to any authenticated caller: here the caller must RESOLVE read on the
   * folder (403 otherwise), and every returned row is additionally filtered by
   * `canReadBatch` on what it governs. So the endpoint can only ever tell you
   * about rules on things you can already see. It writes nothing and resolves
   * nothing — it reports declarations through the resolver's own parsers.
   */
  router.get('/workspace/:id/access/overrides', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;

    const rawPath = req.query.path;
    if (typeof rawPath !== 'string' || !rawPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    try {
      const folder = toRepoRelative(rawPath);
      assertRepoRelativeTarget(folder, 'folder');

      if (!(await accessControl.canRead(req.params.id, user.email, folder))) {
        res.status(403).json({ error: 'You do not have access to this folder.' });
        return;
      }

      const { overrides, truncated } = await listAccessDeclarationsUnder(
        workspaceService,
        req.params.id,
        kbDirName,
        folder,
      );

      // Read-filter per ROW. Folder read does not imply read on everything
      // underneath — a `deny read` on one skill is precisely the kind of rule
      // this endpoint lists, and echoing that skill's name back to the person
      // it was denied to would leak the thing the rule exists to hide.
      const governs = [...new Set(overrides.map((o) => o.governs))];
      const readable = governs.length
        ? await accessControl.canReadBatch(req.params.id, user.email, governs)
        : new Map<string, boolean>();

      res.json({
        overrides: overrides.filter((o) => readable.get(o.governs) === true),
        truncated,
      });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  /**
   * POST /api/workspace/:id/access/batch
   * Body: `{ paths: string[] }`. Returns `{ results: { [path]: boolean } }`.
   */
  router.post('/workspace/:id/access/batch', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;

    const paths = (req.body as { paths?: unknown }).paths;
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
      res.status(400).json({ error: 'paths must be an array of strings' });
      return;
    }
    if (paths.length > 500) {
      res.status(400).json({ error: 'paths cannot exceed 500 entries per request' });
      return;
    }

    try {
      const result = await accessControl.canWriteBatch(
        req.params.id,
        user.email,
        paths as string[],
      );
      const obj: Record<string, boolean> = {};
      for (const [k, v] of result) obj[k] = v;
      res.json({ results: obj });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  /**
   * GET /api/workspace/:id/access/suggest?q=<query>
   * Autocomplete for the share dialog. Returns matching roles (roles.yaml role
   * names — resolved from the DEFAULT branch, the authoritative source),
   * groups (the ACTIVE group source, same authority), and people (branch-local
   * to `:id`). Roles/groups come from the resolver's CACHED model — no fresh
   * file reads per keystroke. Roles + groups are small + non-sensitive so they
   * always show; PEOPLE are withheld until `q` is ≥ 2 chars, so an empty query
   * can't dump the whole directory (email-harvesting guard). People are the
   * union of the KB-canonical set (roles.yaml + access.md grants) and the
   * `users` table (logged-in users). Results are capped.
   *
   * A name shared by a group and a role is offered as BOTH — nothing is
   * withheld: grant precedence resolves the collision (bare token = the
   * group; the role is written as `role/<Name>`).
   */
  router.get('/workspace/:id/access/suggest', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;

    const q = (typeof req.query.q === 'string' ? req.query.q : '').trim().toLowerCase();
    const CAP = 15;
    try {
      // Independent lookups batched in ONE Promise.all: the default-branch
      // principals (cached model), the branch-local KB people (cached model),
      // and the users table (only consulted once the query is long enough).
      const [{ roles, groups }, { people: kbPeople }, userRows] = await Promise.all([
        defaultBranchPrincipals(),
        accessControl.kbPrincipals(req.params.id),
        q.length >= 2 ? db.select().from(users) : Promise.resolve([]),
      ]);

      const matchedRoles = roles
        .filter((g) => !q || g.toLowerCase().includes(q))
        .slice(0, CAP);

      const matchedGroups = groups
        .filter((g) => !q || g.toLowerCase().includes(q))
        .slice(0, CAP);

      let people: { name: string; email: string }[] = [];
      if (q.length >= 2) {
        // Union the KB-canonical people with the login-only users table.
        const byEmail = new Map<string, { name: string; email: string }>();
        for (const p of kbPeople) byEmail.set(p.email.toLowerCase(), p);
        for (const u of userRows) {
          const key = u.email.toLowerCase();
          // Prefer a real display name over the email local-part default: only
          // overwrite when the existing name still looks email-like and we have
          // a real one to replace it with.
          const existing = byEmail.get(key);
          if (!existing || (existing.name.includes('@') && u.name)) {
            byEmail.set(key, { name: u.name || u.email, email: u.email });
          }
        }
        people = [...byEmail.values()]
          .filter((p) => p.email.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
          .slice(0, CAP);
      }

      res.json({
        roles: matchedRoles,
        groups: matchedGroups,
        people,
        peopleWithheld: q.length < 2,
        // DEPRECATED alias of `roles` — the shipped share dialog still reads
        // `plugins`. Kept populated for ONE release; remove in 0.2.0 together
        // with the dialog's rename to `roles`.
        plugins: matchedRoles,
      });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  /**
   * Parse + validate a grant/revoke request body into a canonical Principal plus
   * the target kind and repo-relative path. Throws AccessMutationError on bad input.
   */
  function parseMutationBody(body: unknown): {
    repoRelTarget: string;
    kind: TargetKind;
    principal: RoutePrincipal;
  } {
    const b = (body ?? {}) as Record<string, unknown>;
    const rawPath = b.path;
    const kind = b.kind;
    const principalRaw = b.principal as Record<string, unknown> | undefined;
    if (typeof rawPath !== 'string' || !rawPath) {
      throw new AccessMutationError('path is required');
    }
    if (kind !== 'folder' && kind !== 'file') {
      throw new AccessMutationError("kind must be 'folder' or 'file'");
    }
    if (!principalRaw || typeof principalRaw !== 'object') {
      throw new AccessMutationError('principal is required');
    }
    let principal: RoutePrincipal;
    if (principalRaw.kind === 'user') {
      if (typeof principalRaw.email !== 'string' || typeof principalRaw.displayName !== 'string') {
        throw new AccessMutationError('user principal needs email + displayName');
      }
      principal = {
        kind: 'user',
        email: principalRaw.email,
        displayName: principalRaw.displayName,
      };
    } else if (principalRaw.kind === 'role') {
      if (typeof principalRaw.role !== 'string') {
        throw new AccessMutationError('role principal needs a role name');
      }
      principal = { kind: 'role', role: principalRaw.role };
    } else if (principalRaw.kind === 'group') {
      if (typeof principalRaw.group !== 'string') {
        throw new AccessMutationError('group principal needs a group name');
      }
      principal = { kind: 'group', group: principalRaw.group };
    } else {
      throw new AccessMutationError("principal.kind must be 'user', 'group', or 'role'");
    }
    const targetKind = kind as TargetKind;
    const repoRelTarget = toRepoRelative(rawPath);
    assertRepoRelativeTarget(repoRelTarget, targetKind);
    return { repoRelTarget, kind: targetKind, principal };
  }

  /**
   * The access.md / node path the write lands on, and the path the write-gate
   * keys on. For a folder both are the folder's access.md; for a file they are
   * the node file itself.
   */
  function gateAndEditPaths(kind: TargetKind, repoRelTarget: string): {
    gatePath: string;
    editPath: string;
  } {
    const editPath = kind === 'folder' ? accessMdPathForFolder(repoRelTarget) : repoRelTarget;
    return { gatePath: editPath, editPath };
  }

  /**
   * Fail-closed authorization for a mutation. Mirrors the resolver's special
   * casing but NEVER default-allows: the lock-acquire gate (assertCanWriteAtPath)
   * default-ALLOWS when no config resolves at HEAD on a protected branch — a
   * privilege hole at exactly the bootstrap state this feature first hits. Here
   * we require an explicit, resolved write permission on the access-config path,
   * and on a protected branch additionally require the caller to be writable
   * per the resolver (admins via rescue, or an explicit grant). Absent/
   * unparseable config → AccessConfigError surfaces (not silent allow).
   */
  async function assertCanMutate(
    workspaceId: string,
    branch: string,
    userEmail: string,
    gatePath: string,
  ): Promise<void> {
    const writable = await accessControl.canWrite(workspaceId, userEmail, gatePath);
    if (!writable) {
      const eligible = await accessControl.eligibleWriters(workspaceId, gatePath);
      throw new AccessDeniedError({
        path: gatePath,
        eligibleRoles: eligible.roles,
        eligibleUsers: eligible.users,
      });
    }
    // On a protected branch, write is admin-only for access.md/roles.yaml. The
    // canWrite check above already encodes that (admin-rescue), so a non-admin
    // resolves to false and is rejected above. Nothing extra needed here — but
    // keep the branch check explicit so the intent is legible.
    void branch;
    void isProtectedBranch;
  }

  /** The full resolved-access view returned after a successful mutation. */
  async function resolvedView(
    workspaceId: string,
    repoRelTarget: string,
    userEmail: string,
    kind: TargetKind,
  ) {
    const [canRead, canWrite, canDownload, canOwner, eligible, readers, owners, downloaders] =
      await Promise.all([
        accessControl.canRead(workspaceId, userEmail, repoRelTarget),
        accessControl.canWrite(workspaceId, userEmail, repoRelTarget),
        accessControl.canDownload(workspaceId, userEmail, repoRelTarget),
        accessControl.canOwner(workspaceId, userEmail, repoRelTarget),
        accessControl.eligibleWriters(workspaceId, repoRelTarget),
        accessControl.eligibleReaders(workspaceId, repoRelTarget),
        accessControl.eligibleOwners(workspaceId, repoRelTarget),
        accessControl.eligibleDownloaders(workspaceId, repoRelTarget),
      ]);

    // Per-principal, per-verb origin (direct / ancestor — MECE over editable
    // files). Keyed `u:<email>` / `r:<role>` to match the dialog's row keys, so
    // each row can show where its access comes from and which verbs are
    // removable here. A row whose verbs resolve only via a group/everyone/rescue
    // has no source (the verb is absent) and renders non-actionable. Built over
    // the union of every principal in the four eligible lists.
    const roleSet = new Set<string>([
      ...eligible.roles,
      ...readers.roles,
      ...owners.roles,
      ...downloaders.roles,
    ]);
    const userSet = new Map<string, { name: string; email: string }>();
    for (const u of [...eligible.users, ...readers.users, ...owners.users, ...downloaders.users]) {
      if (!userSet.has(u.email.toLowerCase())) userSet.set(u.email.toLowerCase(), u);
    }
    const sources: Record<string, Awaited<ReturnType<IAccessControl['grantSources']>>> = {};
    await Promise.all([
      ...[...roleSet].map(async (role) => {
        sources[`r:${role.toLowerCase()}`] = await accessControl.grantSources(
          workspaceId,
          kind,
          repoRelTarget,
          { kind: 'role', role },
        );
      }),
      ...[...userSet.values()].map(async (u) => {
        sources[`u:${u.email.toLowerCase()}`] = await accessControl.grantSources(
          workspaceId,
          kind,
          repoRelTarget,
          { kind: 'user', email: u.email },
        );
      }),
    ]);

    return { canRead, canWrite, canDownload, canOwner, eligible, readers, owners, downloaders, sources };
  }

  /**
   * Run a mutation under the edit-file lock: acquire → op (mutation writes
   * under the lock) → release (enqueues the commit + push out of band). Mirrors
   * the human-save `withLock` so protected-branch enforcement + commit-as-user
   * are inherited. On op failure, release WITHOUT committing partial bytes.
   */
  async function withEditLock(
    workspaceId: string,
    branch: string,
    editPath: string,
    user: AuthUser,
    op: () => Promise<void>,
  ): Promise<void> {
    const wsEditPath = `${kbDirName}/${editPath}`;
    const existing = await workflowService.getLock(workspaceId, branch, wsEditPath);
    if (existing && existing.holderUserId === user.id) {
      // Caller already holds the lock (mid-edit) — write without touching it.
      await op();
      eventBus.emit({
        kind: 'file-changed',
        workspaceId,
        branch,
        path: wsEditPath,
        newSha: null,
        byUserId: user.id,
        byUserName: user.name,
      });
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId, branch });
      return;
    }
    const acquired = await workflowService.acquireLock(workspaceId, branch, wsEditPath, user);
    if (!acquired.acquired) {
      const holder = acquired.lock.holderName || 'another user';
      const err: Error & { status?: number } = new Error(
        `"${editPath}" is being edited by ${holder}. Try again in a moment.`,
      );
      err.status = 409;
      throw err;
    }
    try {
      await op();
    } catch (err) {
      try {
        await workflowService.releaseLockNoCommit(workspaceId, branch, wsEditPath, user);
      } catch {
        /* best-effort */
      }
      throw err;
    }
    await workflowService.releaseLock(workspaceId, branch, wsEditPath, user);
    eventBus.emit({ kind: 'fs-tree-changed', workspaceId, branch });
  }

  /**
   * POST /api/workspace/:id/access/grant
   * Body: `{ path, kind: 'folder'|'file', verb: 'write'|'owner', principal }`.
   * Grants the principal the verb on the target (folder → its access.md, file →
   * its own frontmatter). Gated on write to the access config (fail-closed on
   * protected branches). Returns the fresh resolved access for the target.
   */
  router.post('/workspace/:id/access/grant', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = req.params.id;
    const branch = branchForWorkspaceId(workspaceId);
    try {
      const verb = (req.body as { verb?: unknown }).verb;
      if (typeof verb !== 'string' || !GRANTABLE_VERBS.has(verb)) {
        throw new AccessMutationError(
          `verb must be one of: ${[...GRANTABLE_VERBS].join(', ')}`,
        );
      }
      const { repoRelTarget, kind, principal } = parseMutationBody(req.body);

      // For a role grant, the role must exist in roles.yaml. Reject loudly
      // otherwise. Validate against the DEFAULT-branch roles (same
      // authoritative source the suggest autocomplete uses) so a
      // default-branch role can't be suggested then rejected here on a
      // feature branch whose roles.yaml has diverged. No collision refusals:
      // a name shared with a group is fine — the grant is WRITTEN as the
      // explicit `role/<Name>` token, which precedence always resolves to the
      // role.
      if (principal.kind === 'role') {
        const { roles } = await defaultBranchPrincipals();
        const bare = canonicalRoleName(principal.role).startsWith(ROLE_TOKEN_PREFIX)
          ? canonicalRoleName(principal.role).slice(ROLE_TOKEN_PREFIX.length)
          : canonicalRoleName(principal.role);
        const known = roles.some((g) => canonicalRoleName(g) === bare);
        if (!known) {
          throw new AccessMutationError(
            `No role named "${principal.role}". Pick an existing role.`,
            404,
            { kind: 'unknown-role', role: principal.role },
          );
        }
        // The built-in `everyone` role is grantable from the share UI for READ
        // only (public read). Write/owner/download to everyone would make the
        // node world-writable from a casual dialog, so those stay a direct
        // access.md edit.
        if (bare === EVERYONE_CANONICAL && verb !== 'read') {
          throw new AccessMutationError(
            '"Everyone" can only be granted read access (public). Grant other access levels to specific people or roles.',
          );
        }
      } else if (principal.kind === 'group') {
        // A group grant must name a group in the ACTIVE source (IdP-synced or
        // manual) on the default branch — same authority the suggest list
        // uses. No role-collision refusal: bare tokens resolve GROUP-FIRST,
        // so the written bare name IS the group.
        const { groups } = await defaultBranchPrincipals();
        const canonical = canonicalRoleName(principal.group);
        if (!groups.some((g) => canonicalRoleName(g) === canonical)) {
          throw new AccessMutationError(
            `No group named "${principal.group}". Pick an existing group.`,
            404,
            { kind: 'unknown-group', group: principal.group },
          );
        }
      }
      // Splice shape: group → bare token (group-first precedence); role →
      // explicit `role/<Name>` token (see asSplicePrincipal).
      const splicePrincipal = asSplicePrincipal(principal);

      const { gatePath } = gateAndEditPaths(kind, repoRelTarget);
      // Ensure the branch workspace exists before locking.
      await workspaceService.getOrCreateForBranch(branch);
      // Fail-closed gate (BEFORE acquiring the lock).
      await assertCanMutate(workspaceId, branch, user.email, gatePath);

      const editPath = gatePath; // grant edits the same path it gates on
      await withEditLock(workspaceId, branch, editPath, user, async () => {
        await mutation.grant(workspaceId, kind, repoRelTarget, verb as Verb, splicePrincipal);
      });

      // The write landed on disk under the lock; drop the cache so the
      // re-resolve reads the just-written bytes (the async commit's own
      // invalidate is too late for this synchronous response).
      accessControl.invalidate(workspaceId);
      console.log(
        `[access.grant] ws=${workspaceId} branch=${branch} byUserId=${user.id} ` +
          `verb=${verb} kind=${kind} target=${repoRelTarget} ` +
          `principalKind=${principal.kind} -> ok`,
      );
      res.json(await resolvedView(workspaceId, repoRelTarget, user.email, kind));
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        console.warn(
          `[access.grant.denied] ws=${workspaceId} byUserId=${user.id} -> 403`,
        );
      }
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  /**
   * POST /api/workspace/:id/access/revoke
   *
   * Three behaviors selected by an optional `mode`:
   *
   *   (default) Revoke on the TARGET. Classified by where the principal's
   *     access comes from:
   *       - direct on the target  → remove the entry, 200 fresh view.
   *       - inherited from an ancestor (target splice would no-op but the
   *         principal still resolves) → 409 `{ kind: 'inherited', sources }`
   *         so the dialog can offer remove-from-parent or deny-here. We do NOT
   *         silently return an unchanged 200.
   *       - no effective access anywhere → 200 no-op.
   *     `verb` (optional) narrows a direct revoke to one verb.
   *
   *   `mode: 'remove-from-parent'` — cascade up. Body adds `ancestor` (the
   *     repo-relative ancestor folder, echoed opaquely from the 409 sources).
   *     Gates + locks on the ANCESTOR's access.md, re-validates under the lock
   *     that the principal is still inherited from it, then revokes there.
   *
   *   `mode: 'deny-here'` — per-item override. Adds a `deny <principal>` at the
   *     target (strip-then-deny + effectiveness assert in the mutation).
   *
   * Revoke is unconditional — no last-owner / self-lockout guard.
   */
  router.post('/workspace/:id/access/revoke', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = req.params.id;
    const branch = branchForWorkspaceId(workspaceId);
    try {
      const mode = (req.body as { mode?: unknown }).mode;
      const { repoRelTarget, kind, principal: routePrincipal } = parseMutationBody(req.body);
      // Revoke matching is name-based, so a group principal converts straight
      // to the role-shaped token — no existence check (revoking a grant whose
      // group has since vanished must keep working).
      const principal = asSplicePrincipal(routePrincipal);
      // Optional `verb` scopes ALL three paths to a single verb: a default revoke
      // strips just that verb; remove-from-parent removes just that verb on the
      // ancestor; deny-here denies just that verb at the target. Absent ⇒ the
      // whole principal (every verb). Shared by every mode so the share dialog's
      // per-checkbox toggle and its whole-row Remove both work.
      const rawVerb = (req.body as { verb?: unknown }).verb;
      let verb: Verb | undefined;
      if (rawVerb !== undefined) {
        if (typeof rawVerb !== 'string' || !GRANTABLE_VERBS.has(rawVerb)) {
          throw new AccessMutationError(`verb must be one of: ${[...GRANTABLE_VERBS].join(', ')}`);
        }
        verb = rawVerb as Verb;
      }
      await workspaceService.getOrCreateForBranch(branch);

      // ---- mode: remove-from-parent (cascade up the ancestor) --------------
      if (mode === 'remove-from-parent') {
        const rawAncestor = (req.body as { ancestor?: unknown }).ancestor;
        if (typeof rawAncestor !== 'string' || !rawAncestor) {
          throw new AccessMutationError("'ancestor' is required for remove-from-parent");
        }
        // The ancestor is the repo-relative FOLDER whose access.md grants the
        // principal — we revoke against it as a folder target. Strip the kbDir
        // prefix if the client (defensively) sent a prefixed path.
        const ancestorDir = toRepoRelative(rawAncestor);
        assertRepoRelativeTarget(ancestorDir, 'folder');
        const { gatePath: ancestorGate } = gateAndEditPaths('folder', ancestorDir);
        // Gate on the ANCESTOR's access.md, not the target.
        await assertCanMutate(workspaceId, branch, user.email, ancestorGate);

        await withEditLock(workspaceId, branch, ancestorGate, user, async () => {
          // Re-validate UNDER the lock: the principal must STILL be inherited
          // from this exact ancestor (the chain may have changed since the 409).
          const sources = await accessControl.grantSources(
            workspaceId,
            kind,
            repoRelTarget,
            toGrantPrincipal(principal),
          );
          const ancestorMd = accessMdPathForFolder(ancestorDir);
          // Scope the recheck to the verb the user acted on (if any): an
          // inherited grant of a DIFFERENT verb must not keep a verb-scoped
          // revoke alive on this ancestor.
          const listsToCheck = verb ? [sources[verb]] : Object.values(sources);
          const inheritedHere = listsToCheck.some((list) =>
            (list ?? []).some((s) => s.kind === 'ancestor' && s.path === ancestorMd),
          );
          if (!inheritedHere) {
            throw new AccessMutationError(
              'This person is no longer inherited from that folder — refresh and try again.',
              409,
              { kind: 'stale-ancestor' },
            );
          }
          // Scope the ancestor revoke to the same verb the user acted on (if any).
          await mutation.revoke(workspaceId, 'folder', ancestorDir, principal, user.email, verb);
        });

        accessControl.invalidate(workspaceId);
        console.log(
          `[access.revoke.remove-from-parent] ws=${workspaceId} branch=${branch} ` +
            `byUserId=${user.id} ancestor=${ancestorDir} target=${repoRelTarget} verb=${verb ?? 'all'} -> ok`,
        );
        res.json(await resolvedView(workspaceId, repoRelTarget, user.email, kind));
        return;
      }

      // ---- mode: deny-here (per-item override) -----------------------------
      if (mode === 'deny-here') {
        const { gatePath } = gateAndEditPaths(kind, repoRelTarget);
        await assertCanMutate(workspaceId, branch, user.email, gatePath);
        await withEditLock(workspaceId, branch, gatePath, user, async () => {
          // Scope the deny to the same verb the user acted on (if any).
          await mutation.denyHere(workspaceId, kind, repoRelTarget, principal, verb);
        });
        accessControl.invalidate(workspaceId);
        console.log(
          `[access.revoke.deny-here] ws=${workspaceId} branch=${branch} ` +
            `byUserId=${user.id} target=${repoRelTarget} verb=${verb ?? 'all'} -> ok`,
        );
        res.json(await resolvedView(workspaceId, repoRelTarget, user.email, kind));
        return;
      }

      // ---- default: revoke on the target, classified -----------------------
      const { gatePath } = gateAndEditPaths(kind, repoRelTarget);
      await assertCanMutate(workspaceId, branch, user.email, gatePath);

      const editPath = gatePath;
      let changed = false;
      await withEditLock(workspaceId, branch, editPath, user, async () => {
        const r = await mutation.revoke(workspaceId, kind, repoRelTarget, principal, user.email, verb);
        changed = r.changed;
      });

      accessControl.invalidate(workspaceId);

      // The target splice changed nothing. `grantSources` is MECE (direct |
      // ancestor); a no-op splice means no `direct` entry existed to remove, so
      // any source left is an `ancestor`. Distinguish "inherited" (still named in
      // an ancestor access.md — offer cascade/deny) from "no removable source
      // here" (nothing named in any file we can edit — a genuine no-op). A
      // principal who only RESOLVES via a group/role / everyone / admin-rescue has no
      // source at all (it's not their own file entry) and so is correctly a 200
      // no-op: there is nothing to remove here and no Remove was ever offered for
      // them in the dialog. NEVER a silent unchanged-success when there IS a
      // removable inherited entry.
      if (!changed) {
        const sources = await accessControl.grantSources(
          workspaceId,
          kind,
          repoRelTarget,
          toGrantPrincipal(principal),
        );
        // Only an inherited source for the verb being revoked (if any) should
        // trigger the cascade/deny prompt — a different verb's inherited grant
        // is not what this revoke is trying to remove.
        const sourcesToCheck: GrantSources = verb ? { [verb]: sources[verb] } : sources;
        const inherited = collectInheritedSources(sourcesToCheck);
        if (inherited.length > 0) {
          console.log(
            `[access.revoke.inherited] ws=${workspaceId} branch=${branch} byUserId=${user.id} ` +
              `target=${repoRelTarget} ancestors=${inherited.join(',')}`,
          );
          res.status(409).json({
            error:
              "This person's access comes from a parent folder. Remove it there, or restrict just this item.",
            kind: 'inherited',
            sources,
          });
          return;
        }
        // else: genuine no-op, fall through to the 200 fresh view.
      }

      // The fresh view's per-row `sources` map carries the post-revoke origins
      // for EVERY principal still resolving — including one whose direct entry we
      // just stripped but who remains inherited from an ancestor (their row now
      // shows an `ancestor` source). The dialog reads that to chain into
      // "Remove from parent?" with no extra response field needed (the old
      // `stillInherited` shortcut is subsumed by the richer per-verb sources).
      console.log(
        `[access.revoke] ws=${workspaceId} branch=${branch} byUserId=${user.id} ` +
          `kind=${kind} target=${repoRelTarget} principalKind=${principal.kind} changed=${changed} -> ok`,
      );
      res.json(await resolvedView(workspaceId, repoRelTarget, user.email, kind));
    } catch (err) {
      if (err instanceof AccessDeniedError || err instanceof AccessMutationError) {
        console.warn(
          `[access.revoke.denied] ws=${workspaceId} byUserId=${user.id} -> ${
            err instanceof WorkflowDomainError ? err.status : 500
          }`,
        );
      }
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // -------------------------------------------------------------------------
  // Roles & Members (admin) — MEMBERSHIP editing on the DEFAULT-branch
  // roles.yaml. Roles are app-defined capabilities: there is deliberately NO
  // create/rename/delete route — the admin surface cannot mint, rebrand, or
  // retire a role (legacy people-set roles migrate out via convert-to-group).
  // Routes are GLOBAL (no `:id`): the handler resolves the default-branch
  // workspace internally, because that is the file admin status derives from.
  // Mutating routes are admin-gated by `assertRolesAdmin` (the same admin-only
  // `canWrite('roles.yaml')` check the rest of the app uses); the service's
  // lock acquisition re-enforces it at HEAD. Path prefix is `/access/roles`,
  // NOT `/admin/roles` — the access router owns roles.yaml mutation (the
  // `/admin/*` namespace belongs to the admin router + its requireAdmin
  // middleware, which we deliberately do not borrow here).
  // -------------------------------------------------------------------------

  /** Fail-fast admin gate for the roles routes. Throws AccessDeniedError. */
  async function assertRolesAdmin(userEmail: string): Promise<void> {
    await workspaceService.getOrCreateForBranch(DEFAULT_BRANCH);
    await assertCanMutate(workspaceIdForBranch(DEFAULT_BRANCH), DEFAULT_BRANCH, userEmail, 'roles.yaml');
  }

  router.get('/access/roles', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      // Roster viewing is admin-only (spec: non-admins can't see or use the
      // surface). The frontend hides the page, but the API must gate too — the
      // roster exposes every role + member email.
      await assertRolesAdmin(user.email);
      res.json({ roles: await rolesAdmin.getRoster() });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // NOTE: POST /access/roles (create), PATCH /access/roles/:canonical
  // (rename), and DELETE /access/roles/:canonical are GONE — roles are
  // app-defined capabilities, not user-editable objects.

  router.post('/access/roles/:canonical/members', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      await assertRolesAdmin(user.email);
      const canonical = canonicalRoleName(req.params.canonical);
      const email = requireNonEmptyString((req.body ?? {}).email, 'email');
      res.json({ roles: await rolesAdmin.addMember(user, canonical, email) });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // Assign / unassign a GROUP to a role (capability-follows-membership; the
  // editor refuses Admin — individuals only for the blast-radius role).
  router.post('/access/roles/:canonical/groups', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      await assertRolesAdmin(user.email);
      const canonical = canonicalRoleName(req.params.canonical);
      const group = requireNonEmptyString((req.body ?? {}).group, 'group');
      res.json({ roles: await rolesAdmin.assignGroup(user, canonical, group) });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.delete('/access/roles/:canonical/groups/:group', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      await assertRolesAdmin(user.email);
      const canonical = canonicalRoleName(req.params.canonical);
      res.json({ roles: await rolesAdmin.unassignGroup(user, canonical, String(req.params.group)) });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  // Convert a legacy people-set role into a manual group (atomic two-file
  // move; grants keep working because the name is unchanged).
  router.post('/access/roles/:canonical/convert-to-group', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      await assertRolesAdmin(user.email);
      const canonical = canonicalRoleName(req.params.canonical);
      res.json({ roles: await rolesAdmin.convertRoleToGroup(user, canonical) });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  /**
   * GET /access/roles/health
   * Auth-only (NOT admin-gated): a corrupted roles.yaml resolves nobody as
   * admin, so an admin gate could never report the state this exists to detect.
   * Returns `{ ok, errors }` for the default-branch roles.yaml; drives the
   * "roles file corrupted" banner.
   */
  router.get('/access/roles/health', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      res.json(await rolesAdmin.getHealth());
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  /**
   * POST /access/roles/recover — the "Bevel Recovery" button.
   * Auth-only by design: see `RolesAdminService.recover`. It self-gates on the
   * file actually being corrupted (409 if it parses), backs the corrupted bytes
   * up to old-roles.yaml, and restores the known-good default.
   */
  router.post('/access/roles/recover', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      const roles = await rolesAdmin.recover(user);
      console.warn(`[access.roles.recover] roles.yaml recovered byUserId=${user.id}`);
      res.json({ roles });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  router.delete('/access/roles/:canonical/members/:email', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      await assertRolesAdmin(user.email);
      // Express already URL-decodes req.params — do NOT decode again (a second
      // decodeURIComponent corrupts any email containing a literal `%`).
      const canonical = canonicalRoleName(req.params.canonical);
      const email = req.params.email;
      const confirm = req.query.confirm === 'true';
      res.json({ roles: await rolesAdmin.removeMember(user, canonical, email, confirm) });
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  });

  return router;
}

/** Map a write-side `Principal` to the resolver's `GrantPrincipal`. */
function toGrantPrincipal(principal: Principal): GrantPrincipal {
  return principal.kind === 'user'
    ? { kind: 'user', email: principal.email }
    : { kind: 'role', role: principal.role };
}

/** The distinct ancestor access.md paths a principal is named in for any verb. */
function collectInheritedSources(sources: GrantSources): string[] {
  const paths = new Set<string>();
  for (const list of Object.values(sources)) {
    for (const s of list ?? []) {
      if (s.kind === 'ancestor') paths.add(s.path);
    }
  }
  return [...paths];
}

/**
 * Admin Roles & Members service — full CRUD on the default-branch `roles.yaml`.
 *
 * This is the deferred "Slice 2" of `manage-access-grant-revoke`: the in-product
 * surface for creating/deleting roles, adding/removing members, and renaming a
 * role. It is the ONLY writer of `roles.yaml` outside a hand-edit, and it is
 * built around one non-negotiable safety property:
 *
 *   roles.yaml has NO admin-rescue (canWrite('roles.yaml') is a pure isAdmin
 *   check) and loadModel HARD-THROWS on a parse failure (which isAdmin swallows
 *   into false for EVERYONE). So a single malformed write = a permanent,
 *   app-wide, in-app-unrecoverable admin lockout. Every mutation therefore runs
 *   the candidate text through the resolver's OWN parser (validateRolesYaml)
 *   before a byte hits disk; on any error it writes nothing.
 *
 * Two write paths, both gated by the same friendly pre-checks + validate gate:
 *
 *   Single-file ops (create/delete role, add/remove member) — `runEdit`:
 *     pre-check roles.yaml isn't locked  → RolesAdminError 409
 *     read CURRENT roles.yaml → parse → edit-in-memory → re-emit candidate
 *     validateRolesYaml(candidate)       → RolesAdminError 422, write nothing
 *     LockingFilesystem.writeFile(roles.yaml)  ← acquire → write → release;
 *       release IS the commit + push (default per-file summary), so the commit
 *       lands a beat after the write — same pipeline the human editor + agent
 *       use. The HTTP roster reads the (synchronously written) working tree.
 *
 *   Rename (`renameRole`) — keeps an ATOMIC multi-file special case because it
 *   rewrites roles.yaml + every reference in ONE commit (a partial rewrite =
 *   silent access drop):
 *     pre-check roles.yaml isn't locked  → RolesAdminError 409
 *     parse + rewrite refs (fail-closed) → validate gate
 *     LockingFilesystem.writeFiles(roles.yaml + refs)  ← acquires every path's
 *       lock, commits the curated set as ONE change (via the workflow service's
 *       commitChanges), then releases without a per-file commit.
 *
 * All reads and writes target the DEFAULT branch — the file admin status itself
 * derives from. Editing any other branch's copy would show a roster that
 * doesn't match who is actually an admin.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import { LockingFilesystem } from '../workflow/locking-filesystem.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import type { AuthUser, FileTreeEntry, IWorkspaceService, IWorkflowService } from '@bevel-software/platform-shared';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import type { IAccessControl } from './access-control.interface.js';
import {
  ADMIN_CANONICAL,
  canonicalRoleName,
  canonicalEmail,
  parseAccessEntry,
} from './access-control.service.js';
import { makeRolesYamlWriteValidator } from './roles-yaml-guard.js';
import {
  parseRolesModel,
  createRole as editCreateRole,
  deleteRole as editDeleteRole,
  addMember as editAddMember,
  removeMember as editRemoveMember,
  renameRoleDisplay as editRenameRoleDisplay,
  RolesEditError,
  type EditResult,
} from './roles-edit.js';

/** A mutation that cannot proceed (invariant violation, contention, not found). */
export class RolesAdminError extends WorkflowDomainError {
  constructor(message: string, status = 422, payload?: Record<string, unknown>) {
    super(message, status, payload);
    this.name = 'RolesAdminError';
  }
}

/** One role as the Roles & Members page renders it. */
export interface RoleRosterEntry {
  canonical: string;
  displayName: string;
  members: string[];
  isAdmin: boolean;
  /**
   * Every access rule referencing this role — folder `access.md` AND node
   * frontmatter. Sound: this is the SAME scan the rename rewrite uses, so the
   * delete warning's count matches what a delete/rename would actually touch.
   */
  referencedBy: { path: string; verb: string }[];
}

const ROLES_YAML = 'roles.yaml';
/** Where {@link RolesAdminService.recover} parks the corrupted file. */
const OLD_ROLES_YAML = 'old-roles.yaml';

/**
 * The known-good `roles.yaml` the break-glass recovery restores — generated
 * from THIS deployment's configured admins, exactly like ordinary seeding
 * (`ADMIN_EMAIL`), never a roster baked into the build: hard-coded emails
 * would land one company's admins in every customer's recovered file. It is
 * the ONLY content recovery ever writes, so it MUST parse (the post-recovery
 * resolver loads it immediately) — guaranteed by construction here.
 */
function renderRecoveryRolesYaml(admins: readonly string[]): string {
  const entries = admins.map((email) => `    - ${email}`).join('\n');
  return `# Identity → role mapping for access control.
# Role names are case- and whitespace-insensitive. The \`Admin\` role is special:
# only Admins may edit this file, and at least one Admin must always exist.
roles:
  Admin:
${entries}
`;
}

/** Health of the default-branch roles.yaml: does the resolver's parser accept it? */
export interface RolesConfigHealth {
  ok: boolean;
  errors: string[];
}

export class RolesAdminService {
  constructor(
    private readonly workspaceService: IWorkspaceService,
    private readonly workflowService: IWorkflowService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    /**
     * The branch whose roles.yaml is authoritative for admin status, read
     * through a thunk rather than taken by value. `DEFAULT_BRANCH` is an ES
     * module live binding that stays empty until `configureBranchModel()` runs
     * at boot; a service constructed before that would freeze the empty string
     * and every roles route would fail branch validation until a restart.
     */
    private readonly defaultBranchOf: () => string,
    /**
     * Optional so existing tests can construct the service without an event
     * bus. When present, every committed write announces itself so already-open
     * clients re-fetch the changed files and re-evaluate their permissions —
     * a roles.yaml / access.md change is an access change, and without this an
     * open tab keeps a now-stale read verdict until a manual reload.
     */
    private readonly eventBus?: WorkflowEventBus,
    /**
     * This deployment's configured admins (`ADMIN_EMAIL`), the roster the
     * break-glass recovery restores. Recovery refuses outright when empty: a
     * recovered roles.yaml with no Admin is exactly the unusable state
     * recovery exists to escape.
     */
    private readonly recoveryAdmins: readonly string[] = [],
  ) {}

  /** Resolved per call — see the constructor note on `defaultBranchOf`. */
  private get defaultBranch(): string {
    return this.defaultBranchOf();
  }

  private get workspaceId(): string {
    return workspaceIdForBranch(this.defaultBranch);
  }

  /**
   * Announce committed writes so watching clients refresh. Emits one
   * `file-changed` per written file (workspace-relative path — the form the
   * frontend keys tabs on, NOT the bare repo-relative path `commitChanges` takes)
   * plus a single `fs-tree-changed`. `newSha: null` — the roster response is the
   * authoritative post-commit state; clients only need the "go refetch" nudge.
   */
  private emitWrites(workspaceId: string, actor: AuthUser, repoRelPaths: string[]): void {
    if (!this.eventBus || repoRelPaths.length === 0) return;
    for (const repoRel of repoRelPaths) {
      this.eventBus.emit({
        kind: 'file-changed',
        workspaceId,
        branch: this.defaultBranch,
        path: `${this.kbDirName}/${repoRel}`,
        newSha: null,
        byUserId: actor.id,
        byUserName: actor.name,
      });
    }
    this.eventBus.emit({ kind: 'fs-tree-changed', workspaceId, branch: this.defaultBranch });
  }

  /** Ensure the authoritative clone exists, then return its workspace id. */
  private async ensureWorkspace(): Promise<string> {
    await this.workspaceService.getOrCreateForBranch(this.defaultBranch);
    return this.workspaceId;
  }

  private async repoDir(workspaceId: string): Promise<string> {
    const wsDir = await this.workspaceService.getWorkspacePath(workspaceId);
    return path.join(wsDir, this.kbDirName);
  }

  /**
   * A lock-aware filesystem scoped to `actor` — writes auto-commit + push as the
   * actor on release, through the same pipeline as the human editor and agent.
   * Built per-op because the lock context captures the acting user.
   */
  private async lockingFsForActor(workspaceId: string, actor: AuthUser): Promise<LockingFilesystem> {
    const basePath = await this.workspaceService.getWorkspacePath(workspaceId);
    return new LockingFilesystem(
      { basePath, contained: true },
      {
        workflow: this.workflowService,
        workspaceId,
        branch: this.defaultBranch,
        user: actor,
        // Defence in depth: this surface already validates candidates before
        // writing, but the same pre-disk gate the editor/agent use guarantees a
        // malformed roles.yaml can never land through here either.
        validateWrite: makeRolesYamlWriteValidator(this.kbDirName),
      },
    );
  }

  /**
   * Fail fast with a friendly 409 if roles.yaml is already locked by someone
   * else. The actual lock is taken by the LockingFilesystem write that follows;
   * this only preserves the explicit "being edited by X" contract (the raw
   * LockingFilesystem contention error is status-less and would surface as 500).
   */
  private async assertRolesUnlocked(workspaceId: string, actor: AuthUser): Promise<void> {
    const held = await this.workflowService.getLock(
      workspaceId,
      this.defaultBranch,
      `${this.kbDirName}/${ROLES_YAML}`,
    );
    if (held && held.holderUserId !== actor.id) {
      throw new RolesAdminError(
        `Roles are being edited by ${held.holderName || 'another admin'}. Try again in a moment.`,
        409,
      );
    }
  }

  /**
   * Run a lock-aware filesystem write, mapping its status-less contention error
   * ("Skipped editing … — locked by …") to the friendly 409. {@link
   * assertRolesUnlocked} pre-checks the common case (and names the holder), but
   * it's a TOCTOU check — another admin can grab the lock between it and the
   * actual acquire inside the write. This catches that race so contention always
   * surfaces as a 409, never an unhandled 500.
   */
  private async mapLockContention<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof Error && /locked by /.test(err.message)) {
        throw new RolesAdminError('Roles are being edited by another admin. Try again in a moment.', 409);
      }
      throw err;
    }
  }

  private async readRolesYaml(workspaceId: string): Promise<string> {
    try {
      return await this.workspaceService.readFile(workspaceId, path.posix.join(this.kbDirName, ROLES_YAML));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return '';
      throw err;
    }
  }

  // ---- Read -------------------------------------------------------------

  /** The roster: every role on the default branch with members + references. */
  async getRoster(): Promise<RoleRosterEntry[]> {
    const workspaceId = await this.ensureWorkspace();
    const text = await this.readRolesYaml(workspaceId);
    const model = parseRolesModel(text);
    // ONE sound scan of every `.md` (folder access.md + node
    // frontmatter), then index the references by canonical role. This is the
    // SAME candidate set + parse the rename rewrite uses, so the delete warning
    // can never undercount what the rename would actually touch.
    const referencesByRole = await this.scanRoleReferences(workspaceId);
    const out: RoleRosterEntry[] = [];
    for (const role of model) {
      const canonical = canonicalRoleName(role.displayName);
      out.push({
        canonical,
        displayName: role.displayName,
        members: role.members,
        isAdmin: canonical === ADMIN_CANONICAL,
        referencedBy: referencesByRole.get(canonical) ?? [],
      });
    }
    return out;
  }

  /**
   * Whether the default-branch roles.yaml parses. Drives the "roles file
   * corrupted" banner. Auth-only (never admin-gated): a corrupted file resolves
   * NOBODY as admin, so an admin-gated health check could never report the very
   * state it exists to detect. A missing/empty file counts as corrupted —
   * loadModel hard-throws on it exactly as it does on malformed YAML.
   */
  async getHealth(): Promise<RolesConfigHealth> {
    const workspaceId = await this.ensureWorkspace();
    const text = await this.readRolesYaml(workspaceId);
    const v = this.accessControl.validateRolesYaml(text);
    return v.ok ? { ok: true, errors: [] } : { ok: false, errors: v.errors };
  }

  /**
   * Break-glass recovery for a corrupted roles.yaml (the "Bevel Recovery"
   * button). Copies the corrupted file to `old-roles.yaml` and restores the
   * known-good default in ONE atomic commit, then returns the fresh roster.
   *
   * Authorization: this is the ONE roles mutation that is NOT admin-gated —
   * by construction a corrupted roles.yaml resolves nobody as admin, so an
   * admin gate would make recovery impossible (the lockout the user reported).
   * Instead it is gated on the file ACTUALLY being unparseable: if roles.yaml
   * is valid, recovery is refused (409) so it can never be used as an
   * unauthenticated roster reset. The "only press if you are from Bevel" UI
   * copy is the honour-system layer on top of that hard gate.
   *
   * This works on the protected default branch because the commit/push access
   * gate reads roles.yaml AT-REF and fails OPEN when it can't parse (treating a
   * broken config as "no rules in force") — so the restoring write is allowed
   * through precisely when the file is broken.
   */
  async recover(actor: AuthUser): Promise<RoleRosterEntry[]> {
    const workspaceId = await this.ensureWorkspace();

    // Start from EXACTLY origin's state before deciding/writing. This (a) pulls
    // in commits the clone was behind on so the restoring commit fast-forwards
    // on push instead of being rejected non-fast-forward, and (b) discards any
    // half-finished recovery commit a prior failed push left behind (which would
    // otherwise make the LOCAL file look healthy while origin stays broken and
    // the fix never reaches it). Best-effort: if origin is unreachable we fall
    // back to the local state and still attempt the local fix.
    try {
      await this.workflowService.resetToRemote(workspaceId, this.defaultBranch);
      this.accessControl.invalidate(workspaceId);
    } catch (err) {
      console.warn(
        '[roles.recover] could not sync with origin before recovery; proceeding with local state:',
        err instanceof Error ? err.message : err,
      );
    }

    const current = await this.readRolesYaml(workspaceId);

    // Hard gate: refuse unless the file is genuinely corrupted.
    if (this.accessControl.validateRolesYaml(current).ok) {
      throw new RolesAdminError(
        'roles.yaml is valid — recovery is only available when the file is corrupted.',
        409,
        { kind: 'not-corrupted' },
      );
    }

    if (this.recoveryAdmins.length === 0) {
      throw new RolesAdminError(
        'Recovery needs a configured admin (ADMIN_EMAIL) to restore — a roles.yaml ' +
          'with no Admin is exactly the unusable state recovery exists to escape.',
        500,
        { kind: 'no-recovery-admins' },
      );
    }

    await this.assertRolesUnlocked(workspaceId, actor);

    // Back up the corrupted bytes and restore the good default atomically. The
    // default is valid, so the resolver loads immediately after this commit.
    const fsys = await this.lockingFsForActor(workspaceId, actor);
    await this.mapLockContention(() =>
      fsys.writeFiles(
        [
          { path: `${this.kbDirName}/${OLD_ROLES_YAML}`, content: current },
          { path: `${this.kbDirName}/${ROLES_YAML}`, content: renderRecoveryRolesYaml(this.recoveryAdmins) },
        ],
        'Bevel recovery: reset corrupted roles.yaml',
      ),
    );
    this.accessControl.invalidate(workspaceId);
    this.emitWrites(workspaceId, actor, [OLD_ROLES_YAML, ROLES_YAML]);
    return this.getRoster();
  }

  // ---- Mutations --------------------------------------------------------

  async createRole(actor: AuthUser, displayName: string): Promise<RoleRosterEntry[]> {
    await this.runEdit(actor, (text) => editCreateRole(text, displayName));
    return this.getRoster();
  }

  async deleteRole(actor: AuthUser, canonical: string): Promise<RoleRosterEntry[]> {
    if (canonical === ADMIN_CANONICAL) {
      throw new RolesAdminError('The Admin role cannot be deleted', 422);
    }
    await this.runEdit(actor, (text) => editDeleteRole(text, canonical));
    return this.getRoster();
  }

  async addMember(actor: AuthUser, canonical: string, email: string): Promise<RoleRosterEntry[]> {
    await this.runEdit(actor, (text) => editAddMember(text, canonical, email));
    return this.getRoster();
  }

  /**
   * Remove a member. Refuses to empty the Admin role (422). Removing the
   * caller's OWN last Admin membership requires `confirm` (409 otherwise) — no
   * silent self-lockout, since admin status is read live from this file.
   */
  async removeMember(
    actor: AuthUser,
    canonical: string,
    email: string,
    confirm: boolean,
  ): Promise<RoleRosterEntry[]> {
    await this.runEdit(actor, (text) => {
      const target = canonicalEmail(email);
      if (canonical === ADMIN_CANONICAL) {
        const admin = parseRolesModel(text).find((r) => canonicalRoleName(r.displayName) === ADMIN_CANONICAL);
        const members = admin?.members ?? [];
        if (members.includes(target) && members.length <= 1) {
          throw new RolesAdminError('The Admin role must keep at least one member', 422);
        }
        if (target === canonicalEmail(actor.email) && members.includes(target) && !confirm) {
          throw new RolesAdminError('You are about to remove your own admin access', 409, {
            kind: 'self-admin-removal',
          });
        }
      }
      return editRemoveMember(text, canonical, email);
    });
    return this.getRoster();
  }

  /**
   * Rename a role's display name.
   *   - canonical UNCHANGED (casing/whitespace) → single roles.yaml edit.
   *   - canonical CHANGES → rewrite every genuine role reference in access.md +
   *     node frontmatter AND roles.yaml in ONE atomic commit.
   *   - Admin canonical → non-admin canonical is refused (400): it would break
   *     isAdminEmail's roles.has('admin') lookup. Casing-only Admin OK.
   */
  async renameRole(actor: AuthUser, canonical: string, newDisplayName: string): Promise<RoleRosterEntry[]> {
    const newCanonical = canonicalRoleName(newDisplayName);
    if (canonical === ADMIN_CANONICAL && newCanonical !== ADMIN_CANONICAL) {
      throw new RolesAdminError('The Admin role cannot be renamed to a different name', 400);
    }

    const workspaceId = await this.ensureWorkspace();
    // Preserve the friendly 409 on contention: writeFiles throws a status-less
    // lock-skip error (→ 500), so pre-check the roles.yaml lock.
    await this.assertRolesUnlocked(workspaceId, actor);

    const text = await this.readRolesYaml(workspaceId);
    const before = parseRolesModel(text);
    if (!before.some((r) => canonicalRoleName(r.displayName) === canonical)) {
      throw new RolesAdminError(`role not found: ${canonical}`, 404);
    }

    const rolesEdit = this.guardEdit(() => editRenameRoleDisplay(text, canonical, newDisplayName));
    const writes: { repoRelativePath: string; content: string }[] = [];

    // The roles.yaml change itself (skip if the re-emit was a no-op).
    // REPO-relative path (bare); the kbDirName prefix is added below.
    if (rolesEdit.changed) {
      writes.push({ repoRelativePath: ROLES_YAML, content: rolesEdit.text });
    }

    // Identity change → rewrite every genuine role reference, atomically.
    // (Fail-closed: an unreadable candidate throws here, BEFORE any write.)
    if (newCanonical !== canonical) {
      const repoDir = await this.repoDir(workspaceId);
      const refWrites = await this.rewriteRoleReferences(workspaceId, repoDir, canonical, newDisplayName.trim());
      writes.push(...refWrites);
    }

    if (writes.length === 0) return this.getRoster(); // nothing changed

    // The validate-gate: any roles.yaml write must parse via the resolver —
    // runs BEFORE the atomic write so a bad candidate never reaches disk.
    const rolesWrite = writes.find((w) => w.repoRelativePath === ROLES_YAML);
    if (rolesWrite) this.assertLoadable(rolesWrite.content);

    // Rename keeps the ATOMIC multi-file commit (roles.yaml + every rewritten
    // reference land as ONE commit, or none): a partial rewrite would leave a
    // renamed role with references still pointing at the old name = silent
    // access drop. The lock-aware filesystem owns this — it acquires every
    // path's lock, writes them, and commits the curated set as one change.
    const fsys = await this.lockingFsForActor(workspaceId, actor);
    await this.mapLockContention(() =>
      fsys.writeFiles(
        writes.map((w) => ({ path: `${this.kbDirName}/${w.repoRelativePath}`, content: w.content })),
        `Rename role ${canonical} → ${newDisplayName.trim()}`,
      ),
    );
    this.accessControl.invalidate(workspaceId);
    this.emitWrites(workspaceId, actor, writes.map((w) => w.repoRelativePath));
    return this.getRoster();
  }

  // ---- Internals --------------------------------------------------------

  /** Map a RolesEditError to a RolesAdminError (preserving status). */
  private guardEdit(fn: () => EditResult): EditResult {
    try {
      return fn();
    } catch (err) {
      if (err instanceof RolesEditError) throw new RolesAdminError(err.message, err.status);
      throw err;
    }
  }

  private assertLoadable(candidate: string): void {
    const v = this.accessControl.validateRolesYaml(candidate);
    if (!v.ok) {
      throw new RolesAdminError(`roles.yaml would be invalid: ${v.errors.join('; ')}`, 422);
    }
  }

  /**
   * Single-file roles.yaml mutation. `pre` produces the candidate (and may throw
   * RolesAdminError for invariant violations before any write). Skips on a no-op.
   *
   * The write goes through a {@link LockingFilesystem}: acquiring the per-file
   * lock, writing, then releasing — and release IS the commit + push (attributed
   * to `actor`), the same pipeline the human editor and agent use. So unlike the
   * rename's synchronous atomic commit, the git commit here lands on release
   * (a beat after the write); the HTTP response reads the working tree, which is
   * already on disk, so the returned roster is correct.
   */
  private async runEdit(
    actor: AuthUser,
    pre: (currentText: string) => EditResult,
  ): Promise<void> {
    const workspaceId = await this.ensureWorkspace();
    await this.assertRolesUnlocked(workspaceId, actor);
    const text = await this.readRolesYaml(workspaceId);
    const result = this.guardEdit(() => pre(text));
    if (!result.changed) return;
    this.assertLoadable(result.text);
    // LockingFilesystem paths are WORKSPACE-relative, so carry the kbDirName
    // prefix (unlike commitChanges' bare repo-relative paths). The release
    // pipeline writes a default per-file commit summary ("Update roles.yaml");
    // a bespoke summary isn't threadable through this path, which is fine for a
    // single-file roles edit. The rename keeps its descriptive summary because
    // it commits atomically via writeFiles.
    const fsys = await this.lockingFsForActor(workspaceId, actor);
    await this.mapLockContention(() => fsys.writeFile(`${this.kbDirName}/${ROLES_YAML}`, result.text));
    this.accessControl.invalidate(workspaceId);
    this.emitWrites(workspaceId, actor, [ROLES_YAML]);
  }

  /**
   * Find every genuine role reference to `oldCanonical` across folder access.md
   * AND node frontmatter, and rewrite each to `newDisplayName`. Reference-aware:
   * a line is rewritten ONLY if it PARSES as a role entry whose canonical name
   * == oldCanonical. Prose, comments, `Name <email>` user entries, other keys,
   * and substrings never match. Returns the repo-relative writes to commit.
   */
  private async rewriteRoleReferences(
    workspaceId: string,
    repoDir: string,
    oldCanonical: string,
    newDisplayName: string,
  ): Promise<{ repoRelativePath: string; content: string }[]> {
    const writes: { repoRelativePath: string; content: string }[] = [];
    const candidates = await this.collectCandidateFiles(workspaceId);
    for (const repoRel of candidates) {
      const abs = path.join(repoDir, repoRel);
      let text: string;
      try {
        text = await fs.readFile(abs, 'utf-8');
      } catch (err) {
        // Fail closed: a candidate we cannot read might reference the
        // old role. Skipping it would commit a partial rewrite (a half-renamed
        // role pointing at the old name) and silently drop access. Abort the
        // whole atomic rename instead so the admin can retry cleanly.
        throw new RolesAdminError(
          `Cannot read ${repoRel} while rewriting role references; rename aborted with no changes`,
          422,
          { cause: (err as Error)?.message },
        );
      }
      const rewritten = rewriteRoleTokensInText(text, oldCanonical, newDisplayName);
      if (rewritten !== text) {
        // REPO-relative (bare repoRel) for commitChanges — repoDir already points
        // at <workspaceDir>/<kbDirName>.
        writes.push({ repoRelativePath: repoRel, content: rewritten });
      }
    }
    return writes;
  }

  /**
   * Repo-relative paths of every file that could carry a role reference: all
   * `access.md` files plus every `.md` node (its own frontmatter). Sourced from
   * the workspace file tree (which already skips `.git` and honours
   * `.bevelignore`), filtered to `.md` under the KB dir and returned bare
   * repo-relative. (`roles.yaml` isn't `.md`, so it's excluded; the rename
   * commits it separately.) Under save=share the working tree matches the
   * committed set, so this is the same candidate list git-tracking would give.
   */
  private async collectCandidateFiles(workspaceId: string): Promise<string[]> {
    const tree = await this.workspaceService.listFiles(workspaceId);
    const prefix = `${this.kbDirName}/`;
    const out: string[] = [];
    const visit = (node: FileTreeEntry): void => {
      if (node.type === 'file') {
        if (node.relativePath.startsWith(prefix) && node.relativePath.endsWith('.md')) {
          out.push(node.relativePath.slice(prefix.length));
        }
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    return out;
  }

  /**
   * Sound scan of EVERY `.md` (folder `access.md` + node frontmatter)
   * for genuine role references, indexed by canonical role name. Shares the
   * candidate set and the config-region role-entry parse with the rename
   * rewrite (`findRoleRefsInText` / `rewriteRoleTokensInText`), so the delete
   * warning and the rename rewrite see the SAME references — the warning can no
   * longer undercount frontmatter the rename would touch. A file we cannot read
   * is skipped (this is an advisory read, not the atomic write path): missing a
   * reference here only weakens the warning, it cannot drop access.
   */
  private async scanRoleReferences(
    workspaceId: string,
  ): Promise<Map<string, { path: string; verb: string }[]>> {
    const repoDir = await this.repoDir(workspaceId);
    const candidates = await this.collectCandidateFiles(workspaceId);
    const byRole = new Map<string, { path: string; verb: string }[]>();
    for (const repoRel of candidates) {
      let text: string;
      try {
        text = await fs.readFile(path.join(repoDir, repoRel), 'utf-8');
      } catch {
        continue;
      }
      for (const ref of findRoleRefsInText(text)) {
        const list = byRole.get(ref.role);
        if (list) list.push({ path: repoRel, verb: ref.verb });
        else byRole.set(ref.role, [{ path: repoRel, verb: ref.verb }]);
      }
    }
    return byRole;
  }
}

/**
 * Resolve the [start, end) line range that role rewrites may touch — the YAML
 * config region only, NEVER the markdown body (CodeRabbit: a body line like
 * `- Sales` or `owner: Sales` must not be rewritten).
 *
 *   - A file with leading `---` frontmatter (folder `access.md`, node `.md`):
 *     only the lines BETWEEN the opening and closing `---` are eligible.
 *   - A fence-less file (e.g. a bare `roles.yaml`-style access config with no
 *     `---`): the whole file is config, so all lines are eligible.
 *   - A `.md` file with no frontmatter fence: no config region → empty range,
 *     nothing is rewritten.
 */
function configLineRange(lines: string[], isMarkdown: boolean): { start: number; end: number } {
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') return { start: 1, end: i };
    }
    // Unterminated frontmatter — treat nothing as eligible (don't risk the body).
    return { start: 0, end: 0 };
  }
  // No fence: a markdown file has no config region; a non-markdown access file
  // (no body) is entirely config.
  return isMarkdown ? { start: 0, end: 0 } : { start: 0, end: lines.length };
}

/** A known access verb key: heads a block list or holds a scalar role value. */
const VERB_KEY_RE = /^(\s*)(read|write|download|owner)(:\s*)(.*)$/;
/** A block-list item: `  - <token>` (token may carry a leading `deny `). */
const LIST_ITEM_RE = /^(\s*-\s+)(.*)$/;

/**
 * Walk the CONFIG-REGION lines of `text`, invoking `onRoleRef` for every line
 * that PARSES as a genuine role entry — both the block-list form (`- <token>`
 * under a `read:`/`write:`/… key) and the inline scalar form (`owner: <token>`).
 * `verb` is the access verb the reference sits under; for a block list it is the
 * nearest enclosing verb key (lines before any verb key, or under an unknown
 * key, are skipped). This is the SINGLE source of truth for "what is a role
 * reference" — both the delete-warning scan and the rename rewrite drive off it,
 * so they cannot disagree. The callback may mutate `lines[i]` (the rewrite does;
 * the scan does not). User entries, other keys, comments and substrings never
 * fire it.
 */
function walkRoleRefs(
  lines: string[],
  start: number,
  end: number,
  onRoleRef: (ctx: { i: number; verb: string; entry: { role: string; deny: boolean }; indent: string; prefix: string }) => void,
): void {
  let currentVerb: string | null = null;
  /** A role-entry value → its parsed role entry, else null (user/empty/other). */
  const roleEntry = (rawValue: string): { role: string; deny: boolean } | null => {
    const parsed = parseAccessEntry(rawValue.replace(/\s+$/, ''));
    return parsed.ok && parsed.entry.kind === 'role'
      ? { role: parsed.entry.role, deny: parsed.entry.deny }
      : null;
  };
  for (let i = start; i < end; i++) {
    const line = lines[i];
    // A verb key resets the block context. Its inline value (scalar form,
    // `owner: Sales`) is itself a candidate reference under that same verb.
    const kvM = line.match(VERB_KEY_RE);
    if (kvM) {
      currentVerb = kvM[2];
      const inlineValue = kvM[4];
      if (inlineValue.trim() !== '') {
        const entry = roleEntry(inlineValue);
        if (entry) onRoleRef({ i, verb: currentVerb, entry, indent: `${kvM[1]}${kvM[2]}${kvM[3]}`, prefix: '' });
      }
      continue;
    }
    // Block-list item — belongs to the nearest enclosing verb key. A list item
    // with no verb in scope is not a resolvable access rule; skip it.
    const listM = line.match(LIST_ITEM_RE);
    if (listM && currentVerb !== null) {
      const entry = roleEntry(listM[2]);
      if (entry) onRoleRef({ i, verb: currentVerb, entry, indent: '', prefix: listM[1] });
      continue;
    }
    // A non-empty, non-list, non-kv line ends the current block (e.g. a new
    // top-level key whose value isn't a verb, or stray prose in config).
    if (line.trim() !== '' && !listM) currentVerb = null;
  }
}

/** Every genuine role reference in `text`'s config region, as {role, verb}. */
export function findRoleRefsInText(text: string, isMarkdown = true): { role: string; verb: string }[] {
  const lines = text.split('\n');
  const { start, end } = configLineRange(lines, isMarkdown);
  const out: { role: string; verb: string }[] = [];
  if (start >= end) return out;
  walkRoleRefs(lines, start, end, ({ verb, entry }) => out.push({ role: entry.role, verb }));
  return out;
}

/**
 * Rewrite every CONFIG-REGION line that PARSES as a role reference whose
 * canonical name == `oldCanonical`, replacing the role token with
 * `newDisplayName` (preserving any leading `deny ` and indentation). Only the
 * frontmatter block of a markdown file is touched — the body is left
 * byte-for-byte intact, so a prose line like `- Sales` is never corrupted.
 * Lines that don't parse as a matching role entry (user entries, other keys,
 * substrings) are also untouched. Exported for test.
 *
 * `isMarkdown` (default true) marks files that carry a markdown body below the
 * frontmatter; pass false only for a pure-config file with no body.
 */
export function rewriteRoleTokensInText(
  text: string,
  oldCanonical: string,
  newDisplayName: string,
  isMarkdown = true,
): string {
  const lines = text.split('\n');
  const { start, end } = configLineRange(lines, isMarkdown);
  if (start >= end) return text;
  let changed = false;
  walkRoleRefs(lines, start, end, ({ i, entry, indent, prefix }) => {
    if (entry.role !== oldCanonical) return;
    lines[i] = `${indent}${prefix}${entry.deny ? 'deny ' : ''}${newDisplayName}`;
    changed = true;
  });
  return changed ? lines.join('\n') : text;
}

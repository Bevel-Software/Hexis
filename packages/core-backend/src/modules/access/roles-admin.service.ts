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
  accessMdDeclaresBodyRules,
  canonicalRoleName,
  canonicalEmail,
  isAccessMdPath,
  loadActiveGroups,
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
  addRoleGroupRef as editAddGroupRef,
  removeRoleGroupRef as editRemoveGroupRef,
  isGroupRefMember,
  RolesEditError,
  type EditResult,
} from './roles-edit.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML, validateGroupsFile } from './group-files.js';
import { createGroup as editCreateGroup, addGroupMember as editAddGroupMember, GroupsEditError } from './groups-edit.js';
import { capabilityRoleFor, isLegacyPeopleSetRole } from './capability-registry.js';
import { GROUP_REF_PREFIX } from './access-control.service.js';

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
  /** Individual member EMAILS (group assignments are split into `groups`). */
  members: string[];
  /** Canonical names of groups this role is assigned to (`group:` members). */
  groups: string[];
  isAdmin: boolean;
  /**
   * Registry metadata when this is a CAPABILITY role (Admin today); null for
   * a legacy pre-split people-set role, which the UI flags with a
   * convert-to-group action.
   */
  capability: { description: string; groupAssignable: boolean } | null;
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
 * The known-good `roles.yaml` the break-glass recovery restores. Mirrors the
 * canonical Bevel roster — it is the ONLY content recovery ever writes, so it
 * MUST parse (the post-recovery resolver loads it immediately). Keep the Admin
 * list in sync with the canonical `osapiens-kb/roles.yaml`.
 */
const RECOVERY_DEFAULT_ROLES_YAML = `# Identity → role mapping for access control.
# Role names are case- and whitespace-insensitive. The \`Admin\` role is special:
# only Admins may edit this file, and at least one Admin must always exist.
roles:
  Admin:
    - razvan.radulescu@bevel.software
    - ali.raza@bevel.software
    - juan@bevel.software
`;

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
      const registryEntry = capabilityRoleFor(role.displayName);
      out.push({
        canonical,
        displayName: role.displayName,
        members: role.members.filter((m) => !isGroupRefMember(m)),
        groups: role.members
          .filter(isGroupRefMember)
          .map((m) => canonicalRoleName(m.slice(GROUP_REF_PREFIX.length))),
        isAdmin: canonical === ADMIN_CANONICAL,
        capability: registryEntry
          ? { description: registryEntry.description, groupAssignable: registryEntry.groupAssignable }
          : null,
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

    await this.assertRolesUnlocked(workspaceId, actor);

    // Back up the corrupted bytes and restore the good default atomically. The
    // default is valid, so the resolver loads immediately after this commit.
    const fsys = await this.lockingFsForActor(workspaceId, actor);
    await this.mapLockContention(() =>
      fsys.writeFiles(
        [
          { path: `${this.kbDirName}/${OLD_ROLES_YAML}`, content: current },
          { path: `${this.kbDirName}/${ROLES_YAML}`, content: RECOVERY_DEFAULT_ROLES_YAML },
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

  /** Assign a role to a group (Admin refused — the editor guards this too). */
  async assignGroup(actor: AuthUser, canonical: string, groupName: string): Promise<RoleRosterEntry[]> {
    // Admin carve-out OUTRANKS every other answer — it is absolute, so it
    // must not vary with which groups happen to exist.
    if (canonical === ADMIN_CANONICAL) {
      throw new RolesAdminError(
        'the Admin role cannot be assigned to a group — add individual members instead',
        422,
      );
    }
    // The ref must name a group the ACTIVE source knows: mergeGroupsIntoRoles
    // ignores an unknown ref with only a log warning, so a typo here would be
    // accepted and then silently grant the role to nobody. Fail loudly instead
    // — and hold the manual group file's lock across validate + write, so a
    // concurrent group deletion/rename can't invalidate the ref in between.
    const workspaceId = await this.ensureWorkspace();
    return this.withFileLocks(workspaceId, actor, [GROUPS_YAML], async () => {
      const { groups } = await loadActiveGroups((f) => this.readKbFile(workspaceId, f));
      if (!groups.has(canonicalRoleName(groupName))) {
        throw new RolesAdminError(`No group named "${groupName.trim()}". Pick an existing group.`, 404, {
          kind: 'unknown-group',
          group: groupName.trim(),
        });
      }
      await this.runEdit(actor, (text) => editAddGroupRef(text, canonical, groupName));
      return this.getRoster();
    });
  }

  async unassignGroup(actor: AuthUser, canonical: string, groupName: string): Promise<RoleRosterEntry[]> {
    await this.runEdit(actor, (text) => editRemoveGroupRef(text, canonical, groupName));
    return this.getRoster();
  }

  /**
   * Convert a LEGACY people-set role into a manual group — the migration the
   * roles/groups split defines: "Product" was never a capability, it was a
   * team. Atomic two-file move (roles.yaml loses the role, groups.yaml gains
   * the group with the same members) in ONE commit; grant references keep
   * working untouched because the NAME does not change.
   *
   * Refusals: capability roles (they ARE roles — Admin included), roles with
   * group assignments (unwind those first: a group containing a group is
   * nesting), IdP mode (groups are managed in the identity provider — this
   * would write a retired file), and a groups.yaml name collision (from the
   * group editor).
   */
  async convertRoleToGroup(actor: AuthUser, canonical: string): Promise<RoleRosterEntry[]> {
    const workspaceId = await this.ensureWorkspace();
    if (!isLegacyPeopleSetRole(canonical)) {
      throw new RolesAdminError(`'${canonical}' is a capability role — it cannot become a group`, 422);
    }
    if ((await this.readKbFile(workspaceId, SYNCED_GROUPS_YAML)) !== null) {
      throw new RolesAdminError(
        'Groups are synced from your identity provider — recreate this team there instead.',
        409,
        { kind: 'idp-mode' },
      );
    }
    await this.assertRolesUnlocked(workspaceId, actor);

    // Hold BOTH file locks across read → build → write: candidates are built
    // from a snapshot, and without the hold another admin's edit could land
    // in between and be silently overwritten.
    await this.withFileLocks(workspaceId, actor, [GROUPS_YAML, ROLES_YAML], async () => {
      const rolesText = await this.readRolesYaml(workspaceId);
      const role = parseRolesModel(rolesText).find((r) => canonicalRoleName(r.displayName) === canonical);
      if (!role) throw new RolesAdminError(`role not found: ${canonical}`, 404);
      const groupRefs = role.members.filter(isGroupRefMember);
      if (groupRefs.length > 0) {
        throw new RolesAdminError(
          'This role is assigned to groups — remove those assignments before converting it.',
          422,
        );
      }

      // Build both candidates BEFORE any write, and validate both.
      const rolesEdit = this.guardEdit(() => editDeleteRole(rolesText, canonical));
      this.assertLoadable(rolesEdit.text);
      makeRolesYamlWriteValidator(this.kbDirName)(`${this.kbDirName}/${ROLES_YAML}`, rolesEdit.text);
      // Keep absent (null) distinct from existing-but-empty ('') — rollback
      // must DELETE a groups.yaml it created, not truncate one already there.
      const groupsOriginal = await this.readKbFile(workspaceId, GROUPS_YAML);
      let groupsCandidate: string;
      try {
        groupsCandidate = editCreateGroup(groupsOriginal ?? '', role.displayName).text;
        for (const email of role.members) {
          groupsCandidate = editAddGroupMember(groupsCandidate, canonical, email).text;
        }
      } catch (err) {
        if (err instanceof GroupsEditError) throw new RolesAdminError(err.message, err.status);
        throw err;
      }
      const groupsValid = validateGroupsFile(groupsCandidate, GROUPS_YAML);
      if (!groupsValid.ok) {
        throw new RolesAdminError(`groups.yaml would be invalid: ${groupsValid.errors.join('; ')}`, 422);
      }

      await this.writeAndCommitLocked(
        workspaceId,
        actor,
        [
          { repoRel: ROLES_YAML, content: rolesEdit.text, original: rolesText },
          { repoRel: GROUPS_YAML, content: groupsCandidate, original: groupsOriginal },
        ],
        `Convert role ${role.displayName} to a group`,
      );
    });
    this.accessControl.invalidate(workspaceId);
    this.emitWrites(workspaceId, actor, [ROLES_YAML, GROUPS_YAML]);
    return this.getRoster();
  }

  /** Read a KB-root file; null when absent. */
  private async readKbFile(workspaceId: string, repoRel: string): Promise<string | null> {
    try {
      return await this.workspaceService.readFile(workspaceId, path.posix.join(this.kbDirName, repoRel));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
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
  /**
   * Run `fn` while HOLDING the named KB-file locks (sorted, all-or-nothing):
   * read-modify-write flows must keep the lock across the READ too, or two
   * concurrent edits (another tab, another admin, a conversion) both snapshot
   * the same base and the second write silently discards the first. Lock
   * acquire is STRICT even for the same user, so `fn` writes plainly and
   * commits path-scoped (`writeAndCommitLocked`), never via
   * LockingFilesystem. Release is commit-on-release: a discarding release
   * could throw away a previous holder's still-queued bytes, and `fn`
   * restores its own bytes on failure — anything dirty at release time is
   * either clean (queued commit no-ops) or someone else's work. The ONE
   * exception: a path whose restore itself failed (`unrestoredPaths` on the
   * thrown error) holds known-partial bytes, and committing those is worse
   * than discarding to HEAD.
   */
  private async withFileLocks<T>(
    workspaceId: string,
    actor: AuthUser,
    repoRelFiles: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const paths = repoRelFiles.map((f) => `${this.kbDirName}/${f}`).sort();
    const held: string[] = [];
    let unrestored: Set<string> | null = null;
    try {
      for (const p of paths) {
        const res = await this.workflowService.acquireLock(workspaceId, this.defaultBranch, p, actor);
        if (!res.acquired) {
          throw new RolesAdminError(
            `Roles are being edited by ${res.lock.holderName || 'another admin'}. Try again in a moment.`,
            409,
          );
        }
        held.push(p);
      }
      return await fn();
    } catch (err) {
      unrestored = (err as { unrestoredPaths?: Set<string> } | null)?.unrestoredPaths ?? null;
      throw err;
    } finally {
      for (const h of held) {
        try {
          if (unrestored?.has(h)) {
            await this.workflowService.releaseLockNoCommit(workspaceId, this.defaultBranch, h, actor);
          } else {
            await this.workflowService.releaseLock(workspaceId, this.defaultBranch, h, actor);
          }
        } catch { /* best-effort release */ }
      }
    }
  }

  private async runEdit(
    actor: AuthUser,
    pre: (currentText: string) => EditResult,
  ): Promise<void> {
    const workspaceId = await this.ensureWorkspace();
    await this.assertRolesUnlocked(workspaceId, actor);
    return this.withFileLocks(workspaceId, actor, [ROLES_YAML], () => this.runEditLocked(workspaceId, actor, pre));
  }

  private async runEditLocked(
    workspaceId: string,
    actor: AuthUser,
    pre: (currentText: string) => EditResult,
  ): Promise<void> {
    const text = await this.readRolesYaml(workspaceId);
    const result = this.guardEdit(() => pre(text));
    if (!result.changed) return;
    this.assertLoadable(result.text);
    // The lock is ALREADY OURS (withFileLocks; strict same-user acquire), so
    // LockingFilesystem would contend against our own hold. Apply the same
    // pre-disk validator it would have run, then plain-write + a path-scoped
    // atomic commit.
    makeRolesYamlWriteValidator(this.kbDirName)(`${this.kbDirName}/${ROLES_YAML}`, result.text);
    await this.writeAndCommitLocked(
      workspaceId,
      actor,
      [{ repoRel: ROLES_YAML, content: result.text, original: text }],
      `Update ${ROLES_YAML}`,
    );
    this.accessControl.invalidate(workspaceId);
    this.emitWrites(workspaceId, actor, [ROLES_YAML]);
  }

  /**
   * See groups-admin's twin: the write half of a `withFileLocks` flow.
   * `original: null` = the file did not exist, so restoration DELETES it;
   * paths whose restore failed ride the thrown error as `unrestoredPaths`
   * so `withFileLocks` discards them at release instead of committing
   * known-partial bytes.
   */
  private async writeAndCommitLocked(
    workspaceId: string,
    actor: AuthUser,
    files: { repoRel: string; content: string; original: string | null }[],
    summary: string,
  ): Promise<void> {
    const wsRel = (repoRel: string) => `${this.kbDirName}/${repoRel}`;
    try {
      for (const f of files) await this.workspaceService.writeFile(workspaceId, wsRel(f.repoRel), f.content);
      await this.workflowService.commitChanges(workspaceId, actor, summary, files.map((f) => wsRel(f.repoRel)));
    } catch (err) {
      const unrestored = new Set<string>();
      for (const f of files) {
        try {
          if (f.original === null) await this.workspaceService.deleteFile(workspaceId, wsRel(f.repoRel));
          else await this.workspaceService.writeFile(workspaceId, wsRel(f.repoRel), f.original);
        } catch (restoreErr) {
          // Deleting an already-absent file IS the original state.
          if (f.original === null && (restoreErr as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
          unrestored.add(wsRel(f.repoRel));
          console.warn(`[roles-admin] could not restore ${f.repoRel} after a failed commit`);
        }
      }
      if (unrestored.size > 0 && typeof err === 'object' && err !== null) {
        (err as { unrestoredPaths?: Set<string> }).unrestoredPaths = unrestored;
      }
      throw err;
    }
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
      const rewritten = rewriteRoleTokensInText(text, oldCanonical, newDisplayName, true, isAccessMdPath(repoRel));
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
      for (const ref of findRoleRefsInText(text, true, isAccessMdPath(repoRel))) {
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

/** The line range AFTER the closing frontmatter fence — empty when there is
 *  no fence or it never closes, mirroring `bodyAfterFrontmatter` (a
 *  fence-less access.md is a hard parse error to the resolver, so it is not
 *  a rule source and must not be rewritten). */
function bodyLineRange(lines: string[]): { start: number; end: number } {
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') return { start: i + 1, end: lines.length };
    }
  }
  return { start: 0, end: 0 };
}

/**
 * The line ranges that are RULE SOURCES for this file — the ranges the
 * resolver actually parses rules from, so the scan/rewrite can never miss a
 * rule the resolver enforces:
 *
 *   - A body-governed `access.md` (see {@link accessMdDeclaresBodyRules}):
 *     the BODY carries the folder's rules and the frontmatter carries the
 *     file's own rules — both are rule sources.
 *   - Everything else: the config region as before (frontmatter for markdown,
 *     the whole file for a fence-less config file). A legacy `access.md`'s
 *     body and a node file's body are prose and stay untouchable.
 */
function ruleLineRanges(
  text: string,
  lines: string[],
  isMarkdown: boolean,
  isAccessMd: boolean,
): { start: number; end: number }[] {
  if (isAccessMd && accessMdDeclaresBodyRules(text)) {
    return [configLineRange(lines, true), bodyLineRange(lines)];
  }
  return [configLineRange(lines, isMarkdown)];
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

/**
 * Every genuine role reference in `text`'s rule regions, as {role, verb}.
 * `isAccessMd` marks an `access.md` file, whose BODY is a rule source in the
 * body-governed format — see {@link ruleLineRanges}.
 */
export function findRoleRefsInText(
  text: string,
  isMarkdown = true,
  isAccessMd = false,
): { role: string; verb: string }[] {
  const lines = text.split('\n');
  const out: { role: string; verb: string }[] = [];
  for (const { start, end } of ruleLineRanges(text, lines, isMarkdown, isAccessMd)) {
    if (start >= end) continue;
    walkRoleRefs(lines, start, end, ({ verb, entry }) => out.push({ role: entry.role, verb }));
  }
  return out;
}

/**
 * Rewrite every RULE-REGION line that PARSES as a role reference whose
 * canonical name == `oldCanonical`, replacing the role token with
 * `newDisplayName` (preserving any leading `deny ` and indentation). A prose
 * body is never touched — a line like `- Sales` in a node file or a legacy
 * `access.md` stays byte-for-byte intact; the body is eligible ONLY when the
 * file is a body-governed `access.md` (`isAccessMd` + the body parses as
 * rules), where the body IS what the resolver enforces — see
 * {@link ruleLineRanges}. Lines that don't parse as a matching role entry
 * (user entries, other keys, substrings) are also untouched. Exported for test.
 *
 * `isMarkdown` (default true) marks files that carry a markdown body below the
 * frontmatter; pass false only for a pure-config file with no body.
 */
export function rewriteRoleTokensInText(
  text: string,
  oldCanonical: string,
  newDisplayName: string,
  isMarkdown = true,
  isAccessMd = false,
): string {
  const lines = text.split('\n');
  let changed = false;
  for (const { start, end } of ruleLineRanges(text, lines, isMarkdown, isAccessMd)) {
    if (start >= end) continue;
    walkRoleRefs(lines, start, end, ({ i, entry, indent, prefix }) => {
      if (entry.role !== oldCanonical) return;
      lines[i] = `${indent}${prefix}${entry.deny ? 'deny ' : ''}${newDisplayName}`;
      changed = true;
    });
  }
  return changed ? lines.join('\n') : text;
}

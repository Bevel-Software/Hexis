/**
 * Admin Roles & Members service — MEMBERSHIP editing on the default-branch
 * `roles.yaml`.
 *
 * Roles are APP-DEFINED capabilities (see `capability-registry.ts`): the
 * product decides which roles exist; users can never create, rename, or
 * delete one — those editors are gone. What remains admin-editable is
 * MEMBERSHIP: adding/removing individual emails and assigning/unassigning
 * groups (`group:<canonical>` members), on capability roles and on LEGACY
 * people-set roles alike (pre-split roles keep resolving and stay editable;
 * `convertRoleToGroup` is their migration path).
 *
 * It is the ONLY writer of `roles.yaml` outside a hand-edit, and it is built
 * around one non-negotiable safety property:
 *
 *   roles.yaml has NO admin-rescue (canWrite('roles.yaml') is a pure isAdmin
 *   check) and loadModel HARD-THROWS on a parse failure (which isAdmin swallows
 *   into false for EVERYONE). So a single malformed write = a permanent,
 *   app-wide, in-app-unrecoverable admin lockout. Every mutation therefore runs
 *   the candidate text through the resolver's OWN parser (validateRolesYaml)
 *   before a byte hits disk; on any error it writes nothing. That parser also
 *   carries the Admin invariant — at least one DIRECT email member, group
 *   references alone are never enough — so no write path can land a
 *   directory-dependent Admin.
 *
 * Lock/commit plumbing is the SHARED `AdminLockedCommits` helper (one
 * implementation for this service and the groups admin — the twins diverged
 * once into a real bug). Reference scanning is the SHARED
 * `KbReferenceScanner` (cached, so roster mutations don't rerun the full-KB
 * sweep the GET pays for).
 */

import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import type { AuthUser, IWorkspaceService, IWorkflowService } from '@bevel-software/platform-shared';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import type { IAccessControl } from './access-control.interface.js';
import {
  ADMIN_CANONICAL,
  ROLE_TOKEN_PREFIX,
  canonicalRoleName,
  canonicalEmail,
  loadActiveGroups,
} from './access-control.service.js';
import { makeRolesYamlWriteValidator } from './roles-yaml-guard.js';
import { renderRolesYaml } from './render-roles-yaml.js';
import {
  parseRolesModel,
  deleteRole as editDeleteRole,
  addMember as editAddMember,
  removeMember as editRemoveMember,
  addRoleGroupRef as editAddGroupRef,
  removeRoleGroupRef as editRemoveGroupRef,
  isGroupRefMember,
  RolesEditError,
  type EditResult,
} from './roles-edit.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML, validateGroupsFile } from './group-files.js';
import {
  GroupsEditError,
  assertSafeGroupDisplayName,
  emitGroupsModel,
  parseGroupsModel,
} from './groups-edit.js';
import { capabilityRoleFor, isLegacyPeopleSetRole } from './capability-registry.js';
import { GROUP_REF_PREFIX, RESERVED_ROLE_NAMES } from './access-control.service.js';
import { AdminLockedCommits } from './admin-locked-commit.js';
import { KbReferenceScanner } from './reference-scan.js';

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
   * frontmatter, under EITHER spelling (the bare token or `role/<name>`).
   * Sound: this is the SAME scan the group rename/delete rewrites use.
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
 * resolver loads it immediately) — guaranteed by delegating to the shared
 * validated renderer, which parse-backs its output and throws an actionable
 * message on a malformed ADMIN_EMAIL (instead of the write-validator
 * rejecting the finished file deep in the write path). `null` provenance:
 * the seed-time "generated at KB-seed time" comment would mislead on a
 * recovery-restored file.
 */
function renderRecoveryRolesYaml(admins: readonly string[]): string {
  return renderRolesYaml(admins, null);
}

/** Health of the default-branch roles.yaml: does the resolver's parser accept it? */
export interface RolesConfigHealth {
  ok: boolean;
  errors: string[];
}

export class RolesAdminService {
  /** Shared lock/commit plumbing — see module doc. */
  private readonly locked: AdminLockedCommits;
  /** Shared cached reference scanner — see module doc. */
  private readonly references: KbReferenceScanner;

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
  ) {
    this.locked = new AdminLockedCommits({
      workspaceService,
      workflowService,
      kbDirName,
      defaultBranchOf,
      makeError: (message, status, payload) => new RolesAdminError(message, status, payload),
      logTag: 'roles-admin',
      contendedSubject: 'Roles',
      // Defence in depth: this surface already validates candidates before
      // writing, but the same pre-disk gate the editor/agent use guarantees a
      // malformed roles.yaml can never land through here either.
      validateWrite: makeRolesYamlWriteValidator(kbDirName),
    });
    this.references = new KbReferenceScanner(workspaceService, kbDirName);
  }

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

  /**
   * Fail fast with a friendly 409 if roles.yaml is already locked by someone
   * else. The actual lock is taken by the write that follows; this only
   * preserves the explicit "being edited by X" contract (the raw contention
   * error is status-less and would surface as 500).
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

  private async readRolesYaml(workspaceId: string): Promise<string> {
    return (await this.locked.readKbFile(workspaceId, ROLES_YAML)) ?? '';
  }

  // ---- Read -------------------------------------------------------------

  /** The roster: every role on the default branch with members + references. */
  async getRoster(): Promise<RoleRosterEntry[]> {
    const workspaceId = await this.ensureWorkspace();
    const text = await this.readRolesYaml(workspaceId);
    const model = parseRolesModel(text);
    // ONE sound scan of every `.md` (folder access.md + node frontmatter) —
    // cached in the shared scanner, so mutations returning the fresh roster
    // don't rerun the full-KB sweep — indexed by canonical entry token. A
    // role is referenced under either spelling: bare name or `role/<name>`.
    const referencesByToken = await this.references.scan(workspaceId);
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
        referencedBy: [
          ...(referencesByToken.get(canonical) ?? []),
          ...(referencesByToken.get(`${ROLE_TOKEN_PREFIX}${canonical}`) ?? []),
        ],
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
    const fsys = await this.locked.lockingFsForActor(workspaceId, actor);
    await this.locked.mapLockContention(() =>
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
  //
  // MEMBERSHIP ONLY. There is deliberately no createRole / renameRole /
  // deleteRole: roles are app-defined capabilities (see capability-registry),
  // so the admin surface cannot mint, rebrand, or retire one. Legacy roles
  // migrate out via convertRoleToGroup.

  async addMember(actor: AuthUser, canonical: string, email: string): Promise<RoleRosterEntry[]> {
    await this.runEdit(actor, (text) => editAddMember(text, canonical, email));
    return this.getRoster();
  }

  /**
   * Remove a member. Refuses to remove the Admin role's LAST DIRECT EMAIL
   * (422) — the kept invariant: whatever groups Admin references, at least
   * one directory-independent email member must remain, or a broken IdP
   * connection becomes an admin lockout. Removing the caller's OWN last
   * Admin membership requires `confirm` (409 otherwise) — no silent
   * self-lockout, since admin status is read live from this file.
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
        // The invariant counts DIRECT emails only — group refs don't rescue.
        const directMembers = (admin?.members ?? []).filter((m) => !isGroupRefMember(m));
        if (directMembers.includes(target) && directMembers.length <= 1) {
          throw new RolesAdminError(
            'The Admin role must keep at least one direct email member — group references alone are not enough.',
            422,
          );
        }
        if (target === canonicalEmail(actor.email) && directMembers.includes(target) && !confirm) {
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
   * Assign a role to a group — Admin included (the parse-time invariant keeps
   * at least one direct email on Admin, so a group ref can never be its only
   * membership).
   *
   * The ref must name a group the ACTIVE source knows: mergeGroupsIntoRoles
   * ignores an unknown ref with only a log warning, so a typo here would be
   * accepted and then silently grant the role to nobody. The check is
   * BEST-EFFORT validation, not a race-free guarantee: the manual group
   * file's lock is held across validate + write (so a concurrent groups-page
   * deletion/rename can't invalidate the ref mid-flight), but the IdP sync
   * writer commits through its own lock — a provisioning push can retire the
   * group between this check and the next sync. That is fine by design: a
   * dangling ref resolves to nothing, with a resolver warning naming it.
   */
  async assignGroup(actor: AuthUser, canonical: string, groupName: string): Promise<RoleRosterEntry[]> {
    const workspaceId = await this.ensureWorkspace();
    await this.locked.withFileLocks(workspaceId, actor, [GROUPS_YAML], async () => {
      const { groups } = await loadActiveGroups((f) => this.locked.readKbFile(workspaceId, f));
      if (!groups.has(canonicalRoleName(groupName))) {
        throw new RolesAdminError(`No group named "${groupName.trim()}". Pick an existing group.`, 404, {
          kind: 'unknown-group',
          group: groupName.trim(),
        });
      }
      await this.runEdit(actor, (text) => editAddGroupRef(text, canonical, groupName));
    });
    return this.getRoster();
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
   * would write a retired file), and a groups.yaml name collision.
   */
  async convertRoleToGroup(actor: AuthUser, canonical: string): Promise<RoleRosterEntry[]> {
    const workspaceId = await this.ensureWorkspace();
    if (!isLegacyPeopleSetRole(canonical)) {
      throw new RolesAdminError(`'${canonical}' is a capability role — it cannot become a group`, 422);
    }
    if ((await this.locked.readKbFile(workspaceId, SYNCED_GROUPS_YAML)) !== null) {
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
    await this.locked.withFileLocks(workspaceId, actor, [GROUPS_YAML, ROLES_YAML], async () => {
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
      // ONE parse + ONE emit: the group candidate is built on the model
      // directly (name-safety + reserved + duplicate checks inline), not via
      // per-member editor round-trips that each re-parse the whole file.
      const groupsOriginal = await this.locked.readKbFile(workspaceId, GROUPS_YAML);
      let groupsCandidate: string;
      try {
        assertSafeGroupDisplayName(role.displayName);
        if (RESERVED_ROLE_NAMES.has(canonical)) {
          throw new GroupsEditError(`'${role.displayName}' is a reserved name and cannot be a group`);
        }
        const groupsModel = parseGroupsModel(groupsOriginal ?? '');
        if (groupsModel.some((g) => canonicalRoleName(g.displayName) === canonical)) {
          throw new GroupsEditError(`a group named '${role.displayName}' already exists`);
        }
        groupsModel.push({ displayName: role.displayName, members: [...role.members] });
        groupsCandidate = emitGroupsModel(groupsModel);
      } catch (err) {
        if (err instanceof GroupsEditError) throw new RolesAdminError(err.message, err.status);
        throw err;
      }
      const groupsValid = validateGroupsFile(groupsCandidate, GROUPS_YAML);
      if (!groupsValid.ok) {
        throw new RolesAdminError(`groups.yaml would be invalid: ${groupsValid.errors.join('; ')}`, 422);
      }

      await this.locked.writeAndCommitLocked(
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
   * Single-file roles.yaml mutation under the shared file-lock/commit helper.
   * `pre` produces the candidate (and may throw RolesAdminError for invariant
   * violations before any write). Skips on a no-op. Every candidate passes
   * the resolver's own parser (assertLoadable) plus the pre-disk validator
   * before a byte lands.
   */
  private async runEdit(
    actor: AuthUser,
    pre: (currentText: string) => EditResult,
  ): Promise<void> {
    const workspaceId = await this.ensureWorkspace();
    await this.assertRolesUnlocked(workspaceId, actor);
    return this.locked.withFileLocks(workspaceId, actor, [ROLES_YAML], () =>
      this.runEditLocked(workspaceId, actor, pre),
    );
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
    await this.locked.writeAndCommitLocked(
      workspaceId,
      actor,
      [{ repoRel: ROLES_YAML, content: result.text, original: text }],
      `Update ${ROLES_YAML}`,
    );
    this.accessControl.invalidate(workspaceId);
    this.emitWrites(workspaceId, actor, [ROLES_YAML]);
  }
}

/**
 * Admin Groups service — CRUD on the default-branch `groups.yaml` (manual
 * mode), the mode probe, and the connect-time retirement of manual groups.
 *
 * Shares `RolesAdminService`'s write pipeline via the SHARED
 * `AdminLockedCommits` helper (one lock/commit implementation — the twin
 * copies diverged once into a real bug) with the policy differences the
 * roles/groups split defines:
 *
 *   - MODE GATE: every mutation refuses in IdP mode (`synced-groups.yaml`
 *     exists on the default branch). Groups are managed in the identity
 *     provider then; a second write surface would fragment org management —
 *     which is the thing the mode model exists to prevent.
 *   - COLLISION GATE: create/rename refuse a name whose canonical form is a
 *     roles.yaml role. Bare-name precedence would let the group win, but a
 *     deliberately-created shadow of a capability role is far more likely a
 *     mistake than an intent — the IdP can still produce collisions, which
 *     precedence then resolves (group first, `role/<name>` for the role).
 *   - DEGRADE LOUDLY: a broken groups source never fails access resolution
 *     closed — groups contribute nothing and the model carries a
 *     `groupsHealth` marker, which the roster exposes so the Groups page can
 *     banner it. A broken MANUAL groups.yaml additionally makes the roster
 *     answer 422 with the parse message (the operator must see what to fix —
 *     never a dead Groups page, never a silent empty roster they might
 *     "repair" by re-creating groups over live bytes).
 */

import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import type { AuthUser, IWorkspaceService, IWorkflowService } from '@bevel-software/platform-shared';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import type { IAccessControl } from './access-control.interface.js';
import {
  GROUP_REF_PREFIX,
  canonicalRoleName,
  loadActiveGroups,
  type GroupsHealth,
} from './access-control.service.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML, validateGroupsFile } from './group-files.js';
import { parseRolesModel, removeGroupRefsEverywhere, renameGroupRefs, isGroupRefMember } from './roles-edit.js';
import { makeRolesYamlWriteValidator } from './roles-yaml-guard.js';
import {
  GroupsEditError,
  parseGroupsModel,
  createGroup as editCreateGroup,
  deleteGroup as editDeleteGroup,
  addGroupMember as editAddMember,
  removeGroupMember as editRemoveMember,
  renameGroupDisplay as editRenameDisplay,
  type GroupsEditResult,
} from './groups-edit.js';
import { AdminLockedCommits, type LockedWrite } from './admin-locked-commit.js';
import { KbReferenceScanner } from './reference-scan.js';

/** Where role→group assignments live (`group:<canonical>` member entries). */
const ROLES_YAML = 'roles.yaml';

/** A group mutation that cannot proceed. `payload.kind` distinguishes the
 *  mode refusal (`'idp-mode'`) for the UI. */
export class GroupsAdminError extends WorkflowDomainError {
  constructor(message: string, status = 422, payload?: Record<string, unknown>) {
    super(message, status, payload);
    this.name = 'GroupsAdminError';
  }
}

export type GroupsMode = 'manual' | 'idp';

export interface GroupRosterEntry {
  canonical: string;
  displayName: string;
  members: string[];
  /** Every access rule referencing this group — same scan the rename uses. */
  referencedBy: { path: string; verb: string }[];
  /**
   * Canonical names of roles carrying a `group:<canonical>` assignment to
   * this group — so the delete confirm can warn that those roles will lose
   * the members they inherit through it (deleteGroup unassigns them
   * atomically).
   */
  assignedToRoles: string[];
}

export interface GroupsRoster {
  mode: GroupsMode;
  groups: GroupRosterEntry[];
  /**
   * Health of the active groups source — `ok: false` when the source exists
   * but is unreadable/unparseable (resolution degrades: groups contribute
   * nothing). Shipped for the Groups page banner (frontend increment).
   */
  groupsHealth: GroupsHealth;
}

export class GroupsAdminService {
  /** Shared lock/commit plumbing — see module doc. */
  private readonly locked: AdminLockedCommits;
  /** Shared cached reference scanner. */
  private readonly references: KbReferenceScanner;

  constructor(
    private readonly workspaceService: IWorkspaceService,
    private readonly workflowService: IWorkflowService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    /** Live-binding thunk — see RolesAdminService's identical note. */
    private readonly defaultBranchOf: () => string,
    private readonly eventBus?: WorkflowEventBus,
  ) {
    this.locked = new AdminLockedCommits({
      workspaceService,
      workflowService,
      kbDirName,
      defaultBranchOf,
      makeError: (message, status, payload) => new GroupsAdminError(message, status, payload),
      logTag: 'groups-admin',
      contendedSubject: 'Groups',
      // The rename/delete batch may rewrite roles.yaml (group:<ref> members)
      // — same pre-disk no-lockout gate the roles admin attaches.
      validateWrite: makeRolesYamlWriteValidator(kbDirName),
    });
    this.references = new KbReferenceScanner(workspaceService, kbDirName);
  }

  private get defaultBranch(): string {
    return this.defaultBranchOf();
  }

  private get workspaceId(): string {
    return workspaceIdForBranch(this.defaultBranch);
  }

  private async ensureWorkspace(): Promise<string> {
    await this.workspaceService.getOrCreateForBranch(this.defaultBranch);
    return this.workspaceId;
  }

  /**
   * IdP mode iff `synced-groups.yaml` exists — same rule the resolver applies.
   *
   * KNOWN GAP, deliberate: this cannot see the connect WINDOW — a directory
   * connection that is configured but whose first provisioning push has not
   * landed the synced file yet. Core's `SyncedGroupsSource` seam exposes only
   * `listGroups()` (the overlay owns the connection), so "connected but not
   * yet materialized" is not cheaply knowable server-side; the UI keeps its
   * own suppression for that window.
   */
  async getMode(): Promise<GroupsMode> {
    const workspaceId = await this.ensureWorkspace();
    return (await this.locked.readKbFile(workspaceId, SYNCED_GROUPS_YAML)) !== null ? 'idp' : 'manual';
  }

  // ---- Read ---------------------------------------------------------------

  /**
   * Mode + roster + source health. Reads the ACTIVE source through the same
   * `loadActiveGroups` rule the resolver applies, so mode, health, and the
   * group set can never disagree with resolution:
   *
   *   - IdP mode (synced file present, even broken): the roster IS the synced
   *     file — read-only in the UI; the manual file is retired and showing it
   *     would misreport who has access. A broken synced file yields an EMPTY
   *     roster with the `groupsHealth` marker (mode stays 'idp' — no
   *     fallback to manual, which would resurrect retired groups).
   *   - Manual mode, broken groups.yaml: 422 with the parse message — the
   *     repair path must show the operator what to fix, never a dead page.
   */
  async getRoster(): Promise<GroupsRoster> {
    const workspaceId = await this.ensureWorkspace();
    const active = await loadActiveGroups((f) => this.locked.readKbFile(workspaceId, f));
    if (active.sourceFile === GROUPS_YAML && !active.health.ok) {
      throw new GroupsAdminError(`groups.yaml cannot be read: ${active.health.reason}`, 422, {
        kind: 'broken-groups',
        file: active.health.file,
        reason: active.health.reason,
      });
    }
    const [referencesByToken, assignedByGroup] = await Promise.all([
      this.references.scan(workspaceId),
      this.rolesReferencingGroups(workspaceId),
    ]);
    const mode: GroupsMode = active.sourceFile === SYNCED_GROUPS_YAML ? 'idp' : 'manual';
    const groups: GroupRosterEntry[] = [];
    for (const [canonical, def] of active.groups) {
      groups.push({
        canonical,
        displayName: def.displayName,
        // IdP members render sorted (machine-generated file, no author order
        // to honour); manual members keep file order (the editor's view).
        members: mode === 'idp' ? [...def.emails].sort() : [...def.emails],
        referencedBy: referencesByToken.get(canonical) ?? [],
        assignedToRoles: assignedByGroup.get(canonical) ?? [],
      });
    }
    return { mode, groups, groupsHealth: active.health };
  }

  /**
   * Display names from the ACTIVE group source (synced in IdP mode, manual
   * otherwise). Malformed files degrade to an empty list, matching the
   * resolver's degrade rule.
   */
  async listActiveGroupNames(): Promise<string[]> {
    const workspaceId = await this.ensureWorkspace();
    const active = await loadActiveGroups((f) => this.locked.readKbFile(workspaceId, f));
    return [...active.groups.values()].map((g) => g.displayName);
  }

  /** Manual group display names — what the connect-time warning dialog lists. */
  async listManualGroupNames(): Promise<string[]> {
    const workspaceId = await this.ensureWorkspace();
    const text = (await this.locked.readKbFile(workspaceId, GROUPS_YAML)) ?? '';
    return parseGroupsModel(text).map((g) => g.displayName);
  }

  // ---- Mutations ----------------------------------------------------------

  async createGroup(actor: AuthUser, displayName: string): Promise<GroupsRoster> {
    // Mode gate FIRST: in IdP mode every mutation must answer the typed 409
    // (the UI's cue to point at the identity provider) — a name-collision 422
    // for a name like "Admin" would mislead about what is actually refused.
    await this.assertManualMode(await this.ensureWorkspace());
    await this.assertRoleNameFree(displayName);
    await this.runEdit(actor, (text) => editCreateGroup(text, displayName));
    return this.getRoster();
  }

  /**
   * Delete a group AND unassign it from every role — the `group:<canonical>`
   * members in roles.yaml — in the SAME atomic locked commit (mirror of the
   * rename's ref rewrite): a delete that left the refs would silently shrink
   * each assigned role's membership behind a mere log warning. Grant
   * references in access.md are NOT touched — a dangling grant resolves to
   * nothing by design (and the roster's `referencedBy` fed the confirm
   * dialog's warning).
   */
  async deleteGroup(actor: AuthUser, canonical: string): Promise<GroupsRoster> {
    const workspaceId = await this.ensureWorkspace();
    await this.assertManualMode(workspaceId);
    await this.locked.withFileLocks(workspaceId, actor, [GROUPS_YAML, ROLES_YAML], async () => {
      const groupsOriginal = await this.locked.readKbFile(workspaceId, GROUPS_YAML);
      const groupsEdit = this.guardEdit(() => editDeleteGroup(groupsOriginal ?? '', canonical));
      this.assertLoadable(groupsEdit.text);
      const files: LockedWrite[] = [
        { repoRel: GROUPS_YAML, content: groupsEdit.text, original: groupsOriginal },
      ];
      const rolesText = await this.locked.readKbFile(workspaceId, ROLES_YAML);
      if (rolesText !== null) {
        let rolesEdit: { text: string; changed: boolean };
        try {
          rolesEdit = removeGroupRefsEverywhere(rolesText, canonical);
        } catch (err) {
          // Fail closed on a malformed roles.yaml: deleting the group without
          // unassigning it would strand dangling refs the delete exists to clean.
          throw new GroupsAdminError(
            `Cannot rewrite role assignments in ${ROLES_YAML}; delete aborted with no changes`,
            422,
            { cause: (err as Error)?.message },
          );
        }
        if (rolesEdit.changed) {
          // Same pre-disk no-lockout gate LockingFilesystem would have run.
          makeRolesYamlWriteValidator(this.kbDirName)(`${this.kbDirName}/${ROLES_YAML}`, rolesEdit.text);
          files.push({ repoRel: ROLES_YAML, content: rolesEdit.text, original: rolesText });
        }
      }
      await this.locked.writeAndCommitLocked(
        workspaceId,
        actor,
        files,
        `Delete group ${canonical}`,
      );
      this.afterWrite(workspaceId, actor, files.map((f) => f.repoRel));
    });
    return this.getRoster();
  }

  async addMember(actor: AuthUser, canonical: string, email: string): Promise<GroupsRoster> {
    await this.runEdit(actor, (text) => editAddMember(text, canonical, email));
    return this.getRoster();
  }

  async removeMember(actor: AuthUser, canonical: string, email: string): Promise<GroupsRoster> {
    await this.runEdit(actor, (text) => editRemoveMember(text, canonical, email));
    return this.getRoster();
  }

  /**
   * Rename — canonical-changing renames rewrite every grant reference in ONE
   * atomic commit (same machinery, same reasoning as ref unassignment on
   * delete: a partial rewrite is a silent access drop).
   */
  async renameGroup(actor: AuthUser, canonical: string, newDisplayName: string): Promise<GroupsRoster> {
    const workspaceId = await this.ensureWorkspace();
    await this.assertManualMode(workspaceId);
    const newCanonical = canonicalRoleName(newDisplayName);
    if (newCanonical !== canonical) await this.assertRoleNameFree(newDisplayName);

    // Both roster files are read AND rewritten from snapshots — hold their
    // locks across the whole build so a concurrent roster edit can't land in
    // between and be overwritten by the batch.
    await this.locked.withFileLocks(workspaceId, actor, [GROUPS_YAML, ROLES_YAML], () =>
      this.renameGroupLocked(workspaceId, actor, canonical, newCanonical, newDisplayName),
    );
    return this.getRoster();
  }

  private async renameGroupLocked(
    workspaceId: string,
    actor: AuthUser,
    canonical: string,
    newCanonical: string,
    newDisplayName: string,
  ): Promise<void> {
    const text = (await this.locked.readKbFile(workspaceId, GROUPS_YAML)) ?? '';
    const groupsEdit = this.guardEdit(() => editRenameDisplay(text, canonical, newDisplayName));
    const files: LockedWrite[] = [];
    if (groupsEdit.changed) {
      this.assertLoadable(groupsEdit.text);
      files.push({ repoRel: GROUPS_YAML, content: groupsEdit.text, original: text });
    }
    if (newCanonical !== canonical) {
      // Grant references (bare tokens in access.md + node frontmatter). The
      // rewrite returns each file's ORIGINAL text alongside the new content,
      // so the rollback snapshots reuse the read it already did — no second
      // full-KB pass. Explicit `role/<name>` tokens are untouched by design:
      // they reference the ROLE, not this group.
      const refWrites = await this.references.rewriteReferences(
        workspaceId,
        canonical,
        newDisplayName.trim(),
        (message, cause) => new GroupsAdminError(message, 422, { cause }),
      );
      for (const w of refWrites) {
        files.push({ repoRel: w.repoRelativePath, content: w.content, original: w.original });
      }
      // Role→group assignments live in roles.yaml as `group:<canonical>` —
      // stored canonical, so they go stale on a canonical-changing rename and
      // the role would silently stop expanding to the group's members. Rewrite
      // them in the SAME atomic commit. Fail closed on a malformed roles.yaml:
      // committing the rename without it would strand any refs it holds.
      const rolesText = await this.locked.readKbFile(workspaceId, ROLES_YAML);
      if (rolesText !== null) {
        let rolesEdit: { text: string; changed: boolean };
        try {
          rolesEdit = renameGroupRefs(rolesText, canonical, newCanonical);
        } catch (err) {
          throw new GroupsAdminError(
            `Cannot rewrite role assignments in ${ROLES_YAML}; rename aborted with no changes`,
            422,
            { cause: (err as Error)?.message },
          );
        }
        if (rolesEdit.changed) {
          // Same pre-disk no-lockout gate LockingFilesystem would have run —
          // the plain-write path must not lose it (a roles.yaml that fails
          // the resolver's parser is an app-wide admin lockout).
          makeRolesYamlWriteValidator(this.kbDirName)(`${this.kbDirName}/${ROLES_YAML}`, rolesEdit.text);
          files.push({ repoRel: ROLES_YAML, content: rolesEdit.text, original: rolesText });
        }
      }
    }
    if (files.length === 0) return;

    // Roster locks are already ours (withFileLocks; strict same-user acquire
    // forbids LockingFilesystem here). Grant-reference candidates are written
    // unlocked — same exposure every reference rewrite has always had.
    await this.locked.writeAndCommitLocked(
      workspaceId,
      actor,
      files,
      `Rename group ${canonical} → ${newDisplayName.trim()}`,
    );
    this.afterWrite(workspaceId, actor, files.map((f) => f.repoRel));
  }

  /**
   * Connect-time retirement: delete `groups.yaml` in one commit. Called by the
   * SCIM connect flow AFTER the admin confirmed the warning dialog ("groups
   * you don't recreate in the IdP will be lost"). Recovery is a git revert —
   * the file's history keeps every retired group. No-op when the file is
   * already absent.
   */
  async retireManualGroups(actor: AuthUser): Promise<boolean> {
    const workspaceId = await this.ensureWorkspace();
    if ((await this.locked.readKbFile(workspaceId, GROUPS_YAML)) === null) return false;
    const fsys = await this.locked.lockingFsForActor(workspaceId, actor);
    await this.locked.mapLockContention(() =>
      fsys.writeFiles(
        [],
        'Retire manual groups — directory sync connected',
        [`${this.kbDirName}/${GROUPS_YAML}`],
      ),
    );
    this.afterWrite(workspaceId, actor, [GROUPS_YAML]);
    return true;
  }

  // ---- Internals ----------------------------------------------------------

  private guardEdit(fn: () => GroupsEditResult): GroupsEditResult {
    try {
      return fn();
    } catch (err) {
      if (err instanceof GroupsEditError) throw new GroupsAdminError(err.message, err.status);
      throw err;
    }
  }

  private assertLoadable(candidate: string): void {
    const v = validateGroupsFile(candidate, GROUPS_YAML);
    if (!v.ok) {
      throw new GroupsAdminError(`groups.yaml would be invalid: ${v.errors.join('; ')}`, 422);
    }
  }

  private async assertManualMode(workspaceId: string): Promise<void> {
    if ((await this.locked.readKbFile(workspaceId, SYNCED_GROUPS_YAML)) !== null) {
      throw new GroupsAdminError(
        'Groups are synced from your identity provider — manage membership there.',
        409,
        { kind: 'idp-mode' },
      );
    }
  }

  /**
   * Refuse a group name that IS a role. Bare-name precedence (group-first)
   * would make the group win resolution, so this is deliberate FRICTION, not
   * a correctness need: an admin naming a group after a capability role is
   * far more likely shadowing by accident than by intent. IdP-sourced
   * collisions still happen (the sync writer doesn't consult roles.yaml) and
   * precedence resolves them.
   */
  private async assertRoleNameFree(displayName: string): Promise<void> {
    const workspaceId = await this.ensureWorkspace();
    const canonical = canonicalRoleName(displayName);
    const rolesText = (await this.locked.readKbFile(workspaceId, 'roles.yaml')) ?? '';
    let roles;
    try {
      roles = parseRolesModel(rolesText);
    } catch {
      // A broken roles.yaml cannot vouch for the name being free — refuse
      // rather than let a group land that may shadow a role once repaired.
      throw new GroupsAdminError('roles.yaml is not readable — fix it before creating groups.', 409);
    }
    if (roles.some((r) => canonicalRoleName(r.displayName) === canonical)) {
      throw new GroupsAdminError(
        `'${displayName.trim()}' is a role name — name the group something else (a role can be referenced explicitly as 'role/${canonical}').`,
        422,
      );
    }
  }

  /**
   * Which roles carry a `group:<canonical>` assignment, per group canonical.
   * Advisory (feeds the roster's `assignedToRoles` warning field): a broken
   * roles.yaml yields an empty map rather than failing the roster.
   */
  private async rolesReferencingGroups(workspaceId: string): Promise<Map<string, string[]>> {
    const rolesText = (await this.locked.readKbFile(workspaceId, ROLES_YAML)) ?? '';
    const byGroup = new Map<string, string[]>();
    let roles;
    try {
      roles = parseRolesModel(rolesText);
    } catch {
      return byGroup;
    }
    for (const role of roles) {
      const roleCanonical = canonicalRoleName(role.displayName);
      for (const member of role.members) {
        if (!isGroupRefMember(member)) continue;
        const groupCanonical = canonicalRoleName(member.slice(GROUP_REF_PREFIX.length));
        const list = byGroup.get(groupCanonical);
        if (list) {
          if (!list.includes(roleCanonical)) list.push(roleCanonical);
        } else {
          byGroup.set(groupCanonical, [roleCanonical]);
        }
      }
    }
    return byGroup;
  }

  private async runEdit(actor: AuthUser, pre: (text: string) => GroupsEditResult): Promise<void> {
    const workspaceId = await this.ensureWorkspace();
    await this.assertManualMode(workspaceId);
    return this.locked.withFileLocks(workspaceId, actor, [GROUPS_YAML], () =>
      this.runEditLocked(workspaceId, actor, pre),
    );
  }

  private async runEditLocked(
    workspaceId: string,
    actor: AuthUser,
    pre: (text: string) => GroupsEditResult,
  ): Promise<void> {
    // Keep absent (null) distinct from existing-but-empty ('') — rollback
    // must DELETE a file it created, not truncate one that was already there.
    const original = await this.locked.readKbFile(workspaceId, GROUPS_YAML);
    const result = this.guardEdit(() => pre(original ?? ''));
    if (!result.changed) return;
    this.assertLoadable(result.text);
    await this.locked.writeAndCommitLocked(
      workspaceId,
      actor,
      [{ repoRel: GROUPS_YAML, content: result.text, original }],
      `Update ${GROUPS_YAML}`,
    );
    this.afterWrite(workspaceId, actor, [GROUPS_YAML]);
  }

  private afterWrite(workspaceId: string, actor: AuthUser, repoRelPaths: string[]): void {
    this.accessControl.invalidate(workspaceId);
    // Any write in this batch may have moved grant references (`.md`
    // rewrites on rename); drop the cached scan so the next roster is fresh.
    if (repoRelPaths.some((p) => p.endsWith('.md'))) this.references.invalidate(workspaceId);
    if (!this.eventBus) return;
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
}

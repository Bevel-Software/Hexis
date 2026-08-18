/**
 * Admin Groups service — CRUD on the default-branch `groups.yaml` (manual
 * mode), the mode probe, and the connect-time retirement of manual groups.
 *
 * Mirrors `RolesAdminService`'s write pipeline (lock-aware filesystem →
 * commit+push attributed to the actor, friendly 409 on contention) with the
 * policy differences the roles/groups split defines:
 *
 *   - MODE GATE: every mutation refuses in IdP mode (`synced-groups.yaml`
 *     exists on the default branch). Groups are managed in the identity
 *     provider then; a second write surface would fragment org management —
 *     which is the thing the mode model exists to prevent.
 *   - COLLISION GATE: create/rename refuse a name whose canonical form is a
 *     roles.yaml role. One namespace, roles win — a group may never shadow a
 *     role.
 *   - NO lockout machinery: a broken groups.yaml degrades to "contributes
 *     nothing" in the resolver, so there is no recovery path to carry. The
 *     validate gate here exists to keep the file HEALTHY, not to prevent a
 *     catastrophe.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import { LockingFilesystem } from '../workflow/locking-filesystem.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import type { AuthUser, FileTreeEntry, IWorkspaceService, IWorkflowService } from '@bevel-software/platform-shared';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';
import type { IAccessControl } from './access-control.interface.js';
import { canonicalRoleName } from './access-control.service.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML, parseGroupsFile, validateGroupsFile } from './group-files.js';
import { findRoleRefsInText, rewriteRoleTokensInText } from './roles-admin.service.js';
import { parseRolesModel } from './roles-edit.js';
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
}

export interface GroupsRoster {
  mode: GroupsMode;
  groups: GroupRosterEntry[];
}

export class GroupsAdminService {
  constructor(
    private readonly workspaceService: IWorkspaceService,
    private readonly workflowService: IWorkflowService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    /** Live-binding thunk — see RolesAdminService's identical note. */
    private readonly defaultBranchOf: () => string,
    private readonly eventBus?: WorkflowEventBus,
  ) {}

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

  private async readKbFile(workspaceId: string, repoRel: string): Promise<string | null> {
    try {
      return await this.workspaceService.readFile(workspaceId, path.posix.join(this.kbDirName, repoRel));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  }

  /** IdP mode iff `synced-groups.yaml` exists — same rule the resolver applies. */
  async getMode(): Promise<GroupsMode> {
    const workspaceId = await this.ensureWorkspace();
    return (await this.readKbFile(workspaceId, SYNCED_GROUPS_YAML)) !== null ? 'idp' : 'manual';
  }

  // ---- Read ---------------------------------------------------------------

  async getRoster(): Promise<GroupsRoster> {
    const workspaceId = await this.ensureWorkspace();
    const syncedText = await this.readKbFile(workspaceId, SYNCED_GROUPS_YAML);
    const referencesByName = await this.scanReferences(workspaceId);

    // IdP mode: the roster IS the synced file (read-only in the UI); the
    // manual file is retired and showing it would misreport who has access.
    // A malformed synced file degrades to an empty roster, same as the
    // resolver's fail-closed read (mode stays 'idp' — no fallback to manual).
    if (syncedText !== null) {
      const parsed = parseGroupsFile(syncedText, SYNCED_GROUPS_YAML);
      const groups: GroupsRoster['groups'] = [];
      if (parsed.ok) {
        for (const [canonical, def] of parsed.groups) {
          groups.push({
            canonical,
            displayName: def.displayName,
            members: [...def.emails].sort(),
            referencedBy: referencesByName.get(canonical) ?? [],
          });
        }
      }
      return { mode: 'idp', groups };
    }

    const text = (await this.readKbFile(workspaceId, GROUPS_YAML)) ?? '';
    const model = parseGroupsModel(text);
    return {
      mode: 'manual',
      groups: model.map((group) => {
        const canonical = canonicalRoleName(group.displayName);
        return {
          canonical,
          displayName: group.displayName,
          members: group.members,
          referencedBy: referencesByName.get(canonical) ?? [],
        };
      }),
    };
  }

  /** Manual group display names — what the connect-time warning dialog lists. */
  async listManualGroupNames(): Promise<string[]> {
    const workspaceId = await this.ensureWorkspace();
    const text = (await this.readKbFile(workspaceId, GROUPS_YAML)) ?? '';
    return parseGroupsModel(text).map((g) => g.displayName);
  }

  // ---- Mutations ----------------------------------------------------------

  async createGroup(actor: AuthUser, displayName: string): Promise<GroupsRoster> {
    await this.assertRoleNameFree(displayName);
    await this.runEdit(actor, (text) => editCreateGroup(text, displayName));
    return this.getRoster();
  }

  async deleteGroup(actor: AuthUser, canonical: string): Promise<GroupsRoster> {
    await this.runEdit(actor, (text) => editDeleteGroup(text, canonical));
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
   * atomic commit (same machinery, same reasoning as the role rename: a
   * partial rewrite is a silent access drop).
   */
  async renameGroup(actor: AuthUser, canonical: string, newDisplayName: string): Promise<GroupsRoster> {
    const workspaceId = await this.ensureWorkspace();
    await this.assertManualMode(workspaceId);
    const newCanonical = canonicalRoleName(newDisplayName);
    if (newCanonical !== canonical) await this.assertRoleNameFree(newDisplayName);

    const text = (await this.readKbFile(workspaceId, GROUPS_YAML)) ?? '';
    const groupsEdit = this.guardEdit(() => editRenameDisplay(text, canonical, newDisplayName));
    const writes: { repoRelativePath: string; content: string }[] = [];
    if (groupsEdit.changed) {
      this.assertLoadable(groupsEdit.text);
      writes.push({ repoRelativePath: GROUPS_YAML, content: groupsEdit.text });
    }
    if (newCanonical !== canonical) {
      writes.push(...(await this.rewriteReferences(workspaceId, canonical, newDisplayName.trim())));
    }
    if (writes.length === 0) return this.getRoster();

    const fsys = await this.lockingFsForActor(workspaceId, actor);
    await this.mapLockContention(() =>
      fsys.writeFiles(
        writes.map((w) => ({ path: `${this.kbDirName}/${w.repoRelativePath}`, content: w.content })),
        `Rename group ${canonical} → ${newDisplayName.trim()}`,
      ),
    );
    this.afterWrite(workspaceId, actor, writes.map((w) => w.repoRelativePath));
    return this.getRoster();
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
    if ((await this.readKbFile(workspaceId, GROUPS_YAML)) === null) return false;
    const fsys = await this.lockingFsForActor(workspaceId, actor);
    await this.mapLockContention(() =>
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
    if ((await this.readKbFile(workspaceId, SYNCED_GROUPS_YAML)) !== null) {
      throw new GroupsAdminError(
        'Groups are synced from your identity provider — manage membership there.',
        409,
        { kind: 'idp-mode' },
      );
    }
  }

  /** One namespace, roles win: refuse a group name that IS a role. */
  private async assertRoleNameFree(displayName: string): Promise<void> {
    const workspaceId = await this.ensureWorkspace();
    const canonical = canonicalRoleName(displayName);
    const rolesText = (await this.readKbFile(workspaceId, 'roles.yaml')) ?? '';
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
        `'${displayName.trim()}' is a role name — a group cannot shadow a role.`,
        422,
      );
    }
  }

  private async runEdit(actor: AuthUser, pre: (text: string) => GroupsEditResult): Promise<void> {
    const workspaceId = await this.ensureWorkspace();
    await this.assertManualMode(workspaceId);
    const text = (await this.readKbFile(workspaceId, GROUPS_YAML)) ?? '';
    const result = this.guardEdit(() => pre(text));
    if (!result.changed) return;
    this.assertLoadable(result.text);
    const fsys = await this.lockingFsForActor(workspaceId, actor);
    await this.mapLockContention(() =>
      fsys.writeFile(`${this.kbDirName}/${GROUPS_YAML}`, result.text),
    );
    this.afterWrite(workspaceId, actor, [GROUPS_YAML]);
  }

  private async lockingFsForActor(workspaceId: string, actor: AuthUser): Promise<LockingFilesystem> {
    const basePath = await this.workspaceService.getWorkspacePath(workspaceId);
    return new LockingFilesystem(
      { basePath, contained: true },
      { workflow: this.workflowService, workspaceId, branch: this.defaultBranch, user: actor },
    );
  }

  private async mapLockContention<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof Error && /locked by /.test(err.message)) {
        throw new GroupsAdminError('Groups are being edited by another admin. Try again in a moment.', 409);
      }
      throw err;
    }
  }

  private afterWrite(workspaceId: string, actor: AuthUser, repoRelPaths: string[]): void {
    this.accessControl.invalidate(workspaceId);
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

  /** Grant references by canonical name — same scan + parse the rename uses. */
  private async scanReferences(
    workspaceId: string,
  ): Promise<Map<string, { path: string; verb: string }[]>> {
    const repoDir = await this.repoDir(workspaceId);
    const byName = new Map<string, { path: string; verb: string }[]>();
    for (const repoRel of await this.collectCandidateFiles(workspaceId)) {
      let text: string;
      try {
        text = await fs.readFile(path.join(repoDir, repoRel), 'utf-8');
      } catch {
        continue;
      }
      for (const ref of findRoleRefsInText(text)) {
        const list = byName.get(ref.role);
        if (list) list.push({ path: repoRel, verb: ref.verb });
        else byName.set(ref.role, [{ path: repoRel, verb: ref.verb }]);
      }
    }
    return byName;
  }

  private async rewriteReferences(
    workspaceId: string,
    oldCanonical: string,
    newDisplayName: string,
  ): Promise<{ repoRelativePath: string; content: string }[]> {
    const repoDir = await this.repoDir(workspaceId);
    const writes: { repoRelativePath: string; content: string }[] = [];
    for (const repoRel of await this.collectCandidateFiles(workspaceId)) {
      let text: string;
      try {
        text = await fs.readFile(path.join(repoDir, repoRel), 'utf-8');
      } catch (err) {
        // Fail closed, like the role rename: an unreadable candidate might
        // reference the old name; a partial rewrite silently drops access.
        throw new GroupsAdminError(
          `Cannot read ${repoRel} while rewriting group references; rename aborted with no changes`,
          422,
          { cause: (err as Error)?.message },
        );
      }
      const rewritten = rewriteRoleTokensInText(text, oldCanonical, newDisplayName);
      if (rewritten !== text) writes.push({ repoRelativePath: repoRel, content: rewritten });
    }
    return writes;
  }

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

  private async repoDir(workspaceId: string): Promise<string> {
    const wsDir = await this.workspaceService.getWorkspacePath(workspaceId);
    return path.join(wsDir, this.kbDirName);
  }
}

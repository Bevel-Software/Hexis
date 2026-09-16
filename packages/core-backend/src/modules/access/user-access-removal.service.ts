/**
 * Removing a deleted account's ADDRESS from the knowledge base's access
 * files — the optional half of account deletion ("Also remove them from
 * roles, groups and access rules").
 *
 * Erasure (`AccountErasureService`) cleans the database; the address itself
 * also sits in files: `roles.yaml` members, group files, `access.md` entries
 * under any verb, and node-frontmatter grants. This service counts those
 * places (for the confirmation dialog) and removes them in ONE commit on the
 * default branch, authored by the acting admin, with a message that names the
 * erased account by its anonymised id — never the email. Git history keeps
 * the old entries, by policy (see AccountErasureService).
 *
 * Guards (the ones the roles admin already enforces stay in force here): the
 * deployment owner (`ADMIN_EMAIL`) and the Admin role's last direct email
 * member are never removed this way.
 *
 * `synced-groups.yaml` is machine-owned (only the directory-sync bot may
 * write it), so it is counted but never written — its entries go away when
 * the identity provider stops sending the person, and until then the file is
 * reported as still naming them.
 */

import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';
import type { AuthUser, IWorkspaceService, IWorkflowService } from '@bevel-software/platform-shared';
import { WorkflowDomainError } from '../../shared/domain-errors.js';
import type { IAccessControl } from './access-control.interface.js';
import {
  ADMIN_CANONICAL,
  KNOWN_VERBS,
  accessMdDeclaresBodyRules,
  canonicalEmail,
  canonicalRoleName,
  isAccessMdPath,
  parseAccessFile,
  parseOwnAccessEntries,
  type ParsedEntry,
  type Verb,
} from '../access-model/access-grammar.js';
import { spliceRevoke } from '../access-model/access-splice.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML, validateGroupsFile } from '../access-model/group-files.js';
import { makeRolesYamlWriteValidator } from '../access-model/roles-yaml-guard.js';
import { emitRolesModel, isGroupRefMember, parseRolesModel } from './roles-edit.js';
import { emitGroupsModel, parseGroupsModel } from './groups-edit.js';
import { AdminLockedCommits, type LockedWrite } from './admin-locked-commit.js';
import { KbReferenceScanner } from './reference-scan.js';

const ROLES_YAML = 'roles.yaml';

/** A removal this service refuses (guard) or cannot run. */
export class UserAccessRemovalError extends WorkflowDomainError {
  constructor(message: string, status = 422, payload?: Record<string, unknown>) {
    super(message, status, payload);
    this.name = 'UserAccessRemovalError';
  }
}

/** How many places in the knowledge base name one address, by kind. */
export interface UserReferenceCounts {
  /** Roles in `roles.yaml` listing the address as a member. */
  roles: number;
  /** Groups (manual and synced) listing the address. */
  groups: number;
  /** Entries in `access.md` files, any verb, frontmatter and body. */
  accessRules: number;
  /** Entries in other files' own frontmatter (`.md`, `.tool`). */
  fileGrants: number;
  total: number;
  /** Repo-relative paths of every file that names the address, sorted. */
  files: string[];
}

/** The confirmation dialog's view: counts plus whether removal may run. */
export interface UserReferenceReport extends UserReferenceCounts {
  removable: boolean;
  /** Why removal is refused, in words the dialog shows; null when removable. */
  blockedReason: string | null;
}

/** The outcome of a committed removal. */
export interface UserAccessRemovalResult {
  /** Files the commit changed. */
  removedFrom: string[];
  /** Files that still name the address afterwards (e.g. synced-groups.yaml). */
  stillNamedIn: string[];
}

function matchingUserEntries(entries: Record<Verb, ParsedEntry[]> | null, email: string): number {
  if (!entries) return 0;
  let n = 0;
  for (const verb of KNOWN_VERBS) {
    for (const e of entries[verb]) if (e.kind === 'user' && e.email === email) n++;
  }
  return n;
}

/**
 * Entries naming `email` in one access-frontmatter file: its own frontmatter,
 * plus — for a body-governed `access.md` — the body's folder rules. The
 * resolver's own parsers, so the count is what is actually enforced.
 */
export function countUserEntriesInAccessText(text: string, repoRel: string, email: string): number {
  const target = canonicalEmail(email);
  let n = matchingUserEntries(parseOwnAccessEntries(text), target);
  if (isAccessMdPath(repoRel) && accessMdDeclaresBodyRules(text)) {
    const parsed = parseAccessFile(text, repoRel);
    if (parsed.ok) n += matchingUserEntries(parsed.file.entries, target);
  }
  return n;
}

/**
 * Remove every entry naming `email` from one access-frontmatter file, under
 * every verb. Uses the share dialog's revoke splice, so comments, ordering
 * and prose bodies stay byte-for-byte. A file the splice cannot edit safely
 * (unterminated frontmatter) is returned unchanged.
 */
export function removeUserFromAccessText(text: string, repoRel: string, email: string): string {
  const principal = { kind: 'user' as const, email, displayName: 'x' };
  const targets = isAccessMdPath(repoRel) ? (['node', 'folder'] as const) : (['node'] as const);
  let out = text;
  try {
    for (const target of targets) {
      for (const verb of KNOWN_VERBS) out = spliceRevoke(out, verb, principal, { target }).text;
    }
  } catch {
    return text;
  }
  return out;
}

/** Roles listing `email` as a direct member; null when roles.yaml won't parse. */
function rolesNaming(text: string, email: string): string[] | null {
  try {
    return parseRolesModel(text)
      .filter((r) => r.members.includes(email))
      .map((r) => r.displayName);
  } catch {
    return null;
  }
}

function groupsNaming(text: string, email: string): number {
  try {
    return parseGroupsModel(text).filter((g) => g.members.includes(email)).length;
  } catch {
    return 0;
  }
}

export class UserAccessRemovalService {
  private readonly locked: AdminLockedCommits;
  private readonly references: KbReferenceScanner;

  constructor(
    private readonly workspaceService: IWorkspaceService,
    workflowService: IWorkflowService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    /** Live-binding thunk — DEFAULT_BRANCH stays empty until setup. */
    private readonly defaultBranchOf: () => string,
    private readonly eventBus?: WorkflowEventBus,
    /** The deployment owner(s) (`ADMIN_EMAIL`) — never removed this way. */
    private readonly deploymentOwners: readonly string[] = [],
  ) {
    this.locked = new AdminLockedCommits({
      workspaceService,
      workflowService,
      kbDirName,
      defaultBranchOf,
      makeError: (message, status, payload) => new UserAccessRemovalError(message, status, payload),
      logTag: 'user-access-removal',
      contendedSubject: 'Roles, groups or access rules',
      validateWrite: makeRolesYamlWriteValidator(kbDirName),
    });
    this.references = new KbReferenceScanner(workspaceService, kbDirName);
  }

  private get defaultBranch(): string {
    return this.defaultBranchOf();
  }

  private async ensureWorkspace(): Promise<string> {
    await this.workspaceService.getOrCreateForBranch(this.defaultBranch);
    return workspaceIdForBranch(this.defaultBranch);
  }

  /** Read every file that could name an address: roles, both group files, access files. */
  private async readAll(workspaceId: string): Promise<Map<string, string>> {
    const candidates = await this.references.collectCandidateFiles(workspaceId);
    const paths = [ROLES_YAML, GROUPS_YAML, SYNCED_GROUPS_YAML, ...candidates];
    const texts = await Promise.all(paths.map((p) => this.locked.readKbFile(workspaceId, p)));
    const out = new Map<string, string>();
    paths.forEach((p, i) => {
      const text = texts[i];
      if (text !== null) out.set(p, text);
    });
    return out;
  }

  private countIn(texts: Map<string, string>, email: string): UserReferenceCounts {
    const counts: UserReferenceCounts = { roles: 0, groups: 0, accessRules: 0, fileGrants: 0, total: 0, files: [] };
    for (const [repoRel, text] of texts) {
      let n = 0;
      if (repoRel === ROLES_YAML) {
        n = rolesNaming(text, email)?.length ?? 0;
        counts.roles += n;
      } else if (repoRel === GROUPS_YAML || repoRel === SYNCED_GROUPS_YAML) {
        n = groupsNaming(text, email);
        counts.groups += n;
      } else {
        n = countUserEntriesInAccessText(text, repoRel, email);
        if (isAccessMdPath(repoRel)) counts.accessRules += n;
        else counts.fileGrants += n;
      }
      if (n > 0) counts.files.push(repoRel);
    }
    counts.total = counts.roles + counts.groups + counts.accessRules + counts.fileGrants;
    counts.files.sort();
    return counts;
  }

  /** Why `email` may not be removed from access files, or null when it may. */
  private blockedReason(rolesText: string | undefined, email: string): string | null {
    if (this.deploymentOwners.some((o) => canonicalEmail(o) === email)) {
      return 'This is the deployment owner (ADMIN_EMAIL); their access cannot be removed here.';
    }
    const admin = rolesText
      ? (() => {
          try {
            return parseRolesModel(rolesText).find((r) => canonicalRoleName(r.displayName) === ADMIN_CANONICAL);
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const direct = (admin?.members ?? []).filter((m) => !isGroupRefMember(m));
    if (direct.includes(email) && direct.length <= 1) {
      return 'This is the last Admin; the Admin role must keep at least one direct email member.';
    }
    return null;
  }

  /** Counts + guard verdict for the delete confirmation. */
  async report(rawEmail: string): Promise<UserReferenceReport> {
    const email = canonicalEmail(rawEmail);
    const workspaceId = await this.ensureWorkspace();
    const texts = await this.readAll(workspaceId);
    const blockedReason = this.blockedReason(texts.get(ROLES_YAML), email);
    return { ...this.countIn(texts, email), removable: blockedReason === null, blockedReason };
  }

  /** Throws a 409 when the guards refuse removing `email`. */
  async assertRemovable(rawEmail: string): Promise<void> {
    const email = canonicalEmail(rawEmail);
    const workspaceId = await this.ensureWorkspace();
    const rolesText = await this.locked.readKbFile(workspaceId, ROLES_YAML);
    const reason = this.blockedReason(rolesText ?? undefined, email);
    if (reason) throw new UserAccessRemovalError(reason, 409, { kind: 'access-removal-blocked' });
  }

  /** Files that still name `email` right now (best-effort reporting). */
  async filesNaming(rawEmail: string): Promise<string[]> {
    const email = canonicalEmail(rawEmail);
    const workspaceId = await this.ensureWorkspace();
    return this.countIn(await this.readAll(workspaceId), email).files;
  }

  /**
   * Remove `email` from roles.yaml, groups.yaml and every access file in ONE
   * commit. `erasedId` names the account in the commit message. Throws on any
   * failure (guard, lock contention, invalid candidate, commit) with nothing
   * committed.
   */
  async remove(actor: AuthUser, rawEmail: string, erasedId: string): Promise<UserAccessRemovalResult> {
    const email = canonicalEmail(rawEmail);
    await this.assertRemovable(email);
    const workspaceId = await this.ensureWorkspace();
    // Plan once to learn which files to lock, then re-read and re-plan UNDER
    // those locks so a concurrent edit can't be overwritten.
    const planned = this.countIn(await this.readAll(workspaceId), email).files.filter(
      (f) => f !== SYNCED_GROUPS_YAML,
    );
    let removedFrom: string[] = [];
    if (planned.length > 0) {
      await this.locked.withFileLocks(workspaceId, actor, planned, async () => {
        const writes: LockedWrite[] = [];
        for (const repoRel of planned) {
          const original = await this.locked.readKbFile(workspaceId, repoRel);
          if (original === null) continue;
          const content = this.removeFrom(repoRel, original, email);
          if (content !== original) writes.push({ repoRel, content, original });
        }
        if (writes.length === 0) return;
        await this.locked.writeAndCommitLocked(
          workspaceId,
          actor,
          writes,
          `Remove erased account ${erasedId} from roles, groups and access rules`,
        );
        removedFrom = writes.map((w) => w.repoRel);
      });
    }
    if (removedFrom.length > 0) {
      this.accessControl.invalidate(workspaceId);
      this.emitWrites(workspaceId, actor, removedFrom);
    }
    return { removedFrom, stillNamedIn: await this.filesNaming(email) };
  }

  /** The candidate text for one file with `email` removed (validated). */
  private removeFrom(repoRel: string, text: string, email: string): string {
    if (repoRel === ROLES_YAML) {
      const reason = this.blockedReason(text, email);
      if (reason) throw new UserAccessRemovalError(reason, 409, { kind: 'access-removal-blocked' });
      const model = parseRolesModel(text);
      let changed = false;
      for (const role of model) {
        const idx = role.members.indexOf(email);
        if (idx >= 0) {
          role.members.splice(idx, 1);
          changed = true;
        }
      }
      if (!changed) return text;
      const candidate = emitRolesModel(model);
      const v = this.accessControl.validateRolesYaml(candidate);
      if (!v.ok) throw new UserAccessRemovalError(`roles.yaml would be invalid: ${v.errors.join('; ')}`, 422);
      return candidate;
    }
    if (repoRel === GROUPS_YAML) {
      const model = parseGroupsModel(text);
      let changed = false;
      for (const group of model) {
        const idx = group.members.indexOf(email);
        if (idx >= 0) {
          group.members.splice(idx, 1);
          changed = true;
        }
      }
      if (!changed) return text;
      const candidate = emitGroupsModel(model);
      const v = validateGroupsFile(candidate, GROUPS_YAML);
      if (!v.ok) throw new UserAccessRemovalError(`groups.yaml would be invalid: ${v.errors.join('; ')}`, 422);
      return candidate;
    }
    return removeUserFromAccessText(text, repoRel, email);
  }

  /** Same nudge the roles/groups admins send: open clients refetch. */
  private emitWrites(workspaceId: string, actor: AuthUser, repoRelPaths: string[]): void {
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

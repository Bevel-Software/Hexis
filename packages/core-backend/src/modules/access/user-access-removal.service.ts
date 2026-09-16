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
import { PushNeedsAgentResolutionError, WorkflowDomainError } from '../../shared/domain-errors.js';
import type { IAccessControl } from './access-control.interface.js';
import {
  ADMIN_CANONICAL,
  KNOWN_VERBS,
  accessMdDeclaresBodyRules,
  canonicalEmail,
  canonicalRoleName,
  hasAccessFrontmatterExtension,
  isAccessMdPath,
  parseAccessEntry,
  parseAccessFile,
  parseOwnAccessEntries,
  stripComment,
  type ParsedEntry,
  type Verb,
} from '../access-model/access-grammar.js';
import { spliceRevoke } from '../access-model/access-splice.js';
import { scanFrontmatter } from '../access-model/frontmatter-lines.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML, validateGroupsFile } from '../access-model/group-files.js';
import { makeRolesYamlWriteValidator } from '../access-model/roles-yaml-guard.js';
import { emitRolesModel, isGroupRefMember, parseRolesModel } from './roles-edit.js';
import { emitGroupsModel, parseGroupsModel } from './groups-edit.js';
import { AdminLockedCommits, type LockedWrite } from './admin-locked-commit.js';
import { logger } from '../../shared/logging.js';
import { printable } from '../../shared/printable.js';
import type { ITreeWalker } from '../../shared/fs.contract.js';

const log = logger('user-access-removal');

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
  /**
   * Files that still name the address afterwards (e.g. synced-groups.yaml);
   * null when they could not be checked — never read as "none".
   */
  stillNamedIn: string[] | null;
  /** The commit landed but its push did not; publishing is retried. */
  publishPending?: boolean;
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
  // The splice reads plain entries only; the frontmatter parser also accepts
  // quoted scalars and flow lists, so a grant in those forms is still there.
  if (matchingUserEntries(parseOwnAccessEntries(out), canonicalEmail(email)) > 0) {
    out = removeQuotedOrFlowFrontmatterEntries(out, canonicalEmail(email));
  }
  return out;
}

/** A YAML scalar without its surrounding quotes (`''` and `\"` unescaped). */
function unquoteYaml(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function namesUser(raw: string, email: string): boolean {
  const r = parseAccessEntry(unquoteYaml(raw));
  return r.ok && r.entry.kind === 'user' && r.entry.email === email;
}

/** The items of a one-line flow list's inner text, split on commas outside quotes. */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * Remove `email` from the top-level verb keys of a file's own frontmatter in
 * the forms the splice does not edit: a quoted scalar (`read: "A <a@x>"`), a
 * one-line flow list (`read: [A <a@x>, "B <b@x>"]`) and quoted list items.
 * Other lines stay byte-for-byte; a verb left empty becomes `verb: []`.
 */
export function removeQuotedOrFlowFrontmatterEntries(text: string, email: string): string {
  const scan = scanFrontmatter(text);
  if (scan.kind !== 'frontmatter') return text;
  const fm = [...scan.fm];
  const out: string[] = [];
  let verbKey: { index: number; verb: string; items: number; removed: number } | null = null;
  const closeVerb = () => {
    if (verbKey && verbKey.removed > 0 && verbKey.items === verbKey.removed) out[verbKey.index] = `${verbKey.verb}: []`;
    verbKey = null;
  };
  for (const line of fm) {
    const content = stripComment(line).replace(/\s+$/, '');
    const key = /^([A-Za-z]+):\s*(.*)$/.exec(content);
    if (key) {
      closeVerb();
      const [, name, value] = key;
      if (!(KNOWN_VERBS as readonly string[]).includes(name)) {
        out.push(line);
        continue;
      }
      if (value === '') {
        verbKey = { index: out.length, verb: name, items: 0, removed: 0 };
        out.push(line);
        continue;
      }
      if (value.startsWith('[') && value.endsWith(']')) {
        const items = splitFlowItems(value.slice(1, -1));
        const kept = items.filter((item) => !namesUser(item, email));
        out.push(kept.length === items.length ? line : `${name}: [${kept.join(', ')}]`);
        continue;
      }
      out.push(namesUser(value, email) ? `${name}: []` : line);
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(content);
    if (item && verbKey) {
      verbKey.items++;
      if (namesUser(item[1], email)) {
        verbKey.removed++;
        continue;
      }
    }
    out.push(line);
  }
  closeVerb();
  return [...scan.open, ...out, ...scan.post].join(scan.eol);
}

/**
 * Remove `email` from every member list of a roles/groups file by deleting
 * its list lines in place — comments, the header and ordering survive. A key
 * left with no items becomes `Key: []`. Callers check the result parses to
 * the model they expect and fall back to a canonical re-emit otherwise.
 */
export function removeEmailListLines(text: string, email: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const out: string[] = [];
  let removed = false;
  for (const line of lines) {
    const m = /^(\s*)-\s+(.*)$/.exec(stripComment(line).replace(/\s+$/, ''));
    if (m && canonicalEmail(m[2]) === email) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  if (!removed) return text;
  // A mapping key whose list is now empty: `  Name:` with no deeper item next.
  const indentOf = (l: string) => /^( *)/.exec(l)![1].length;
  for (let i = 0; i < out.length; i++) {
    const content = stripComment(out[i]).replace(/\s+$/, '');
    if (!/^\s*[^\s-][^:]*:$/.test(content)) continue;
    let j = i + 1;
    while (j < out.length && !stripComment(out[j]).trim()) j++;
    const next = j < out.length ? stripComment(out[j]).replace(/\s+$/, '') : '';
    const opensChild = next !== '' && indentOf(next) > indentOf(content);
    const opensList = next !== '' && indentOf(next) === indentOf(content) && /^\s*-(\s|$)/.test(next);
    if (!opensChild && !opensList && indentOf(content) > 0) {
      out[i] = `${content} []${out[i].slice(content.length)}`;
    }
  }
  return out.join(eol);
}

function sameModel(a: { displayName: string; members: string[] }[], b: { displayName: string; members: string[] }[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

  constructor(
    private readonly workspaceService: IWorkspaceService,
    workflowService: IWorkflowService,
    private readonly accessControl: IAccessControl,
    /**
     * The resolver's own walk. NOT `workspaceService.listFiles`: that honours
     * `.bevelignore`, and the seeded template hides every `access.md` — a
     * scan built on it finds no access rule at all.
     */
    private readonly disk: ITreeWalker,
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
  }

  private get defaultBranch(): string {
    return this.defaultBranchOf();
  }

  private async ensureWorkspace(): Promise<string> {
    await this.workspaceService.getOrCreateForBranch(this.defaultBranch);
    return workspaceIdForBranch(this.defaultBranch);
  }

  /**
   * Every `access.md` and access-frontmatter file (`.md`, `.tool`) in the
   * checkout, repo-relative — the walk the access resolver itself does, with
   * `.bevelignore` NOT honoured, plus the folders that could not be listed.
   */
  private async accessFiles(workspaceId: string): Promise<{ files: string[]; holes: string[] }> {
    const wsDir = await this.workspaceService.getWorkspacePath(workspaceId);
    const repoDir = `${wsDir}/${this.kbDirName}`;
    const out: string[] = [];
    const { holes } = await this.disk.walkKb(repoDir, [
      {
        onFile(dir, name) {
          if (hasAccessFrontmatterExtension(name)) out.push(dir ? `${dir}/${name}` : name);
        },
      },
    ]);
    if (holes.length > 0) {
      log.warn(`folders that could not be listed are not scanned: ${holes.map((h) => printable(h)).join(', ')}`);
    }
    return { files: out, holes };
  }

  /** Read every file that could name an address: roles, both group files, access files. */
  private async readAll(workspaceId: string): Promise<{ texts: Map<string, string>; holes: string[] }> {
    const { files: candidates, holes } = await this.accessFiles(workspaceId);
    const paths = [ROLES_YAML, GROUPS_YAML, SYNCED_GROUPS_YAML, ...candidates];
    const texts = await Promise.all(paths.map((p) => this.locked.readKbFile(workspaceId, p)));
    const out = new Map<string, string>();
    paths.forEach((p, i) => {
      const text = texts[i];
      if (text !== null) out.set(p, text);
    });
    return { texts: out, holes };
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
    const { texts } = await this.readAll(workspaceId);
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
    return this.countIn((await this.readAll(workspaceId)).texts, email).files;
  }

  /**
   * Remove `email` from roles.yaml, groups.yaml and every access file in ONE
   * commit. `erasedId` names the account in the commit message. Throws on any
   * failure BEFORE the commit (guard, a folder that cannot be listed, lock
   * contention, invalid candidate, commit) with nothing committed. Once the
   * commit has landed it never throws: a push that needs resolution is
   * reported as `publishPending`, and a failed re-scan as `stillNamedIn: null`.
   */
  async remove(actor: AuthUser, rawEmail: string, erasedId: string): Promise<UserAccessRemovalResult> {
    const email = canonicalEmail(rawEmail);
    await this.assertRemovable(email);
    const workspaceId = await this.ensureWorkspace();
    // Plan once to learn which files to lock, then re-read and re-plan UNDER
    // those locks so a concurrent edit can't be overwritten.
    const { texts, holes } = await this.readAll(workspaceId);
    if (holes.length > 0) {
      // A partial scan would commit a partial cleanup that looks complete.
      throw new UserAccessRemovalError(
        `Some folders could not be read (${holes.join(', ')}), so not every access rule can be found. Nothing was changed.`,
        422,
        { kind: 'access-removal-incomplete-scan' },
      );
    }
    const planned = this.countIn(texts, email).files.filter((f) => f !== SYNCED_GROUPS_YAML);
    let removedFrom: string[] = [];
    let publishPending = false;
    if (planned.length > 0) {
      let attempted: string[] = [];
      try {
        await this.locked.withFileLocks(workspaceId, actor, planned, async () => {
        const writes: LockedWrite[] = [];
        for (const repoRel of planned) {
          const original = await this.locked.readKbFile(workspaceId, repoRel);
          if (original === null) continue;
          const content = this.removeFrom(repoRel, original, email);
          if (content !== original) writes.push({ repoRel, content, original });
        }
          if (writes.length === 0) return;
          attempted = writes.map((w) => w.repoRel);
          await this.locked.writeAndCommitLocked(
            workspaceId,
            actor,
            writes,
            `Remove erased account ${erasedId} from roles, groups and access rules`,
          );
          removedFrom = attempted;
        });
      } catch (err) {
        // The commit landed; only its push needs help, which the pending-commit
        // ladder retries. The removal IS done — never report it as undone.
        if (!(err instanceof PushNeedsAgentResolutionError) || attempted.length === 0) throw err;
        removedFrom = attempted;
        publishPending = true;
      }
    }
    if (removedFrom.length > 0) {
      this.accessControl.invalidate(workspaceId);
      this.emitWrites(workspaceId, actor, removedFrom);
    }
    let stillNamedIn: string[] | null = null;
    try {
      stillNamedIn = await this.filesNaming(email);
    } catch (err) {
      log.warn(`could not re-scan the files naming erased account ${erasedId}: ${printable(err instanceof Error ? err.message : String(err))}`);
    }
    return { removedFrom, stillNamedIn, ...(publishPending ? { publishPending } : {}) };
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
      const spliced = removeEmailListLines(text, email);
      let candidate = emitRolesModel(model);
      try {
        if (sameModel(parseRolesModel(spliced), model)) candidate = spliced;
      } catch {
        // The in-place edit did not parse — the canonical re-emit stands.
      }
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
      const spliced = removeEmailListLines(text, email);
      let candidate = emitGroupsModel(model);
      try {
        if (sameModel(parseGroupsModel(spliced), model) && validateGroupsFile(spliced, GROUPS_YAML).ok) candidate = spliced;
      } catch {
        // The in-place edit did not parse — the canonical re-emit stands.
      }
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

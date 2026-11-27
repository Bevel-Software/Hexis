/**
 * Pre-disk validity gate for `roles.yaml`.
 *
 * WHY this exists: `roles.yaml` is the single point of failure for the whole
 * app. The runtime resolver's `loadModel` HARD-THROWS `AccessConfigError` on a
 * parse failure, and `isAdmin` swallows that into `false` for EVERYONE — so a
 * single malformed `roles.yaml` is an app-wide, in-app-unrecoverable admin
 * lockout. The dedicated App roles service already validates every
 * candidate before writing (`assertLoadable`), but the two RAW write paths do
 * not:
 *   - the human editor save  (`PUT /workspace/:id/file`)
 *   - the agent's file tools (`LockingFilesystem.writeFile` / `writeFiles`)
 *
 * Both of those let an admin (or an admin-driven agent) commit a broken file.
 * This guard plugs them: it runs the resolver's OWN parser on the candidate
 * BEFORE a byte hits disk, and refuses the write with a 422 on any error. A
 * write that passes here is loadable by `loadModel`, so the lockout becomes
 * structurally unreachable through normal edits.
 *
 * The break-glass recovery path (for a file that got broken some OTHER way —
 * a direct git push, a pre-guard commit) lives in `roles-admin.service.ts`.
 */

import type { FileContent } from '@mastra/core/workspace';
import { GROUP_REF_PREFIX, canonicalRoleName, parseRolesYaml, parseYamlSubset } from './access-grammar.js';
import { GROUPS_YAML, parseGroupsFile, type GroupsIndex } from './group-files.js';
import { VersionControlDomainError } from '../../shared/domain-errors.js';
import type { WriteValidator } from '../kb-fs/index.js';

/** Repo-relative basename of the roles file (it lives at the KB repo root). */
export const ROLES_YAML_BASENAME = 'roles.yaml';

/**
 * A raw write whose candidate `roles.yaml` would not parse. 422 (bad input) —
 * the edit is refused and nothing is written. Carries the parser errors so the
 * editor / agent can show exactly what's wrong.
 */
export class RolesYamlInvalidError extends VersionControlDomainError {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      `roles.yaml would be invalid and was not saved: ${errors.join('; ')}`,
      422,
      { kind: 'roles-yaml-invalid', rolesYamlErrors: errors },
    );
    this.name = 'RolesYamlInvalidError';
    this.errors = errors;
  }
}

/** Normalise a workspace-relative path: backslashes → `/`, strip a leading `./`. */
function normalizeWsPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * True iff `workspaceRelPath` targets the file `basename` at the KB repo root
 * (`<kbDirName>/<basename>`). Both the human save route and the agent's
 * `LockingFilesystem` speak workspace-relative paths, so this is the form we
 * key on. A bare `<basename>` (no KB prefix) is also accepted defensively.
 */
function isKbRootFilePath(workspaceRelPath: string, kbDirName: string, basename: string): boolean {
  const norm = normalizeWsPath(workspaceRelPath);
  return norm === `${kbDirName}/${basename}` || norm === basename;
}

/** True iff `workspaceRelPath` targets the KB's `roles.yaml`; see {@link isKbRootFilePath}. */
export function isRolesYamlPath(workspaceRelPath: string, kbDirName: string): boolean {
  return isKbRootFilePath(workspaceRelPath, kbDirName, ROLES_YAML_BASENAME);
}

/**
 * Throw {@link RolesYamlInvalidError} if `content` does not parse as a valid
 * `roles.yaml` per the resolver's own parser. No-op on valid content.
 */
export function assertRolesYamlParsable(content: string): void {
  const parsed = parseRolesYaml(content);
  if (!parsed.ok) throw new RolesYamlInvalidError(parsed.errors);
}

/**
 * A `LockingFilesystem` write-validator scoped to a KB dir: refuses a raw write
 * that would leave `roles.yaml` unparseable. Pass the returned closure as the
 * filesystem's `validateWrite` hook. Only string writes are checked — every
 * code path that writes `roles.yaml` writes it as text; a binary write to that
 * path is nonsensical and left alone.
 */
export function makeRolesYamlWriteValidator(
  kbDirName: string,
): WriteValidator & ((path: string, content: FileContent) => void) {
  const validate: WriteValidator & ((path: string, content: FileContent) => void) = (path, content) => {
    if (typeof content !== 'string') return;
    if (!isRolesYamlPath(path, kbDirName)) return;
    assertRolesYamlParsable(content);
  };
  validate.appliesTo = (path) => isRolesYamlPath(path, kbDirName);
  return validate;
}

/** What an agent is told to do instead of creating a role. */
export const NEW_ROLE_GUIDANCE =
  'App roles are pre-set — add people to existing roles, and use a GROUP for a task- or team-scoped set of people.';

/**
 * An AGENT write whose candidate `roles.yaml` declares a role the current file
 * does not. Same 422 shape as {@link RolesYamlInvalidError}; the message is
 * self-contained because a tool error reaches the agent as its message alone,
 * and the agent relays it to its user.
 */
export class RolesYamlNewRoleError extends VersionControlDomainError {
  readonly roleNames: string[];
  constructor(roleNames: string[]) {
    const quoted = roleNames.map((n) => `'${n}'`).join(', ');
    super(
      `roles.yaml was not saved: agents never create app roles, and ${quoted} ` +
        `${roleNames.length === 1 ? 'is not an existing role' : 'are not existing roles'}. ${NEW_ROLE_GUIDANCE}`,
      422,
      { kind: 'roles-yaml-new-role', roleNames },
    );
    this.name = 'RolesYamlNewRoleError';
    this.roleNames = roleNames;
  }
}

/**
 * The role names `text` declares, canonical → display spelling. Lenient on
 * purpose: a current file with a bad email still vouches for its role names.
 * Text that is absent or not a `roles:` mapping declares none.
 */
function declaredRoleNames(text: string | null): Map<string, string> {
  const names = new Map<string, string>();
  if (text === null) return names;
  const parsed = parseYamlSubset(text);
  if (!parsed.ok) return names;
  const roles = (parsed.value as Record<string, unknown> | null)?.roles;
  if (roles == null || typeof roles !== 'object' || Array.isArray(roles)) return names;
  for (const display of Object.keys(roles)) {
    const canonical = canonicalRoleName(display);
    if (canonical && !names.has(canonical)) names.set(canonical, display.trim());
  }
  return names;
}

/**
 * Throw {@link RolesYamlNewRoleError} if `candidate` declares a role name
 * (compared canonically, so a respelling is not new) absent from `current`.
 * A rename is a delete plus a create, so it is refused for the created name.
 */
export function assertNoNewRoles(current: string | null, candidate: string): void {
  const existing = declaredRoleNames(current);
  const created = [...declaredRoleNames(candidate)]
    .filter(([canonical]) => !existing.has(canonical))
    .map(([, display]) => display);
  if (created.length > 0) throw new RolesYamlNewRoleError(created);
}

/**
 * The active group source an agent write is checked against: its groups and
 * the file they came from (`groups.yaml`, or `synced-groups.yaml` in IdP mode).
 * `null` when the source exists but could not be read — group entries are then
 * left unchecked rather than every one refused.
 */
export type ActiveGroupsForValidation = { groups: GroupsIndex; sourceFile: string } | null;

/** One `- group:<Name>` member entry: the role it sits under and the entry as written. */
interface GroupEntry {
  role: string;
  roleCanonical: string;
  entry: string;
  group: string;
}

/**
 * An AGENT write whose candidate `roles.yaml` adds a `- group:<Name>` entry
 * naming no group in the active group source. The resolver ignores such an
 * entry with only a log warning — the role silently reaches nobody — so it is
 * refused up front, naming each entry, in the same 422 shape as the others.
 */
export class RolesYamlUnknownGroupError extends VersionControlDomainError {
  readonly entries: { role: string; entry: string }[];
  constructor(entries: { role: string; entry: string }[], sourceFile: string) {
    const listed = entries.map((e) => `'- ${e.entry}' under role '${e.role}'`).join(', ');
    super(
      `roles.yaml was not saved: ${listed} ${entries.length === 1 ? 'names a group' : 'name groups'} ` +
        `that ${sourceFile} does not declare. Group names are matched case- and whitespace-insensitively; ` +
        'use an existing group, or create the group first.',
      422,
      { kind: 'roles-yaml-unknown-group', entries, sourceFile },
    );
    this.name = 'RolesYamlUnknownGroupError';
    this.entries = entries;
  }
}

/** Every `- group:<Name>` entry `text` declares, in file order. Lenient, like {@link declaredRoleNames}. */
function groupEntries(text: string | null): GroupEntry[] {
  const out: GroupEntry[] = [];
  if (text === null) return out;
  const parsed = parseYamlSubset(text);
  if (!parsed.ok) return out;
  const roles = (parsed.value as Record<string, unknown> | null)?.roles;
  if (roles == null || typeof roles !== 'object' || Array.isArray(roles)) return out;
  for (const [display, members] of Object.entries(roles)) {
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      if (typeof member !== 'string') continue;
      const entry = member.trim();
      if (!entry.toLowerCase().startsWith(GROUP_REF_PREFIX)) continue;
      out.push({
        role: display.trim(),
        roleCanonical: canonicalRoleName(display),
        entry,
        group: canonicalRoleName(entry.slice(GROUP_REF_PREFIX.length)),
      });
    }
  }
  return out;
}

/**
 * Throw {@link RolesYamlUnknownGroupError} if `candidate` adds a group entry
 * whose name (compared canonically) the active group source does not declare.
 * Only ADDED entries are checked: an entry already in `current` whose group
 * has since been retired is left alone, so it cannot block an unrelated
 * membership edit.
 */
export function assertKnownGroups(
  current: string | null,
  candidate: string,
  active: ActiveGroupsForValidation,
): void {
  if (active === null) return;
  const key = (e: GroupEntry) => `${e.roleCanonical}\n${e.group}`;
  const existing = new Set(groupEntries(current).map(key));
  const unknown = groupEntries(candidate)
    .filter((e) => !existing.has(key(e)) && !active.groups.has(e.group))
    .map(({ role, entry }) => ({ role, entry }));
  if (unknown.length > 0) throw new RolesYamlUnknownGroupError(unknown, active.sourceFile);
}

/** One group whose name a write would declare twice: the spelling it adds and the one already there. */
export interface DuplicateGroup {
  group: string;
  existing: string;
}

/**
 * An AGENT write whose candidate `groups.yaml` adds a group whose canonical
 * name the file already declares (`PRODUCT:` beside `Product:`). The resolver
 * keeps the first block in file order and skips the other with only a log
 * warning, so the members of the skipped one silently vanish from the app —
 * and the group editor's next re-emit deletes them from the file. Refused up
 * front with the app's own "already exists" wording, naming both spellings.
 */
export class GroupsYamlDuplicateGroupError extends VersionControlDomainError {
  readonly duplicates: DuplicateGroup[];
  constructor(duplicates: DuplicateGroup[]) {
    const listed = duplicates.map((d) => `'${d.group}' (a group named '${d.existing}' already exists)`).join(', ');
    super(
      `${GROUPS_YAML} was not saved: ${listed}. Group names are matched case- and whitespace-insensitively, ` +
        'so the file would hold the same group twice and one block would be ignored. ' +
        'Add the people to the existing group instead.',
      422,
      { kind: 'groups-yaml-duplicate-group', duplicates },
    );
    this.name = 'GroupsYamlDuplicateGroupError';
    this.duplicates = duplicates;
  }
}

/**
 * An AGENT write whose candidate `groups.yaml` the resolver's own parser
 * refuses (a repeated key, a non-mapping `groups:`). The resolver would retire
 * EVERY group in the file, so it is refused like an unparseable `roles.yaml`.
 */
export class GroupsYamlInvalidError extends VersionControlDomainError {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`${GROUPS_YAML} would be invalid and was not saved: ${errors.join('; ')}`, 422, {
      kind: 'groups-yaml-invalid',
      groupsYamlErrors: errors,
    });
    this.name = 'GroupsYamlInvalidError';
    this.errors = errors;
  }
}

/**
 * The group names `text` declares, canonical → display spellings in file
 * order. Lenient, like {@link declaredRoleNames}: text that is absent, does not
 * parse or holds no `groups:` mapping declares none.
 */
function declaredGroupSpellings(text: string | null): Map<string, string[]> {
  const names = new Map<string, string[]>();
  if (text === null) return names;
  const parsed = parseYamlSubset(text, { tolerateEmptyKeys: true });
  if (!parsed.ok) return names;
  const groups = (parsed.value as Record<string, unknown> | null)?.groups;
  if (groups == null || typeof groups !== 'object' || Array.isArray(groups)) return names;
  for (const display of Object.keys(groups)) {
    const canonical = canonicalRoleName(display);
    if (!canonical) continue;
    names.set(canonical, [...(names.get(canonical) ?? []), display.trim()]);
  }
  return names;
}

/**
 * Throw {@link GroupsYamlDuplicateGroupError} if `candidate` declares a
 * canonical group name more times than `current` does. A duplicate already in
 * `current` is left alone — cleaning one up is a separate decision — so it
 * cannot block an unrelated membership edit. The spelling reported as existing
 * is one `current` has, so `PRODUCT:` added above `Product:` names `Product`.
 */
export function assertNoNewDuplicateGroups(current: string | null, candidate: string): void {
  const before = declaredGroupSpellings(current);
  const duplicates: DuplicateGroup[] = [];
  for (const [canonical, spellings] of declaredGroupSpellings(candidate)) {
    const had = before.get(canonical) ?? [];
    if (spellings.length < 2 || spellings.length <= had.length) continue;
    const existing = spellings.find((s) => had.includes(s)) ?? spellings[0]!;
    const added = spellings.filter((s) => s !== existing && !had.includes(s));
    for (const group of added.length > 0 ? added : [existing]) duplicates.push({ group, existing });
  }
  if (duplicates.length > 0) throw new GroupsYamlDuplicateGroupError(duplicates);
}

/** True iff `workspaceRelPath` targets the KB's `groups.yaml`; see {@link isKbRootFilePath}. */
function isGroupsYamlPath(workspaceRelPath: string, kbDirName: string): boolean {
  return isKbRootFilePath(workspaceRelPath, kbDirName, GROUPS_YAML);
}

/**
 * The agent's gate on the two people files at the KB root. For `roles.yaml`:
 * everything {@link makeRolesYamlWriteValidator} refuses, plus any role the
 * current file does not declare and — when `loadGroups` is given — any added
 * `- group:<Name>` entry naming a group the active group source does not
 * declare. For `groups.yaml`: a candidate the resolver's parser refuses, and
 * any canonical group name declared more times than the current file declares
 * it. Agents manage membership only; the human editor and the
 * App roles and groups services keep their own validators. `readCurrent`
 * returns the named root file's current text, null when absent. Content of any
 * type is checked — decoded as UTF-8 — so bytes cannot slip past.
 *
 * `readCurrent` is read afresh on every call, never cached: `LockingFilesystem`
 * calls this validator only once the file's lock is held, on the bytes that
 * land, so it compares against the file as the other writers, which
 * coordinate on the same lock, left it — a role deleted while the write
 * waited cannot be reinstated, and one added meanwhile is not refused. Only
 * there, because its verdict depends on the current file: asked before the
 * lock's read gate, a 422 where that gate would answer 403 would tell a
 * caller who may not read the file what it holds.
 */
export function makeAgentAccessYamlWriteValidator(
  kbDirName: string,
  readCurrent: (basename: string) => Promise<string | null>,
  loadGroups?: () => Promise<ActiveGroupsForValidation>,
): WriteValidator {
  const validate: WriteValidator = async (path, content) => {
    const roles = isRolesYamlPath(path, kbDirName);
    if (!roles && !isGroupsYamlPath(path, kbDirName)) return;
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf-8');
    if (!roles) {
      const parsed = parseGroupsFile(text, GROUPS_YAML);
      if (!parsed.ok) throw new GroupsYamlInvalidError(parsed.errors);
      assertNoNewDuplicateGroups(await readCurrent(GROUPS_YAML), text);
      return;
    }
    assertRolesYamlParsable(text);
    const current = await readCurrent(ROLES_YAML_BASENAME);
    assertNoNewRoles(current, text);
    if (loadGroups) assertKnownGroups(current, text, await loadGroups());
  };
  validate.appliesTo = (path) => isRolesYamlPath(path, kbDirName) || isGroupsYamlPath(path, kbDirName);
  return validate;
}

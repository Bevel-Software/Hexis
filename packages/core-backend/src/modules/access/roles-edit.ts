/**
 * Pure parse → edit → re-emit editor for `roles.yaml`.
 *
 * WHY re-emit and not a line-splice (cf. `access-splice.ts`): `access-splice.ts`
 * splices `access.md` line-by-line specifically because those files carry a
 * markdown BODY below the frontmatter (the repo-root one is a whole README)
 * that a parse→emit round-trip would silently delete. `roles.yaml` has no body
 * and no frontmatter fence — it is a plain `roles:` mapping of display-name →
 * email list — and no real `roles.yaml` in the repo carries comments. So we
 * parse the file into a model, apply the edit, and re-emit a canonical,
 * deterministic file. Re-emit is idempotent (re-emitting an unchanged model
 * yields byte-identical text), so a single edit moves only the lines it
 * actually changes. The trade-off — hand-written comments are not preserved —
 * is a documented non-goal.
 *
 *   roles:                       (always the top-level key)
 *     Admin:                     (role display name, indent 2)
 *       - a@x.eu                 (member email, indent 4)
 *       - b@x.eu
 *     Empty Role: []             (the only empty-list form the subset parser
 *                                  reads back — a bare `Empty Role:` parses to
 *                                  null and fails parseRolesYaml's list check)
 *
 * Every mutation returns `{ text, changed }`; `changed: false` means the edit
 * was a no-op (e.g. adding a member who already exists) and the caller should
 * skip the commit. Role ORDER is preserved as parsed; a newly created role is
 * appended last. Member emails within a role are canonicalised + de-duplicated.
 *
 * This module does NOT enforce the Admin-must-exist / no-self-lockout
 * invariants — those are policy and live in `roles-admin.service.ts`. It only
 * guarantees the emitted text is structurally well-formed YAML the resolver can
 * load (the service additionally runs `validateRolesYaml` as a backstop gate).
 */

import {
  parseYamlSubset,
  canonicalRoleName,
  canonicalEmail,
  ADMIN_CANONICAL,
  EMAIL_REGEX,
  GROUP_REF_PREFIX,
  RESERVED_ROLE_NAMES,
} from './access-control.service.js';

/** Bad-input failure when editing roles.yaml (invalid name/email, unknown role). */
export class RolesEditError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'RolesEditError';
    this.status = status;
  }
}

/** One role in parse order: display name + its de-duplicated member emails. */
export interface RoleModel {
  displayName: string;
  /** canonicalised, de-duplicated, in first-seen order */
  members: string[];
}

export type RolesModel = RoleModel[];

export interface EditResult {
  text: string;
  changed: boolean;
}

/**
 * Reject role display names whose characters would corrupt the emitted YAML.
 * `canonicalRoleName` only trims/lowercases/collapses spaces — it does NOT
 * reject structural characters, so a name like `Sales: West` or `#temp` would
 * round-trip into a broken file. This guard is the structural complement to the
 * reserved/duplicate checks the service layer applies.
 *
 *   `:`        mis-tokenises as a nested mapping key
 *   `#`        truncated as a comment by the subset parser's stripComment
 *   `<` / `>`  collide with the `Name <email>` user-reference shape
 *   leading -  tokenises as a list item
 *   \x00-\x1f  control chars / newlines break line structure outright
 */
export function assertSafeRoleDisplayName(displayName: string): void {
  const trimmed = displayName.trim();
  if (!trimmed) throw new RolesEditError('role name must not be empty');
  if (/[:#<>]/.test(trimmed)) {
    throw new RolesEditError(`role name must not contain ':', '#', '<', or '>': ${JSON.stringify(displayName)}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) {
    throw new RolesEditError(`role name must not contain control characters: ${JSON.stringify(displayName)}`);
  }
  if (trimmed.startsWith('-')) {
    throw new RolesEditError(`role name must not start with '-': ${JSON.stringify(displayName)}`);
  }
}

/**
 * Parse `roles.yaml` text into the ordered model. Tolerant of an empty/missing
 * file (yields `[]`). Throws RolesEditError on structurally-broken YAML — the
 * caller reads under the lock, so a broken on-disk file is an operator problem
 * surfaced as a 422, not a silent reset.
 */
export function parseRolesModel(text: string): RolesModel {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = parseYamlSubset(text);
  if (!parsed.ok) throw new RolesEditError(`roles.yaml: ${parsed.error}`);
  const root = parsed.value;
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    throw new RolesEditError('roles.yaml: must be a top-level mapping');
  }
  const rolesNode = (root as Record<string, unknown>).roles;
  if (rolesNode == null) return [];
  if (typeof rolesNode !== 'object' || Array.isArray(rolesNode)) {
    throw new RolesEditError("roles.yaml: 'roles' must be a mapping");
  }
  const model: RolesModel = [];
  for (const [displayName, value] of Object.entries(rolesNode as Record<string, unknown>)) {
    const members: string[] = [];
    // A role value must be a list of emails, an empty list (`[]`), or null
    // (`Role:` with no members). Any OTHER shape (a scalar string, a nested
    // mapping) is a malformed file — surface it as the documented 422 rather
    // than silently coercing it to an empty role (CodeRabbit: a coerce would
    // let an unrelated edit rewrite a broken roles.yaml).
    if (value !== null && !Array.isArray(value)) {
      throw new RolesEditError(`roles.yaml: role '${displayName.trim()}' must be a list of emails`);
    }
    if (Array.isArray(value)) {
      const seen = new Set<string>();
      for (const raw of value) {
        // A non-string member entry is malformed — reject, don't drop.
        if (typeof raw !== 'string') {
          throw new RolesEditError(`roles.yaml: role '${displayName.trim()}' has a non-string member`);
        }
        const email = canonicalEmail(raw);
        if (!email || seen.has(email)) continue;
        seen.add(email);
        members.push(email);
      }
    }
    model.push({ displayName: displayName.trim(), members });
  }
  return model;
}

/**
 * Re-emit the model as canonical `roles.yaml` text. Deterministic: same model →
 * same bytes. An empty role is emitted as `Name: []` (round-trippable); a role
 * with members is emitted as a block list. Always ends with a trailing newline.
 */
export function emitRolesModel(model: RolesModel): string {
  const lines: string[] = ['roles:'];
  for (const role of model) {
    if (role.members.length === 0) {
      lines.push(`  ${role.displayName}: []`);
    } else {
      lines.push(`  ${role.displayName}:`);
      for (const email of role.members) lines.push(`    - ${email}`);
    }
  }
  return lines.join('\n') + '\n';
}

function findRole(model: RolesModel, canonical: string): RoleModel | undefined {
  return model.find((r) => canonicalRoleName(r.displayName) === canonical);
}

function reemit(original: string, model: RolesModel): EditResult {
  const text = emitRolesModel(model);
  // Compare against a re-emit of the ORIGINAL so a pure formatting difference
  // (e.g. legacy spacing) doesn't masquerade as a content change — `changed`
  // tracks whether the canonical model moved, which is what the commit cares
  // about.
  let originalCanonical: string;
  try {
    originalCanonical = emitRolesModel(parseRolesModel(original));
  } catch {
    originalCanonical = original;
  }
  return { text, changed: text !== originalCanonical };
}

/** Create a new empty role. 422 on reserved/duplicate/structurally-unsafe name. */
export function createRole(text: string, displayName: string): EditResult {
  assertSafeRoleDisplayName(displayName);
  const canonical = canonicalRoleName(displayName);
  if (RESERVED_ROLE_NAMES.has(canonical)) {
    throw new RolesEditError(`'${displayName.trim()}' is a reserved name and cannot be a role`);
  }
  const model = parseRolesModel(text);
  if (findRole(model, canonical)) {
    throw new RolesEditError(`a role named '${displayName.trim()}' already exists`);
  }
  model.push({ displayName: displayName.trim(), members: [] });
  return reemit(text, model);
}

/** Delete a role by canonical name. 404 if absent. */
export function deleteRole(text: string, canonical: string): EditResult {
  const model = parseRolesModel(text);
  const idx = model.findIndex((r) => canonicalRoleName(r.displayName) === canonical);
  if (idx < 0) throw new RolesEditError(`role not found: ${canonical}`, 404);
  model.splice(idx, 1);
  return reemit(text, model);
}

/** Add a member email to a role. Idempotent. 422 bad email; 404 unknown role. */
export function addMember(text: string, canonical: string, rawEmail: string): EditResult {
  const email = canonicalEmail(rawEmail);
  if (!EMAIL_REGEX.test(email)) throw new RolesEditError(`malformed email: ${JSON.stringify(rawEmail)}`);
  const model = parseRolesModel(text);
  const role = findRole(model, canonical);
  if (!role) throw new RolesEditError(`role not found: ${canonical}`, 404);
  if (role.members.includes(email)) return { text: emitRolesModel(model), changed: false };
  role.members.push(email);
  return reemit(text, model);
}

/** Remove a member email from a role. 404 unknown role; no-op if not a member. */
export function removeMember(text: string, canonical: string, rawEmail: string): EditResult {
  const email = canonicalEmail(rawEmail);
  const model = parseRolesModel(text);
  const role = findRole(model, canonical);
  if (!role) throw new RolesEditError(`role not found: ${canonical}`, 404);
  const idx = role.members.indexOf(email);
  if (idx < 0) return { text: emitRolesModel(model), changed: false };
  role.members.splice(idx, 1);
  return reemit(text, model);
}

/**
 * A role member entry that assigns the role to a GROUP (`group:<name>`).
 * Kept in `members` as the normalized `group:<canonical>` string — the
 * parse/emit round-trip preserves it, so unrelated edits can never strip a
 * group assignment.
 */
export function isGroupRefMember(member: string): boolean {
  return member.startsWith(GROUP_REF_PREFIX);
}

function groupRefFor(groupName: string): string {
  const canonical = canonicalRoleName(groupName);
  if (!canonical) throw new RolesEditError('group name must not be empty');
  return `${GROUP_REF_PREFIX}${canonical}`;
}

/**
 * Assign a role to a group. Refused for Admin — same carve-out the resolver's
 * parser enforces (see GROUP_REF_PREFIX): a group must never decide who is
 * admin. Idempotent; 404 unknown role.
 */
export function addRoleGroupRef(text: string, canonical: string, groupName: string): EditResult {
  if (canonical === ADMIN_CANONICAL) {
    throw new RolesEditError('the Admin role cannot be assigned to a group — add individual members instead');
  }
  const ref = groupRefFor(groupName);
  const model = parseRolesModel(text);
  const role = findRole(model, canonical);
  if (!role) throw new RolesEditError(`role not found: ${canonical}`, 404);
  if (role.members.includes(ref)) return { text: emitRolesModel(model), changed: false };
  role.members.push(ref);
  return reemit(text, model);
}

/** Remove a role's group assignment. 404 unknown role; no-op if not assigned. */
export function removeRoleGroupRef(text: string, canonical: string, groupName: string): EditResult {
  const ref = groupRefFor(groupName);
  const model = parseRolesModel(text);
  const role = findRole(model, canonical);
  if (!role) throw new RolesEditError(`role not found: ${canonical}`, 404);
  const idx = role.members.indexOf(ref);
  if (idx < 0) return { text: emitRolesModel(model), changed: false };
  role.members.splice(idx, 1);
  return reemit(text, model);
}

/**
 * Rename a role's display name. The canonical name MAY change (the service
 * layer is responsible for the reference rewrite + Admin guard when it does).
 * 404 unknown source; 422 reserved/duplicate/unsafe target.
 */
export function renameRoleDisplay(text: string, canonical: string, newDisplayName: string): EditResult {
  assertSafeRoleDisplayName(newDisplayName);
  const newCanonical = canonicalRoleName(newDisplayName);
  if (RESERVED_ROLE_NAMES.has(newCanonical)) {
    throw new RolesEditError(`'${newDisplayName.trim()}' is a reserved name and cannot be a role`);
  }
  const model = parseRolesModel(text);
  const role = findRole(model, canonical);
  if (!role) throw new RolesEditError(`role not found: ${canonical}`, 404);
  if (newCanonical !== canonical && findRole(model, newCanonical)) {
    throw new RolesEditError(`a role named '${newDisplayName.trim()}' already exists`);
  }
  role.displayName = newDisplayName.trim();
  return reemit(text, model);
}

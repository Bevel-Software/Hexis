/**
 * Pure parse → edit → re-emit editor for `roles.yaml`.
 *
 * WHY re-emit and not a line-splice (cf. `access-splice.ts`): `access-splice.ts`
 * splices `access.md` line-by-line specifically because those files carry a
 * markdown BODY below the frontmatter (the repo-root one is a whole README)
 * that a parse→emit round-trip would silently delete. `roles.yaml` has no body
 * and no frontmatter fence — it is a plain `roles:` mapping of display-name →
 * member list (emails and `group:<name>` refs) — and no real `roles.yaml` in
 * the repo carries comments. So we
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
 * skip the commit. Role ORDER is preserved as parsed. Member entries within a
 * role are canonicalised + de-duplicated.
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
  EMAIL_REGEX,
  GROUP_REF_PREFIX,
} from '../access-model/access-grammar.js';

/** Bad-input failure when editing roles.yaml (invalid name/email, unknown role). */
export class RolesEditError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'RolesEditError';
    this.status = status;
  }
}

/** One role in parse order: display name + its de-duplicated member entries
 *  (emails and `group:<canonical>` refs). */
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

/**
 * Delete a role by canonical name. 404 if absent.
 *
 * NOTE: roles are app-defined capabilities now — there is no create/rename
 * editor anymore. This deletion survives ONLY as the roles.yaml half of
 * `convertRoleToGroup` (a LEGACY people-set role migrating to a group).
 */
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
  // A `group:`-prefixed value is a GROUP REFERENCE, not an email — and
  // `group:lee@x.io` would pass the email regex, landing a dead ref the
  // resolver reads as an unknown group. Route the caller to the right editor.
  if (email.startsWith(GROUP_REF_PREFIX)) {
    throw new RolesEditError(
      `member ${JSON.stringify(rawEmail)} starts with '${GROUP_REF_PREFIX}' — to assign this role to a group, use the group assignment (addRoleGroupRef / the role's Groups control), not a member email`,
    );
  }
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
 * The canonical group name a member entry references, or null for non-refs.
 * Matching MUST go through this rather than string equality on the ref: a
 * hand-edited file may carry an un-normalized ref (`group:GTM  Team`) that
 * the RESOLVER honors (it canonicalizes the suffix) — an equality match would
 * then no-op the unassign/rename while the roster still shows the group.
 */
function groupRefCanonical(member: string): string | null {
  return isGroupRefMember(member)
    ? canonicalRoleName(member.slice(GROUP_REF_PREFIX.length))
    : null;
}

/**
 * Assign a role to a group. Allowed on every role, Admin included — the
 * resolver's parse-time invariant (Admin keeps at least one DIRECT email
 * member) is what protects the rescue story, and the service validates every
 * candidate through that parser before a byte lands. Idempotent; 404 unknown
 * role.
 */
export function addRoleGroupRef(text: string, canonical: string, groupName: string): EditResult {
  const ref = groupRefFor(groupName);
  const refCanonical = canonicalRoleName(groupName);
  const model = parseRolesModel(text);
  const role = findRole(model, canonical);
  if (!role) throw new RolesEditError(`role not found: ${canonical}`, 404);
  if (role.members.some((m) => groupRefCanonical(m) === refCanonical)) {
    return { text: emitRolesModel(model), changed: false };
  }
  role.members.push(ref);
  return reemit(text, model);
}

/**
 * Rewrite every role's `group:<oldCanonical>` assignment to name
 * `group:<newCanonical>` — the roles.yaml half of a group rename. Refs are
 * STORED canonical, so a canonical-changing group rename would otherwise
 * strand them: `mergeGroupsIntoRoles` ignores an unknown ref with a warning,
 * silently shrinking the role's membership. Already-present target refs
 * dedupe rather than duplicate. No-op when nothing references the old name.
 */
export function renameGroupRefs(text: string, oldCanonical: string, newCanonical: string): EditResult {
  const newRef = `${GROUP_REF_PREFIX}${newCanonical}`;
  const model = parseRolesModel(text);
  let changed = false;
  for (const role of model) {
    // A role may carry SEVERAL differently-formatted refs to the same group
    // (un-normalized hand edits) — rewrite them all, or the stragglers point
    // at the renamed-away name and accumulate resolver warnings. Exactly one
    // ref to the new name survives.
    let hasNew = role.members.some((m) => groupRefCanonical(m) === newCanonical);
    for (let i = role.members.length - 1; i >= 0; i--) {
      if (groupRefCanonical(role.members[i]) !== oldCanonical) continue;
      if (hasNew) role.members.splice(i, 1);
      else {
        role.members[i] = newRef;
        hasNew = true;
      }
      changed = true;
    }
  }
  if (!changed) return { text: emitRolesModel(model), changed: false };
  return reemit(text, model);
}

/**
 * Remove every role's `group:<canonical>` assignment — the roles.yaml half of
 * a group DELETION (mirror of {@link renameGroupRefs}): a deleted group's
 * refs would otherwise dangle, silently shrinking each assigned role's
 * membership with only a resolver log warning. Canonical-suffix matching, so
 * un-normalized hand-edited refs are removed too. No-op when nothing
 * references the group.
 */
export function removeGroupRefsEverywhere(text: string, canonical: string): EditResult {
  const model = parseRolesModel(text);
  let changed = false;
  for (const role of model) {
    for (let i = role.members.length - 1; i >= 0; i--) {
      if (groupRefCanonical(role.members[i]) !== canonical) continue;
      role.members.splice(i, 1);
      changed = true;
    }
  }
  if (!changed) return { text: emitRolesModel(model), changed: false };
  return reemit(text, model);
}

/** Remove a role's group assignment. 404 unknown role; no-op if not assigned.
 *  Removes EVERY member whose ref canonicalises to the group — a hand-edited
 *  file may carry several differently-formatted refs to the same group
 *  (`group:gtm team` + `group:GTM  Team`), and stripping only the first would
 *  leave stragglers the resolver still honors, so the role silently keeps the
 *  group after an apparently-successful unassign. */
export function removeRoleGroupRef(text: string, canonical: string, groupName: string): EditResult {
  const refCanonical = canonicalRoleName(groupName);
  if (!refCanonical) throw new RolesEditError('group name must not be empty');
  const model = parseRolesModel(text);
  const role = findRole(model, canonical);
  if (!role) throw new RolesEditError(`role not found: ${canonical}`, 404);
  const kept = role.members.filter((m) => groupRefCanonical(m) !== refCanonical);
  if (kept.length === role.members.length) return { text: emitRolesModel(model), changed: false };
  role.members = kept;
  return reemit(text, model);
}

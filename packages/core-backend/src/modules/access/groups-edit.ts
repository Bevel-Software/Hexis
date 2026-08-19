/**
 * Pure parse → edit → re-emit editor for `groups.yaml` — the manual-mode
 * group file. Mirrors `roles-edit.ts` (same re-emit rationale: no body, no
 * comments to preserve, deterministic canonical output), with two deliberate
 * differences:
 *
 *   - No Admin invariants — groups carry no capabilities, so there is no
 *     lockout class of mistake here.
 *   - Members are EMAILS ONLY. `group:` references are a roles.yaml grammar
 *     (a role assigned to a group); a group containing a group is nesting,
 *     which is a deliberate non-goal.
 *
 * Policy that needs more than this file's text — IdP-mode gating, collision
 * with role names — lives in `groups-admin.service.ts`.
 */

import {
  canonicalRoleName,
  canonicalEmail,
  EMAIL_REGEX,
  GROUP_REF_PREFIX,
  RESERVED_ROLE_NAMES,
} from './access-control.service.js';
import { GROUPS_YAML, parseGroupsFile, unsafeNameReason } from './group-files.js';

/** Bad-input failure when editing groups.yaml. */
export class GroupsEditError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'GroupsEditError';
    this.status = status;
  }
}

export interface GroupModel {
  displayName: string;
  /** canonicalised, de-duplicated, in first-seen order */
  members: string[];
}

export type GroupsModel = GroupModel[];

export interface GroupsEditResult {
  text: string;
  changed: boolean;
}

/** Thin assert wrapper over the SHARED name-safety predicate (`group-files.ts`
 *  `unsafeNameReason`) — one namespace, one set of rules, including the
 *  reserved `role/` prefix. */
export function assertSafeGroupDisplayName(displayName: string): void {
  const reason = unsafeNameReason(displayName);
  if (reason) {
    throw new GroupsEditError(`group name ${reason}: ${JSON.stringify(displayName)}`);
  }
}

/**
 * Parse groups.yaml into the ordered model; `[]` for an empty/missing file.
 *
 * DERIVED from the resolver's own `parseGroupsFile` — one parser for the
 * grammar, so the editor's skip rules (empty/reserved/duplicate names,
 * malformed member emails) can never drift from the resolver's: the admin
 * roster and the edit surface must never show an entry the resolver ignores,
 * or an admin "manages" a group that grants nothing. Consequence, deliberate:
 * the next edit's re-emit garbage-collects those dead entries from the file.
 * Structural failures throw GroupsEditError (422) — the caller reads under
 * the lock, so a broken on-disk file is an operator problem surfaced loudly,
 * not a silent reset.
 */
export function parseGroupsModel(text: string): GroupsModel {
  if (!text.trim()) return [];
  const parsed = parseGroupsFile(text, GROUPS_YAML);
  if (!parsed.ok) throw new GroupsEditError(parsed.errors.join('; '));
  return [...parsed.groups.values()].map((def) => ({
    displayName: def.displayName,
    members: [...def.emails],
  }));
}

/** Deterministic canonical emit; empty groups as `Name: []`. */
export function emitGroupsModel(model: GroupsModel): string {
  const lines: string[] = ['groups:'];
  for (const group of model) {
    if (group.members.length === 0) {
      lines.push(`  ${group.displayName}: []`);
    } else {
      lines.push(`  ${group.displayName}:`);
      for (const email of group.members) lines.push(`    - ${email}`);
    }
  }
  return lines.join('\n') + '\n';
}

function findGroup(model: GroupsModel, canonical: string): GroupModel | undefined {
  return model.find((g) => canonicalRoleName(g.displayName) === canonical);
}

function reemit(original: string, model: GroupsModel): GroupsEditResult {
  const text = emitGroupsModel(model);
  let originalCanonical: string;
  try {
    originalCanonical = emitGroupsModel(parseGroupsModel(original));
  } catch {
    originalCanonical = original;
  }
  return { text, changed: text !== originalCanonical };
}

export function createGroup(text: string, displayName: string): GroupsEditResult {
  assertSafeGroupDisplayName(displayName);
  const canonical = canonicalRoleName(displayName);
  if (RESERVED_ROLE_NAMES.has(canonical)) {
    throw new GroupsEditError(`'${displayName.trim()}' is a reserved name and cannot be a group`);
  }
  const model = parseGroupsModel(text);
  if (findGroup(model, canonical)) {
    throw new GroupsEditError(`a group named '${displayName.trim()}' already exists`);
  }
  model.push({ displayName: displayName.trim(), members: [] });
  return reemit(text, model);
}

export function deleteGroup(text: string, canonical: string): GroupsEditResult {
  const model = parseGroupsModel(text);
  const idx = model.findIndex((g) => canonicalRoleName(g.displayName) === canonical);
  if (idx < 0) throw new GroupsEditError(`group not found: ${canonical}`, 404);
  model.splice(idx, 1);
  return reemit(text, model);
}

export function addGroupMember(text: string, canonical: string, rawEmail: string): GroupsEditResult {
  const email = canonicalEmail(rawEmail);
  // A `group:`-prefixed value is roles.yaml grammar (a role assigned to a
  // group) — and `group:lee@x.io` would pass the email regex, landing a dead
  // entry the resolver reads as a plain (never-matching) address. Mirrors
  // `roles-edit.ts` addMember; groups do not nest, so there is no "right
  // editor" to route to — a group member is always an email.
  if (email.startsWith(GROUP_REF_PREFIX)) {
    throw new GroupsEditError(
      `member ${JSON.stringify(rawEmail)} starts with '${GROUP_REF_PREFIX}' — a group member is always a person's email (groups cannot contain other groups). Drop the '${GROUP_REF_PREFIX}' prefix and add the email itself`,
    );
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new GroupsEditError(`malformed email: ${JSON.stringify(rawEmail)}`);
  }
  const model = parseGroupsModel(text);
  const group = findGroup(model, canonical);
  if (!group) throw new GroupsEditError(`group not found: ${canonical}`, 404);
  if (group.members.includes(email)) return { text: emitGroupsModel(model), changed: false };
  group.members.push(email);
  return reemit(text, model);
}

export function removeGroupMember(text: string, canonical: string, rawEmail: string): GroupsEditResult {
  const email = canonicalEmail(rawEmail);
  const model = parseGroupsModel(text);
  const group = findGroup(model, canonical);
  if (!group) throw new GroupsEditError(`group not found: ${canonical}`, 404);
  const idx = group.members.indexOf(email);
  if (idx < 0) return { text: emitGroupsModel(model), changed: false };
  group.members.splice(idx, 1);
  return reemit(text, model);
}

/** Rename a group's display name (canonical may change — service layer owns
 *  the reference rewrite when it does). */
export function renameGroupDisplay(
  text: string,
  canonical: string,
  newDisplayName: string,
): GroupsEditResult {
  assertSafeGroupDisplayName(newDisplayName);
  const newCanonical = canonicalRoleName(newDisplayName);
  if (RESERVED_ROLE_NAMES.has(newCanonical)) {
    throw new GroupsEditError(`'${newDisplayName.trim()}' is a reserved name and cannot be a group`);
  }
  const model = parseGroupsModel(text);
  const group = findGroup(model, canonical);
  if (!group) throw new GroupsEditError(`group not found: ${canonical}`, 404);
  if (newCanonical !== canonical && findGroup(model, newCanonical)) {
    throw new GroupsEditError(`a group named '${newDisplayName.trim()}' already exists`);
  }
  group.displayName = newDisplayName.trim();
  return reemit(text, model);
}

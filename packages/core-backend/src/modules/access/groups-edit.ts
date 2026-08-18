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
  parseYamlSubset,
  canonicalRoleName,
  canonicalEmail,
  EMAIL_REGEX,
  RESERVED_ROLE_NAMES,
} from './access-control.service.js';

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

/** Same structural-character rules as role names — one shared namespace,
 *  one set of YAML-safety constraints. */
export function assertSafeGroupDisplayName(displayName: string): void {
  const trimmed = displayName.trim();
  if (!trimmed) throw new GroupsEditError('group name must not be empty');
  if (/[:#<>]/.test(trimmed)) {
    throw new GroupsEditError(
      `group name must not contain ':', '#', '<', or '>': ${JSON.stringify(displayName)}`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) {
    throw new GroupsEditError(`group name must not contain control characters: ${JSON.stringify(displayName)}`);
  }
  if (trimmed.startsWith('-')) {
    throw new GroupsEditError(`group name must not start with '-': ${JSON.stringify(displayName)}`);
  }
}

/**
 * Parse groups.yaml into the ordered model; `[]` for an empty/missing file.
 *
 * Applies the RESOLVER's entry-skip rules (empty/reserved/duplicate names,
 * malformed member emails — see `parseGroupsFile`): the admin roster and the
 * edit surface must never show an entry the resolver ignores, or an admin
 * "manages" a group that grants nothing. Consequence, deliberate: the next
 * edit's re-emit garbage-collects those dead entries from the file.
 */
export function parseGroupsModel(text: string): GroupsModel {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = parseYamlSubset(text, { tolerateEmptyKeys: true });
  if (!parsed.ok) throw new GroupsEditError(`groups.yaml: ${parsed.error}`);
  const root = parsed.value;
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    throw new GroupsEditError('groups.yaml: must be a top-level mapping');
  }
  const groupsNode = (root as Record<string, unknown>).groups;
  if (groupsNode == null) return [];
  if (typeof groupsNode !== 'object' || Array.isArray(groupsNode)) {
    throw new GroupsEditError("groups.yaml: 'groups' must be a mapping");
  }
  const model: GroupsModel = [];
  const seenCanonicals = new Set<string>();
  for (const [displayName, value] of Object.entries(groupsNode as Record<string, unknown>)) {
    const canonical = canonicalRoleName(displayName);
    if (
      !canonical ||
      RESERVED_ROLE_NAMES.has(canonical) ||
      seenCanonicals.has(canonical) ||
      (value !== null && !Array.isArray(value)) // scalar value — resolver skips it
    ) {
      continue; // resolver-skipped entry — invisible to the editor too
    }
    seenCanonicals.add(canonical);
    const members: string[] = [];
    if (Array.isArray(value)) {
      const seen = new Set<string>();
      for (const raw of value) {
        // Non-string / malformed members are resolver-skipped — same here.
        if (typeof raw !== 'string') continue;
        const email = canonicalEmail(raw);
        if (!email || !EMAIL_REGEX.test(email) || seen.has(email)) continue;
        seen.add(email);
        members.push(email);
      }
    }
    model.push({ displayName: displayName.trim(), members });
  }
  return model;
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

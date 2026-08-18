import {
  EMAIL_REGEX,
  RESERVED_ROLE_NAMES,
  canonicalEmail,
  canonicalRoleName,
  parseYamlSubset,
} from './access-control.service.js';

/**
 * Group files — the "who you are" half of the roles/groups split.
 *
 * Groups are people-sets referenced by access grants ("GTM Team can read the
 * battlecards"). A deployment has exactly ONE group source at a time — a mode
 * derived from which file exists, so it holds at any git ref:
 *
 *   - `synced-groups.yaml` EXISTS  → IdP mode. The file is MACHINE-OWNED,
 *     regenerated wholesale from the SCIM directory mirror; membership is
 *     managed in the IdP. `groups.yaml` is ignored entirely.
 *   - otherwise                    → manual mode. `groups.yaml` (UI-edited)
 *     is the source.
 *
 * Both files share one format, the group twin of roles.yaml:
 *
 *   groups:
 *     Engineering:
 *       - ada@x.io
 *       - bo@x.io
 *     Empty Group: []
 *
 * Parsing is FORGIVING at the entry level by design — a malformed email or a
 * reserved/duplicate name skips that entry with a warning, it never takes the
 * whole file down. Only structural failures (unparsable YAML, `groups:` not a
 * mapping) reject the file, and even then the RESOLVER degrades to "this file
 * contributes nothing" rather than throwing: unlike roles.yaml there is no
 * admin-lockout risk here, so groups must never be able to brick access
 * resolution. Strict acceptance for WRITES is the job of the write-side
 * validator (Phase 3), which treats warnings as refusals.
 */

export const GROUPS_YAML = 'groups.yaml';
export const SYNCED_GROUPS_YAML = 'synced-groups.yaml';

/** One parsed group: display name + canonicalised member emails. */
export interface GroupDefinition {
  displayName: string;
  emails: Set<string>;
}

/** Canonical group name → definition, in file order. */
export type GroupsIndex = Map<string, GroupDefinition>;

export interface ParsedGroupsFile {
  ok: true;
  groups: GroupsIndex;
  /** Entry-level problems that were skipped over (bad email, dup name, …). */
  warnings: string[];
}

export interface GroupsFileError {
  ok: false;
  errors: string[];
}

/**
 * Parse a group file (either of the two — same grammar). See the module note
 * for the forgiving-vs-structural split.
 */
export function parseGroupsFile(
  text: string,
  filename: string,
): ParsedGroupsFile | GroupsFileError {
  // Tolerate empty keys at parse: this file's contract is ENTRY-level
  // forgiveness (a blank group name is skipped with a warning below), and a
  // hard tokenizer error here would retire every OTHER group fail-closed.
  const parsed = parseYamlSubset(text, { tolerateEmptyKeys: true });
  if (!parsed.ok) return { ok: false, errors: [`${filename}: ${parsed.error}`] };

  const root = parsed.value;
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, errors: [`${filename}: must be a top-level mapping`] };
  }

  const groupsNode = (root as Record<string, unknown>).groups;
  // An empty file (or one with no `groups:` key yet) is a valid empty set —
  // a fresh deployment's groups.yaml starts this way.
  if (groupsNode == null) return { ok: true, groups: new Map(), warnings: [] };
  if (typeof groupsNode !== 'object' || Array.isArray(groupsNode)) {
    return { ok: false, errors: [`${filename}: 'groups' must be a mapping`] };
  }

  const groups: GroupsIndex = new Map();
  const warnings: string[] = [];

  for (const [displayName, value] of Object.entries(groupsNode as Record<string, unknown>)) {
    const canonical = canonicalRoleName(displayName);
    if (!canonical) {
      warnings.push(`${filename}: empty group name — skipped`);
      continue;
    }
    if (RESERVED_ROLE_NAMES.has(canonical)) {
      warnings.push(
        `${filename}: group '${displayName}' uses reserved name '${canonical}' — skipped`,
      );
      continue;
    }
    if (groups.has(canonical)) {
      warnings.push(
        `${filename}: group '${displayName}' canonicalises to '${canonical}', already declared as '${groups.get(canonical)!.displayName}' — skipped`,
      );
      continue;
    }
    if (value !== null && !Array.isArray(value)) {
      warnings.push(`${filename}: group '${displayName}' must be a list of emails — skipped`);
      continue;
    }
    const emails = new Set<string>();
    for (const raw of value ?? []) {
      if (typeof raw !== 'string') {
        warnings.push(`${filename}: group '${displayName}' has a non-string entry — entry skipped`);
        continue;
      }
      const email = canonicalEmail(raw);
      if (!EMAIL_REGEX.test(email)) {
        warnings.push(
          `${filename}: group '${displayName}' has malformed email '${raw}' — entry skipped`,
        );
        continue;
      }
      emails.add(email);
    }
    groups.set(canonical, { displayName: displayName.trim(), emails });
  }

  return { ok: true, groups, warnings };
}

/**
 * Write-gate twin of {@link parseGroupsFile}: strict — structural errors AND
 * entry-level warnings both refuse the candidate, so a UI write can never land
 * a group the resolver would silently skip.
 */
export function validateGroupsFile(
  text: string,
  filename: string,
): { ok: true } | { ok: false; errors: string[] } {
  const parsed = parseGroupsFile(text, filename);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  if (parsed.warnings.length > 0) return { ok: false, errors: parsed.warnings };
  return { ok: true };
}

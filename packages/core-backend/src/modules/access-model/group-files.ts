import {
  EMAIL_REGEX,
  GROUP_REF_PREFIX,
  RESERVED_ROLE_NAMES,
  PLUGIN_TOKEN_PREFIX,
  ROLE_TOKEN_PREFIX,
  canonicalEmail,
  canonicalRoleName,
  parseYamlSubset,
} from './access-grammar.js';

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
 * validator (`validateGroupsFile` below), which treats warnings as refusals.
 */

export const GROUPS_YAML = 'groups.yaml';
export const SYNCED_GROUPS_YAML = 'synced-groups.yaml';

/**
 * THE name-safety predicate for principal display names — the single source
 * of truth every surface derives from (group creation/rename, IdP sync
 * materialization; thin assert wrappers sit on top). Returns a human-readable
 * reason the name is unsafe, or null when it is fine.
 *
 * The character rules keep the emitted YAML parseable and the entry grammar
 * unambiguous:
 *   `:`        mis-tokenises as a nested mapping key
 *   `#`        truncated as a comment by the subset parser's stripComment
 *   `<` / `>`  collide with the `Name <email>` user-reference shape
 *   leading -  tokenises as a list item
 *   \x00-\x1f  control chars / newlines break line structure outright
 *   `role/…`   reserved: that spelling is the EXPLICIT role token in access
 *              entries — a group carrying it could never be referenced.
 */
export function unsafeNameReason(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (!trimmed) return 'empty name';
  if (/[:#<>]/.test(trimmed)) return "contains ':', '#', '<', or '>'";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) return 'contains control characters';
  if (trimmed.startsWith('-')) return "starts with '-'";
  if (canonicalRoleName(trimmed).startsWith(ROLE_TOKEN_PREFIX)) {
    return `starts with the reserved '${ROLE_TOKEN_PREFIX}' prefix (the explicit role token in access entries)`;
  }
  if (canonicalRoleName(trimmed).startsWith(PLUGIN_TOKEN_PREFIX)) {
    return `starts with the reserved '${PLUGIN_TOKEN_PREFIX}' prefix (the plugin-principal token in access entries)`;
  }
  return null;
}

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
    // THE shared name-safety predicate (see `unsafeNameReason` above) — the
    // same rules every write surface asserts. The parser must apply it too:
    // a name the writers refuse (control chars, `<`/`>`, a leading `-`, the
    // reserved `role/` prefix) can still reach a group file by hand edit or
    // through a skewed writer, and accepting it here would let the resolver
    // honor — and `validateGroupsFile` pass — a name no editor can ever
    // produce or reference safely.
    const unsafe = unsafeNameReason(displayName);
    if (unsafe) {
      warnings.push(
        `${filename}: group ${JSON.stringify(displayName)} ${unsafe} — skipped`,
      );
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
      // The reserved `group:` prefix would PASS the email regex
      // (`group:lee@x.io` shapes like an email) but it is the roles.yaml
      // group-reference token, not an address — groups contain emails, never
      // other groups. Skip it with its own warning so the write gate refuses
      // it and the resolver never grants a colon-bearing "email".
      if (email.startsWith(GROUP_REF_PREFIX)) {
        warnings.push(
          `${filename}: group '${displayName}' has a '${GROUP_REF_PREFIX}'-prefixed entry ${JSON.stringify(raw)} — groups contain emails, not group references; entry skipped`,
        );
        continue;
      }
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
  // Strict PARSE first (no empty-key tolerance): the read side forgives a
  // blank key entry-level so other groups keep resolving, but a WRITE that
  // contains one — anywhere, including outside the `groups:` mapping — must
  // refuse rather than land bytes the tolerant reader silently drops.
  const strict = parseYamlSubset(text.trim() ? text : 'groups:');
  if (!strict.ok) return { ok: false, errors: [`${filename}: ${strict.error}`] };
  const parsed = parseGroupsFile(text, filename);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  if (parsed.warnings.length > 0) return { ok: false, errors: parsed.warnings };
  return { ok: true };
}

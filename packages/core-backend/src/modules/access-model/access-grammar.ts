/**
 * The pure access grammar — every parser, canonicaliser, constant, and type
 * that defines WHAT the roles/groups/access files mean, with no I/O and no
 * service state. Extracted from `modules/access/access-control.service.ts`;
 * the resolver and the `AccessControlService` (filesystem/git model loading,
 * caching, permission gates) stay there and consume this grammar.
 *
 * This module is a LEAF: it may import only node builtins, platform-shared,
 * `@mastra/core/workspace` types, and `src/shared/*` — never another
 * `modules/*` sibling.
 */

import type { GroupsIndex } from './group-files.js';

// ---------------------------------------------------------------------------
// Constants — kept in lockstep with knowledge-base/lib/access-control.js
// ---------------------------------------------------------------------------

export const ADMIN_CANONICAL = 'admin';
/**
 * Verbs the resolver understands in an `access.md` frontmatter. Each verb
 * is a list of grants (role or `Name <email>` references, optionally
 * prefixed with `deny `). Keep `Verb` and `KNOWN_VERBS` in lockstep —
 * `AccessFile.entries` is statically keyed on this union.
 *
 * `read` controls who may VIEW a path (the file viewer, embed surface, and
 * the agent's read tools). It is **default-deny**: a path with no effective
 * `read:` or `owner:` grant is not readable. To make content public, list the
 * built-in role `everyone` under `read:`.
 *
 * The verbs nest: `owner` is a superset of `read` + `write` + `download`, and
 * `write` is itself a superset of `read` (anyone who can edit can view). An
 * `owner` grant therefore confers all three lower verbs, a `write` grant
 * additionally confers `read`, and `owner` also marks the principal as a
 * contact point for the node (surfaced in the UI so users know who to ask).
 * See `sourceVerbsFor` for how these implications fold into resolution.
 */
export const KNOWN_VERBS = ['read', 'write', 'download', 'owner'] as const;
export type Verb = (typeof KNOWN_VERBS)[number];
const KNOWN_VERBS_SET: ReadonlySet<string> = new Set<string>(KNOWN_VERBS);
export const EVERYONE_CANONICAL = 'everyone';
/** Display name for the built-in `everyone` role in the share UI. */
export const EVERYONE_DISPLAY = 'Everyone';

/**
 * Verbs whose entries contribute to resolving `verb`, target verb first.
 * `owner` implies `read`, `write`, and `download`; `write` additionally
 * implies `read`. So resolving `read` folds in `write` and `owner`, resolving
 * `write`/`download` folds in `owner`, and resolving `owner` uses only `owner`.
 *
 * The implication is **grant-only** (see `resolveAtPath`): a superset grant
 * confers the lower verb, but a superset *denial* does not — `deny write` says
 * nothing about `read`, so it never strips a separate read grant. The target
 * verb itself contributes both its grants and its denials.
 */
export function sourceVerbsFor(verb: Verb): Verb[] {
  switch (verb) {
    case 'owner':
      return ['owner'];
    case 'read':
      return ['read', 'write', 'owner'];
    default:
      return [verb, 'owner'];
  }
}
export const RESERVED_ROLE_NAMES = new Set(['deny', EVERYONE_CANONICAL]);
export const DENY_PREFIX = 'deny ';
/**
 * Member-entry prefix in roles.yaml that references a GROUP instead of an
 * email: `- group:Engineering`. Explicit on purpose — membership kind is
 * never guessed from string shape. Valid on EVERY role including Admin, with
 * one kept invariant (see `parseRolesYaml`): Admin must always retain at
 * least one direct email member, so a misconfigured or unreachable directory
 * can never leave the deployment without a rescuable admin.
 */
export const GROUP_REF_PREFIX = 'group:';
/**
 * Explicit ROLE token prefix in access.md entries: `role/<Name>` resolves to
 * the roles.yaml role only, never a group. A BARE name resolves GROUP-FIRST
 * and falls back to the role — so `role/` is the escape hatch when a group
 * shares the role's name. The prefix is reserved in the group name-safety
 * rules (a group may never be named `role/...`), and every role is also
 * registered in the principal index under its `role/<canonical>` alias.
 */
export const ROLE_TOKEN_PREFIX = 'role/';

export const USER_REF_REGEX = /^(.+?)\s+<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/;
export const EMAIL_REGEX = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface RoleEntry {
  kind: 'role';
  role: string; // canonical (lowercase, single-spaced)
  displayRole: string; // original casing/spacing
  deny: boolean;
}

export interface UserEntry {
  kind: 'user';
  email: string; // canonical (lowercased, trimmed)
  displayName: string;
  deny: boolean;
}

export type ParsedEntry = RoleEntry | UserEntry;

export interface AccessFile {
  /** repo-relative POSIX path — e.g. `access.md`, `Knowledge/Sales/access.md`. */
  path: string;
  /** repo-relative POSIX directory — `''` for root. */
  dir: string;
  /**
   * Verb → list of grants/denials. Always carries an entry for every
   * known verb (empty array when the verb wasn't declared in the file) so
   * the resolver doesn't need to null-check at every chain step.
   */
  entries: Record<Verb, ParsedEntry[]>;
}

function emptyEntries(): Record<Verb, ParsedEntry[]> {
  const out = {} as Record<Verb, ParsedEntry[]>;
  for (const v of KNOWN_VERBS) out[v] = [];
  return out;
}

export function isAccessMdPath(p: string): boolean {
  return p === 'access.md' || p.endsWith('/access.md');
}

/**
 * Extensions of node files whose OWN `---` frontmatter can carry access verbs
 * the resolver enforces (`readOwnEntries` → `parseOwnAccessEntries`). The
 * SINGLE source of truth for every surface that enumerates candidate files —
 * the access-declarations scan and the shared `KbReferenceScanner` (which
 * must scan/rewrite the same set, or a rename strands a live `.tool`
 * frontmatter grant). `access.md` is covered by `.md`.
 */
export const ACCESS_FRONTMATTER_EXTENSIONS = ['.md', '.tool'] as const;

/** True when `p` is a file the resolver reads access frontmatter from. */
export function hasAccessFrontmatterExtension(p: string): boolean {
  return ACCESS_FRONTMATTER_EXTENSIONS.some((ext) => p.endsWith(ext));
}
/**
 * The PRINCIPAL index — canonical name → member emails. Despite the name it
 * holds both kinds of named principal after `mergeGroupsIntoRoles` runs:
 * roles.yaml roles (`kind: 'role'`, the default) and the active group file's
 * groups (`kind: 'group'`). Grant resolution treats them identically — a
 * grant names a principal, the principal has member emails — which is what
 * lets the whole closeness-first resolver work on groups without changes.
 *
 * `groupRefs` carries a role's `group:<Name>` member entries between parse
 * and merge; the merge expands them into `emails`/`byEmail`.
 */
export interface RolesIndex {
  byCanonical: Map<
    string,
    { displayName: string; emails: Set<string>; groupRefs?: Set<string>; kind?: 'role' | 'group' }
  >;
  byEmail: Map<string, Set<string>>;
}
// ---------------------------------------------------------------------------
// Tiny YAML subset parser — handles only block mappings + block sequences
// of plain scalars. See `knowledge-base/lib/access-control.js` for the
// reference implementation (this file is the TypeScript port).
// ---------------------------------------------------------------------------

type YamlValue = string | YamlValue[] | { [key: string]: YamlValue } | null;

interface YamlOk {
  ok: true;
  value: YamlValue;
}

interface YamlErr {
  ok: false;
  error: string;
}

/**
 * Strip a trailing `# comment` the way the YAML-subset tokeniser reads a
 * line: a `#` at the start (after only whitespace) or preceded by whitespace
 * begins a comment. Exported so the reference scanner matches tokens against
 * the SAME comment rule the resolver parses with (a `- GTM Team  # sales`
 * entry is the token `GTM Team`, never `GTM Team # sales`).
 */
export function stripComment(line: string): string {
  let inWs = true;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '#' && (inWs || (i > 0 && /\s/.test(line[i - 1])))) {
      return line.slice(0, i);
    }
    if (!/\s/.test(ch)) inWs = false;
  }
  return line;
}

interface Token {
  lineNum: number;
  indent: number;
  kind: 'kv' | 'item';
  key?: string;
  value: string;
}

function tokenise(
  text: string,
  opts?: { tolerateEmptyKeys?: boolean },
): YamlErr | { ok: true; tokens: Token[] } {
  const lines = text.split(/\r?\n/);
  const tokens: Token[] = [];
  // Tolerated blank keys are uniquified as runs of spaces so a SECOND blank
  // key doesn't trip the duplicate-key check (which would retire every valid
  // group after it). All-whitespace keys still canonicalize to '' downstream,
  // so the entry-level "empty group name — skipped" handling sees them all.
  let blankKeySeq = 0;
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]).replace(/\s+$/, '');
    if (!stripped.trim()) continue;
    const indentMatch = stripped.match(/^( *)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const content = stripped.slice(indent);
    const lineNum = i + 1;

    if (content.startsWith('- ') || content === '-') {
      const value = content === '-' ? '' : content.slice(2).trim();
      tokens.push({ lineNum, indent, kind: 'item', value });
      continue;
    }
    const colonIdx = content.indexOf(':');
    if (colonIdx < 0) {
      return { ok: false, error: `line ${lineNum}: expected 'key:' or '- value' but got '${content}'` };
    }
    let key = content.slice(0, colonIdx).trim();
    const valuePart = content.slice(colonIdx + 1).trim();
    // An empty key is normally a hard error (roles.yaml/access.md want loud
    // failures), but a parser with ENTRY-level forgiveness (the group files:
    // one bad entry must not retire every other group) keeps it as a
    // whitespace key for its own skip-with-warning handling.
    if (!key) {
      if (!opts?.tolerateEmptyKeys) {
        return { ok: false, error: `line ${lineNum}: empty mapping key` };
      }
      key = ' '.repeat(++blankKeySeq);
    }
    tokens.push({ lineNum, indent, kind: 'kv', key, value: valuePart });
  }
  return { ok: true, tokens };
}

export function parseYamlSubset(
  text: string,
  opts?: { tolerateEmptyKeys?: boolean },
): YamlOk | YamlErr {
  const tok = tokenise(text, opts);
  if (!tok.ok) return tok;
  if (tok.tokens.length === 0) return { ok: true, value: {} };

  type Frame = { indent: number; container: YamlValue[] | { [key: string]: YamlValue }; kind: 'map' | 'list' };
  const root: { [key: string]: YamlValue } = {};
  const stack: Frame[] = [{ indent: -1, container: root, kind: 'map' }];

  for (let t = 0; t < tok.tokens.length; t++) {
    const cur = tok.tokens[t];
    while (stack.length > 1 && stack[stack.length - 1].indent >= cur.indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];

    if (cur.kind === 'item') {
      if (top.kind !== 'list') {
        return {
          ok: false,
          error: `line ${cur.lineNum}: list item with no enclosing list (indent ${cur.indent})`,
        };
      }
      (top.container as YamlValue[]).push(cur.value);
      continue;
    }

    if (top.kind !== 'map') {
      return {
        ok: false,
        error: `line ${cur.lineNum}: mapping key '${cur.key}' inside a list — not supported`,
      };
    }
    const map = top.container as { [key: string]: YamlValue };
    const key = cur.key as string;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      return { ok: false, error: `line ${cur.lineNum}: duplicate key '${key}'` };
    }

    if (cur.value !== '') {
      // Inline empty collections are the only flow-style YAML we accept, so
      // `owner: []` reads as an empty list and `groups: {}` as an empty
      // mapping rather than the scalar strings "[]" / "{}".
      if (cur.value === '[]') {
        map[key] = [];
        continue;
      }
      if (cur.value === '{}') {
        map[key] = {};
        continue;
      }
      map[key] = cur.value;
      continue;
    }

    const next = tok.tokens[t + 1];
    if (!next || next.indent <= cur.indent) {
      map[key] = null;
      continue;
    }
    if (next.kind === 'item') {
      const list: YamlValue[] = [];
      map[key] = list;
      stack.push({ indent: cur.indent, container: list, kind: 'list' });
    } else {
      const sub: { [key: string]: YamlValue } = {};
      map[key] = sub;
      stack.push({ indent: cur.indent, container: sub, kind: 'map' });
    }
  }

  return { ok: true, value: root };
}

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

export function extractFrontmatter(
  text: string,
): { ok: true; frontmatter: string } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { ok: false, error: 'expected `---` on the first line' };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { ok: true, frontmatter: lines.slice(1, i).join('\n') };
    }
  }
  return { ok: false, error: 'unterminated frontmatter — no closing `---` found' };
}

/** The text AFTER the closing frontmatter fence ('' when there is no fence). */
export function bodyAfterFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

export function canonicalRoleName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Entry parser
// ---------------------------------------------------------------------------

export function parseAccessEntry(
  raw: unknown,
): { ok: true; entry: ParsedEntry } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'entry must be a string' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'empty entry' };

  let deny = false;
  let body = trimmed;
  if (trimmed.startsWith(DENY_PREFIX)) {
    deny = true;
    body = trimmed.slice(DENY_PREFIX.length).trim();
    if (!body) return { ok: false, error: `'deny' with no principal` };
  }

  const userMatch = body.match(USER_REF_REGEX);
  if (userMatch) {
    const displayName = userMatch[1].trim();
    const email = canonicalEmail(userMatch[2]);
    if (!displayName) return { ok: false, error: `user reference '${body}' has no name` };
    if (!EMAIL_REGEX.test(email)) {
      return { ok: false, error: `user reference '${body}' has malformed email '${email}'` };
    }
    return { ok: true, entry: { kind: 'user', email, displayName, deny } };
  }

  if (body.includes('<') || body.includes('>')) {
    return {
      ok: false,
      error: `entry '${body}' looks like a user reference but doesn't match 'Name <email>' shape`,
    };
  }

  let role = canonicalRoleName(body);
  if (!role) return { ok: false, error: `empty role name in entry '${raw}'` };
  // Explicit role token: normalize `role/ <Name>` spacing so the canonical
  // form is always `role/<canonicalName>` — the exact alias key the principal
  // index registers for every role.
  if (role.startsWith(ROLE_TOKEN_PREFIX)) {
    const suffix = canonicalRoleName(role.slice(ROLE_TOKEN_PREFIX.length));
    if (!suffix) return { ok: false, error: `entry '${body}' names no role after '${ROLE_TOKEN_PREFIX}'` };
    role = `${ROLE_TOKEN_PREFIX}${suffix}`;
  }
  return { ok: true, entry: { kind: 'role', role, displayRole: body, deny } };
}
// ---------------------------------------------------------------------------
// roles.yaml + access.md parsers
// ---------------------------------------------------------------------------

export function parseRolesYaml(
  text: string,
): { ok: true; index: RolesIndex } | { ok: false; errors: string[] } {
  const parsed = parseYamlSubset(text);
  if (!parsed.ok) return { ok: false, errors: [`roles.yaml: ${parsed.error}`] };

  const errors: string[] = [];
  const root = parsed.value;
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, errors: [`roles.yaml: must be a top-level mapping`] };
  }

  const rolesNode = (root as Record<string, YamlValue>).roles;
  if (rolesNode == null || typeof rolesNode !== 'object' || Array.isArray(rolesNode)) {
    return { ok: false, errors: [`roles.yaml: missing top-level 'roles:' mapping`] };
  }

  const index: RolesIndex = {
    byCanonical: new Map(),
    byEmail: new Map(),
  };

  for (const [displayName, value] of Object.entries(rolesNode as Record<string, YamlValue>)) {
    const canonical = canonicalRoleName(displayName);
    if (!canonical) {
      errors.push(`roles.yaml: empty role name`);
      continue;
    }
    if (RESERVED_ROLE_NAMES.has(canonical)) {
      errors.push(
        `roles.yaml: role '${displayName}' uses reserved name '${canonical}' — this token has special meaning in access entries and cannot be a roles.yaml role`,
      );
      continue;
    }
    if (canonical.startsWith(ROLE_TOKEN_PREFIX)) {
      errors.push(
        `roles.yaml: role '${displayName}' starts with the reserved '${ROLE_TOKEN_PREFIX}' prefix — that spelling is the explicit role token in access entries`,
      );
      continue;
    }
    if (index.byCanonical.has(canonical)) {
      const prev = index.byCanonical.get(canonical)!.displayName;
      errors.push(
        `roles.yaml: role '${displayName}' canonicalises to '${canonical}', which is already declared as '${prev}'`,
      );
      continue;
    }
    if (!Array.isArray(value)) {
      errors.push(`roles.yaml: role '${displayName}' must be a list of emails`);
      continue;
    }
    const emails = new Set<string>();
    const groupRefs = new Set<string>();
    for (const rawEmail of value) {
      if (typeof rawEmail !== 'string') {
        errors.push(`roles.yaml: role '${displayName}' has a non-string entry`);
        continue;
      }
      // `- group:<Name>` assigns the role to a whole group (expanded against
      // the active group source by `mergeGroupsIntoRoles`). Allowed on every
      // role, Admin included — the Admin invariant below only demands at
      // least one DIRECT email member so a broken directory can never leave
      // the deployment adminless.
      if (rawEmail.trim().toLowerCase().startsWith(GROUP_REF_PREFIX)) {
        const refName = canonicalRoleName(rawEmail.trim().slice(GROUP_REF_PREFIX.length));
        if (!refName) {
          errors.push(`roles.yaml: role '${displayName}' has an empty group reference '${rawEmail}'`);
          continue;
        }
        groupRefs.add(refName);
        continue;
      }
      const email = canonicalEmail(rawEmail);
      if (!EMAIL_REGEX.test(email)) {
        errors.push(`roles.yaml: role '${displayName}' has malformed email '${rawEmail}'`);
        continue;
      }
      emails.add(email);
      let set = index.byEmail.get(email);
      if (!set) {
        set = new Set();
        index.byEmail.set(email, set);
      }
      set.add(canonical);
    }
    index.byCanonical.set(canonical, { displayName: displayName.trim(), emails, groupRefs });
  }

  if (!index.byCanonical.has(ADMIN_CANONICAL)) {
    errors.push(`roles.yaml: must declare at least one 'Admin' role`);
  } else if (index.byCanonical.get(ADMIN_CANONICAL)!.emails.size === 0) {
    // The kept invariant: Admin may reference groups, but must ALWAYS retain
    // at least one direct email member — the rescue story requires an admin
    // whose membership does not depend on a reachable, well-configured
    // directory. A group-only Admin is as hard an error as an adminless one.
    errors.push(
      `roles.yaml: 'Admin' role has no direct email members — Admin must keep at least one individual email (group references alone are not enough)`,
    );
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, index };
}
/**
 * Merge the active group source into the principal index and expand role →
 * group assignments. Mutates `index` in place; returns human-readable
 * warnings (callers log them — nothing here ever throws, because group
 * problems must degrade, not brick access resolution).
 *
 * Rules (the grant-grammar precedence):
 *   - Every role is ALSO registered under its explicit `role/<canonical>`
 *     alias — the token that always resolves to the role.
 *   - A BARE name resolves GROUP-FIRST: when a group's canonical name
 *     collides with a role's, the bare key resolves to the GROUP (warned);
 *     the role stays reachable via `role/<canonical>`.
 *   - Role `group:<Name>` refs — Admin's included — expand against the
 *     merged groups; an unknown ref contributes nothing (warned).
 *   - `byEmail` is rebuilt so each member holds exactly the tokens that
 *     resolve to a principal they belong to (bare + `role/` alias for roles,
 *     bare for groups).
 */
export function mergeGroupsIntoRoles(
  index: RolesIndex,
  groups: GroupsIndex,
  sourceFile: string,
): string[] {
  const warnings: string[] = [];
  // Snapshot before any group lands: at this point the index holds roles only.
  const roleRecords = new Map(index.byCanonical);

  // 1. Expand role → group assignments (Admin included — its safety net is
  //    the parse-time "at least one direct email" invariant, not a merge skip).
  for (const [, principal] of roleRecords) {
    if (!principal.groupRefs?.size) continue;
    for (const ref of principal.groupRefs) {
      const group = groups.get(ref);
      if (!group) {
        warnings.push(
          `roles.yaml: role '${principal.displayName}' references unknown group '${ref}' — reference ignored`,
        );
        continue;
      }
      for (const email of group.emails) principal.emails.add(email);
    }
  }

  // 2. Bare-name precedence: groups win the bare token; the role keeps its
  //    `role/<canonical>` alias registered below.
  for (const [canonical, def] of groups) {
    if (roleRecords.has(canonical)) {
      warnings.push(
        `${sourceFile}: group '${def.displayName}' shares its name with a role — the bare name now resolves to the GROUP; use '${ROLE_TOKEN_PREFIX}${canonical}' to reference the role`,
      );
    }
    index.byCanonical.set(canonical, {
      displayName: def.displayName,
      emails: new Set(def.emails),
      kind: 'group',
    });
  }

  // 3. Explicit `role/<canonical>` alias for every role (same record — the
  //    alias and the bare key, when the role still owns it, stay in lockstep).
  for (const [canonical, principal] of roleRecords) {
    principal.kind = 'role';
    index.byCanonical.set(`${ROLE_TOKEN_PREFIX}${canonical}`, principal);
  }

  // 4. Rebuild the email → tokens map from the final index so membership
  //    reflects the post-precedence keys (a collided role's members no longer
  //    hold the bare token unless the group also contains them).
  index.byEmail.clear();
  for (const [key, principal] of index.byCanonical) {
    for (const email of principal.emails) {
      let set = index.byEmail.get(email);
      if (!set) {
        set = new Set();
        index.byEmail.set(email, set);
      }
      set.add(key);
    }
  }

  return warnings;
}
/**
 * Does an `access.md` body declare access rules — i.e. is the file in the NEW
 * (body-governs-the-folder) format?
 *
 * The two-format story: historically the FRONTMATTER carried the folder's
 * rules and the file could not govern itself. The new format follows the
 * convention every other file uses — frontmatter is about the FILE (who may
 * read/write `access.md` itself), and the content (the body) is the folder's
 * rules. The compat rule, applied per file: **when the body is not parsable as
 * rules, the frontmatter is resolved for the folder as before.**
 *
 * "Parsable as rules" is deliberately shallow — the body YAML-parses to a
 * mapping that names at least one known verb. A prose body (the repo-root
 * README-style file) fails the YAML parse or carries no verb key and stays
 * legacy. A body that DOES name a verb has claimed to be rules: shape errors
 * inside it (a scalar verb, a malformed entry) are then hard parse ERRORS of
 * the file, never a silent fallback to the frontmatter — falling back would
 * let a typo in the body hand the folder to the frontmatter's (possibly
 * `read: everyone`) self-rules.
 */
export function accessMdDeclaresBodyRules(text: string): boolean {
  const body = bodyAfterFrontmatter(text);
  if (!body.trim()) return false;
  const parsed = parseYamlSubset(body);
  if (!parsed.ok) return false;
  const root = parsed.value;
  if (root == null || typeof root !== 'object' || Array.isArray(root)) return false;
  return Object.keys(root as Record<string, YamlValue>).some((k) => KNOWN_VERBS_SET.has(k));
}

/**
 * The access verbs an `access.md` declares FOR ITSELF — its frontmatter, and
 * only in the new format (body-governed). A legacy file cannot govern itself:
 * its frontmatter IS the folder's rules, so returning them as own-entries
 * would double-apply them at the file scope.
 *
 * Parsed forgivingly (like node frontmatter): the new-format frontmatter may
 * carry non-access keys, and a typo there must not make the file unreadable.
 */
export function accessMdSelfEntries(text: string): Record<Verb, ParsedEntry[]> | null {
  if (!accessMdDeclaresBodyRules(text)) return null;
  return parseOwnAccessEntries(text);
}

/**
 * Parse one `access.md`'s FOLDER rules into its per-verb entry lists.
 *
 * Two formats (see {@link accessMdDeclaresBodyRules}): when the body declares
 * rules, the body is parsed (new format — frontmatter then governs the file
 * itself via {@link accessMdSelfEntries}); otherwise the frontmatter is parsed
 * (legacy format), exactly as before.
 *
 * Exported so read-only surfaces can report WHERE rules are declared without
 * reimplementing the parse (see `access-declarations.ts`). Exporting changes
 * nothing about resolution — this is the same function the resolver builds its
 * model from, so a display of declarations can never drift from the rules that
 * are actually enforced.
 */
export function parseAccessFile(
  text: string,
  relativePath: string,
): { ok: true; file: AccessFile; warnings: string[] } | { ok: false; errors: string[] } {
  const bodyFormat = accessMdDeclaresBodyRules(text);
  let ruleSource: string;
  if (bodyFormat) {
    ruleSource = bodyAfterFrontmatter(text);
  } else {
    const fm = extractFrontmatter(text);
    if (!fm.ok) return { ok: false, errors: [`${relativePath}: ${fm.error}`] };
    ruleSource = fm.frontmatter;
  }
  const parsed = parseYamlSubset(ruleSource);
  if (!parsed.ok) return { ok: false, errors: [`${relativePath}: ${parsed.error}`] };

  const root = parsed.value;
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    return {
      ok: false,
      errors: [`${relativePath}: ${bodyFormat ? 'body' : 'frontmatter'} must be a mapping`],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const entries = emptyEntries();

  for (const [key, value] of Object.entries(root as Record<string, YamlValue>)) {
    if (!KNOWN_VERBS_SET.has(key)) {
      // Forgiving by design: unknown keys (typos, future verbs, custom
      // metadata an operator chose to colocate) must not break the access
      // tree. Warn so operators see the typo in logs, then move on as if
      // the key didn't exist. The verbs we DO understand still parse.
      warnings.push(
        `${relativePath}: unknown access key '${key}' — ignored (known: ${[...KNOWN_VERBS].join(', ')})`,
      );
      continue;
    }
    const verb = key as Verb;
    if (!Array.isArray(value)) {
      errors.push(`${relativePath}: '${key}:' must be a list`);
      continue;
    }
    const list: ParsedEntry[] = [];
    for (const raw of value) {
      const result = parseAccessEntry(raw);
      if (!result.ok) {
        errors.push(`${relativePath}: ${result.error}`);
        continue;
      }
      list.push(result.entry);
    }
    entries[verb] = list;
  }

  if (errors.length) return { ok: false, errors };

  const slash = relativePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : relativePath.slice(0, slash);
  return { ok: true, file: { path: relativePath, dir, entries }, warnings };
}
/**
 * Per-verb access entries declared in a single node file's *own* frontmatter
 * (the same YAML block that carries `nodeType:`). This is the most-specific
 * scope — applied after every directory `access.md` in the chain.
 */
export type OwnEntries = Record<Verb, ParsedEntry[]>;
/**
 * Parse the access verbs a node file declares in its own YAML frontmatter.
 * Returns the per-verb entry lists, or null when the file has no frontmatter
 * or declares no access verb at all.
 *
 * Forgiving by design — a node's frontmatter legitimately carries non-access
 * keys (notably `nodeType:`), so unknown keys are ignored, and a malformed
 * entry is dropped rather than failing the file. A typo in a node's `owner:`
 * must never make the node unreadable; it just doesn't grant anything.
 */
export function parseOwnAccessEntries(text: string): OwnEntries | null {
  const fm = extractFrontmatter(text);
  if (!fm.ok) return null;
  const parsed = parseYamlSubset(fm.frontmatter);
  if (!parsed.ok) return null;
  const root = parsed.value;
  if (root == null || typeof root !== 'object' || Array.isArray(root)) return null;

  const entries = emptyEntries();
  let sawVerb = false;
  for (const [key, value] of Object.entries(root as Record<string, YamlValue>)) {
    if (!KNOWN_VERBS_SET.has(key)) continue; // ignore nodeType, etc.
    // Accept both the list form (`owner:\n  - A\n  - B`) and the convenience
    // single-value scalar form (`owner: Test <test@test.com>`) — the latter
    // is the natural way to name one owner in a node's own frontmatter.
    // Anything else (a mapping, null) is malformed → skip forgivingly.
    let raws: YamlValue[];
    if (Array.isArray(value)) raws = value;
    else if (typeof value === 'string' && value.trim()) raws = [value];
    else continue;
    const verb = key as Verb;
    const list: ParsedEntry[] = [];
    for (const raw of raws) {
      const result = parseAccessEntry(raw);
      if (result.ok) list.push(result.entry);
    }
    entries[verb] = list;
    sawVerb = true;
  }
  return sawVerb ? entries : null;
}

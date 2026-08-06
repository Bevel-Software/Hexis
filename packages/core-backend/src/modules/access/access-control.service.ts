import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import type { WorkspaceService } from '../workspace/workspace.service.js';
import type {
  IAccessControl,
  AccessTargetKind,
  GrantPrincipal,
  GrantSource,
  GrantSources,
} from './access-control.interface.js';
import { AccessConfigError } from './access-errors.js';

const execFileAsync = promisify(execFile);

/**
 * Read many objects from a git repo in ONE `git cat-file --batch` process.
 * `specs` are `<ref>:<path>` lines; the result array is index-aligned with
 * them — the blob's text, or null when the spec is missing/ambiguous at the
 * ref or resolves to a non-blob (e.g. a directory). Output protocol per
 * request: `<oid> <type> <size>\n<size bytes>\n`, or `<spec> missing\n`
 * (the spec may itself contain spaces, hence the endsWith checks).
 */
function catFileBatch(repoDir: string, specs: string[]): Promise<(string | null)[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoDir, 'cat-file', '--batch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    // A dying git can close stdin mid-write; the 'close' handler below still
    // fires with the exit code, which is the error we want to surface.
    child.stdin.on('error', () => undefined);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file --batch exited ${code}: ${Buffer.concat(errChunks).toString('utf-8').trim()}`));
        return;
      }
      try {
        const out = Buffer.concat(chunks);
        const results: (string | null)[] = [];
        let off = 0;
        for (let i = 0; i < specs.length; i++) {
          const nl = out.indexOf(0x0a, off);
          if (nl < 0) throw new Error('unexpected end of git cat-file output');
          const header = out.subarray(off, nl).toString('utf-8');
          off = nl + 1;
          if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
            results.push(null);
            continue;
          }
          const parts = header.split(' ');
          const size = Number(parts[2]);
          if (parts.length !== 3 || !Number.isInteger(size) || size < 0) {
            throw new Error(`unexpected git cat-file header: ${header}`);
          }
          // Non-blob (a directory path resolves to a tree) → null, but the
          // payload still has to be skipped to stay aligned.
          results.push(parts[1] === 'blob' ? out.subarray(off, off + size).toString('utf-8') : null);
          off += size + 1; // payload + trailing LF
        }
        resolve(results);
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.write(`${specs.join('\n')}\n`);
    child.stdin.end();
  });
}

/** Mirrors `shared/hash-email.ts`. Duplicated to avoid a cross-cutting import. */
function sha256Email(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

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

interface RolesIndex {
  byCanonical: Map<string, { displayName: string; emails: Set<string> }>;
  byEmail: Map<string, Set<string>>;
}

interface AccessModel {
  roles: RolesIndex;
  accessFilesByDir: Map<string, AccessFile>;
}

function isBuiltInRole(canonicalRole: string): boolean {
  return canonicalRole === EVERYONE_CANONICAL;
}

function roleKnown(roles: RolesIndex, canonicalRole: string): boolean {
  return roles.byCanonical.has(canonicalRole) || isBuiltInRole(canonicalRole);
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

function stripComment(line: string): string {
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

function tokenise(text: string): YamlErr | { ok: true; tokens: Token[] } {
  const lines = text.split(/\r?\n/);
  const tokens: Token[] = [];
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
    const key = content.slice(0, colonIdx).trim();
    const valuePart = content.slice(colonIdx + 1).trim();
    if (!key) return { ok: false, error: `line ${lineNum}: empty mapping key` };
    tokens.push({ lineNum, indent, kind: 'kv', key, value: valuePart });
  }
  return { ok: true, tokens };
}

export function parseYamlSubset(text: string): YamlOk | YamlErr {
  const tok = tokenise(text);
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
      // `owner: []` / `download: []` read as an empty list rather than the
      // scalar string "[]".
      if (cur.value === '[]') {
        map[key] = [];
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

  const role = canonicalRoleName(body);
  if (!role) return { ok: false, error: `empty role name in entry '${raw}'` };
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
    for (const rawEmail of value) {
      if (typeof rawEmail !== 'string') {
        errors.push(`roles.yaml: role '${displayName}' has a non-string entry`);
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
    index.byCanonical.set(canonical, { displayName: displayName.trim(), emails });
  }

  if (!index.byCanonical.has(ADMIN_CANONICAL)) {
    errors.push(`roles.yaml: must declare at least one 'Admin' role`);
  } else if (index.byCanonical.get(ADMIN_CANONICAL)!.emails.size === 0) {
    errors.push(`roles.yaml: 'Admin' role has no emails`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, index };
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

// ---------------------------------------------------------------------------
// Resolver — walks repo root → file dir, accumulating per-principal state.
// ---------------------------------------------------------------------------

type GrantState = 'grant' | 'denied';

/**
 * Per-verb access entries declared in a single node file's *own* frontmatter
 * (the same YAML block that carries `nodeType:`). This is the most-specific
 * scope — applied after every directory `access.md` in the chain.
 */
type OwnEntries = Record<Verb, ParsedEntry[]>;

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

/**
 * Where a single access scope's rules live. `'own'` is the node's own
 * frontmatter (the most-specific scope, only present for a file target);
 * otherwise it's the repo-relative `access.md` path that governs the scope
 * (e.g. `access.md`, `Knowledge/Sales/access.md`). `grantSources` reads this
 * to tell the dialog WHERE a principal's access comes from. */
export type ScopeSource = { kind: 'own' } | { kind: 'access-md'; path: string };

/**
 * The grant/deny state a single access scope (one `access.md` or a node's own
 * frontmatter) declares for `verb`, keyed by principal. Superset grants are
 * already folded in (grant-only — see `buildScope`), so `byRole`/`byEmail`
 * hold the *effective* verdict each named principal gets at this one scope.
 *
 * `source` identifies the file the scope's rules come from (see `ScopeSource`),
 * so a caller can map a per-scope verdict back to the editable file.
 */
interface AccessScope {
  byRole: Map<string, GrantState>;
  byEmail: Map<string, GrantState>;
  source: ScopeSource;
}

/**
 * Resolve the per-scope verdicts for `verb` at `relativePath`, ordered
 * **closest-to-the-file first**: the node's own frontmatter, then its
 * directory's `access.md`, then each parent up to the repo root.
 *
 * Permission resolution honours closeness *before* tier: the first scope that
 * yields any verdict for a principal wins, and only ties *within* that scope
 * fall back to the email > role > everyone ordering (see
 * `hasPermissionResolved`). `collapseScopes` flattens this into the
 * closest-wins-per-principal view the display helpers use.
 */
function resolveScopes(
  model: AccessModel,
  verb: Verb,
  relativePath: string,
  fileOwn?: OwnEntries | null,
): AccessScope[] {
  const target = verb;
  const supersets = sourceVerbsFor(verb).filter((v) => v !== verb);

  // Build one scope's effective verdicts. The target verb contributes both
  // grants and denials; superset verbs contribute grants only (a `deny write`
  // never strips `read`). Within the scope a grant always wins over a deny of
  // the same principal, so a same-file superset grant overrides a target deny
  // (e.g. `owner:` beats `deny write`, `write:` beats `deny read`).
  const buildScope = (
    entries: Record<Verb, ParsedEntry[]>,
    filterRoles: boolean,
    source: ScopeSource,
  ): AccessScope => {
    const byRole = new Map<string, GrantState>();
    const byEmail = new Map<string, GrantState>();
    const set = (entry: ParsedEntry, state: GrantState) => {
      const map = entry.kind === 'role' ? byRole : byEmail;
      const key = entry.kind === 'role' ? entry.role : entry.email;
      if (map.get(key) === 'grant') return; // a grant in this scope sticks
      map.set(key, state);
    };
    for (const entry of entries[target]) {
      if (filterRoles && entry.kind === 'role' && !roleKnown(model.roles, entry.role)) continue;
      set(entry, entry.deny ? 'denied' : 'grant');
    }
    for (const src of supersets) {
      for (const entry of entries[src]) {
        if (entry.deny) continue; // grant-only fold
        if (filterRoles && entry.kind === 'role' && !roleKnown(model.roles, entry.role)) continue;
        set(entry, 'grant');
      }
    }
    return { byRole, byEmail, source };
  };

  const scopes: AccessScope[] = [];
  // The node's own frontmatter is the most specific scope. Role refs there are
  // not pre-filtered (the dir chain is, in loadModel), so drop unknown roles.
  if (fileOwn) scopes.push(buildScope(fileOwn, true, { kind: 'own' }));
  const chain = dirChainFor(relativePath);
  for (let i = chain.length - 1; i >= 0; i--) {
    const file = model.accessFilesByDir.get(chain[i]);
    if (file) scopes.push(buildScope(file.entries, false, { kind: 'access-md', path: file.path }));
  }
  return scopes;
}

/** The collapsed closest-wins view: per-principal verdicts with no single
 * source (it's a flattening across scopes). */
type CollapsedScope = Pick<AccessScope, 'byRole' | 'byEmail'>;

/**
 * Flatten ordered scopes (closest→farthest) into a single closest-wins
 * per-principal view. Used by the display / eligibility helpers, which only
 * need "what's this principal's effective verdict?" — not the scope-by-scope
 * precedence the permission decision applies.
 */
function collapseScopes(scopes: AccessScope[]): CollapsedScope {
  const byRole = new Map<string, GrantState>();
  const byEmail = new Map<string, GrantState>();
  for (let i = scopes.length - 1; i >= 0; i--) {
    for (const [k, v] of scopes[i].byRole) byRole.set(k, v);
    for (const [k, v] of scopes[i].byEmail) byEmail.set(k, v);
  }
  return { byRole, byEmail };
}

function resolveAtPath(
  model: AccessModel,
  verb: Verb,
  relativePath: string,
  fileOwn?: OwnEntries | null,
): CollapsedScope {
  return collapseScopes(resolveScopes(model, verb, relativePath, fileOwn));
}

function isAdminEmail(model: AccessModel, email: string): boolean {
  const roles = model.roles.byEmail.get(email);
  return !!roles && roles.has(ADMIN_CANONICAL);
}

/**
 * Resolve whether `userEmail` has `verb` on `relativePath`.
 *
 * Precedence is **closeness first, tier second**: scopes are walked from the
 * node's own frontmatter outward to the repo root, and the first scope that
 * yields any verdict for the caller decides. Only *within* a single scope do
 * the tiers break the tie, most-specific first: a direct email entry beats a
 * role entry, which beats the built-in `everyone` role. When two of the
 * caller's roles conflict at the same scope, grant wins (a deny on one role
 * does not undo a grant via another). A closer scope's `everyone` grant
 * therefore overrides a farther scope's email deny, and vice versa.
 * Default-deny: no verdict at any scope → no access.
 *
 * Two hardcoded overrides for `write`, applied before scope resolution:
 *   - `roles.yaml` is Admin-only, regardless of any access.md content.
 *     Hard rule — the file that decides who's an admin can't be edited by
 *     a non-admin without creating a privilege-escalation loop.
 *   - Any `access.md` file is always writable by admins, even if the file
 *     itself excludes them or fails to parse cleanly. These are the rescue
 *     mechanism for the rest of the tree — without this, a typo in
 *     `access.md` could permanently lock admins out of fixing it.
 *
 * No special-cases for `read`/`download` — they fall through to scope resolution.
 */
function hasPermissionResolved(
  model: AccessModel,
  verb: Verb,
  userEmail: string,
  relativePath: string,
  fileOwn?: OwnEntries | null,
): boolean {
  const email = canonicalEmail(userEmail);

  if (verb === 'write') {
    if (relativePath === 'roles.yaml') return isAdminEmail(model, email);
    if (isAccessMdPath(relativePath) && isAdminEmail(model, email)) return true;
  }

  const userRoles = model.roles.byEmail.get(email);
  const scopes = resolveScopes(model, verb, relativePath, fileOwn);

  for (const scope of scopes) {
    // Tier 1 — direct email entry is the most specific verdict at this scope.
    const direct = scope.byEmail.get(email);
    if (direct) return direct === 'grant';

    // Tier 2 — the caller's roles. A grant via any one of them wins over a deny
    // via another at this same scope (a `deny Engineer` doesn't undo an
    // unrelated `Admin` grant).
    if (userRoles && userRoles.size) {
      let grant = false;
      let deny = false;
      for (const r of userRoles) {
        const s = scope.byRole.get(r);
        if (s === 'denied') deny = true;
        else if (s === 'grant') grant = true;
      }
      if (grant) return true;
      if (deny) return false;
    }

    // Tier 3 — the built-in `everyone` role.
    const everyone = scope.byRole.get(EVERYONE_CANONICAL);
    if (everyone) return everyone === 'grant';

    // No verdict at this scope — fall through to the next (farther) one.
  }

  return false;
}

/**
 * The `access.md` that a FOLDER target's own grants live in — its direct scope.
 * Root (`''`) → `access.md`; otherwise `<dir>/access.md`. (Mirrors
 * `accessMdPathForFolder` in the mutation service; duplicated here to keep the
 * resolver free of a write-side import.)
 */
function ownAccessMdForFolder(repoRelDir: string): string {
  return repoRelDir ? `${repoRelDir}/access.md` : 'access.md';
}

/**
 * Map the scope that granted a principal to a `GrantSource`, given the target.
 * The scope's own source (`own` frontmatter vs an `access.md` path) plus the
 * target kind decides direct-vs-ancestor:
 *   - file target:   own-frontmatter scope → direct; any `access.md` → ancestor.
 *   - folder target: the folder's OWN `access.md` → direct; any other → ancestor.
 */
function scopeToGrantSource(
  scope: AccessScope,
  kind: AccessTargetKind,
  relativePath: string,
): GrantSource {
  if (scope.source.kind === 'own') return { kind: 'direct' };
  const path = scope.source.path;
  const ownPath = kind === 'folder' ? ownAccessMdForFolder(relativePath) : null;
  if (ownPath !== null && path === ownPath) return { kind: 'direct' };
  return { kind: 'ancestor', path };
}

/**
 * Resolve EVERY file scope that names a principal for `verb`, ordered
 * closest-first — the source-returning twin of `hasPermissionResolved`, but
 * returning the WHOLE list of removable entries rather than just the winner.
 *
 * Only the principal's OWN named entry yields a source — a `user` by their email,
 * a `role` by its role token. A grant that reaches the user via a group they
 * belong to, the built-in `everyone`, or admin-rescue is NOT their entry, so it
 * never adds a source (the group/role shows as its own row instead). The list is:
 *   - `[]` (verb omitted by the caller) when the principal effectively holds no
 *     `verb` via a named entry: they're not named, OR their CLOSEST own-email
 *     verdict is a `deny` (cut off — any farther grant is dead), OR they only
 *     resolve via a group/everyone/rescue.
 *   - otherwise `[closest, …farther]` — each scope where the principal's own
 *     entry GRANTS the verb, closest-first, up to (but not including) a closer
 *     own-email `deny`. `[0]` is the effective source.
 *
 * Why all of them, not just `[0]`: the dialog must tell "granted here" apart from
 * "granted here AND also inherited from a parent" (both collapse to `direct`
 * under closest-wins), and the revoke flow needs the inherited remainder that
 * survives removing the direct entry. A group/everyone grant at some scope does
 * not add a source AND does not hide a farther own-entry the principal is named
 * in (removing it is still meaningful if the group grant is later removed).
 */
function resolveGrantSourcesForVerb(
  model: AccessModel,
  verb: Verb,
  kind: AccessTargetKind,
  relativePath: string,
  principal: GrantPrincipal,
  fileOwn?: OwnEntries | null,
): GrantSource[] {
  const scopes = resolveScopes(model, verb, relativePath, fileOwn);
  const out: GrantSource[] = [];

  if (principal.kind === 'role') {
    const role = canonicalRoleName(principal.role);
    for (const scope of scopes) {
      const s = scope.byRole.get(role);
      if (s === 'denied') break; // a closer deny of this role cuts off farther grants
      if (s === 'grant') out.push(scopeToGrantSource(scope, kind, relativePath));
    }
    return out;
  }

  const email = canonicalEmail(principal.email);
  for (const scope of scopes) {
    // The principal's OWN email entry at this scope is the only thing that yields
    // a removable source. A grant adds it; a deny cuts off everything farther
    // (closeness-first: a closer deny shadows farther grants).
    const direct = scope.byEmail.get(email);
    if (direct === 'denied') break;
    if (direct === 'grant') out.push(scopeToGrantSource(scope, kind, relativePath));
    // A group/everyone grant or deny at this scope is NOT this user's own entry:
    // it neither adds a source nor hides a farther own-entry, so we keep walking.
  }
  return out;
}

/**
 * Build the repo-root → path chain of directory scopes that govern
 * `relativePath`, e.g. `Knowledge/Sales/Foo.md` →
 * `['', 'Knowledge', 'Knowledge/Sales', 'Knowledge/Sales/Foo.md']`.
 *
 * Every segment is included, INCLUDING the leaf. For a file leaf the leaf
 * entry simply never matches a directory key in `accessFilesByDir` (those are
 * keyed by the access.md's parent dir), so it's a harmless no-op. For a
 * DIRECTORY leaf (e.g. resolving `canRead('Knowledge/Secret')` for a folder),
 * including it means `Knowledge/Secret/access.md`'s own rules apply to the
 * folder itself — without this, a folder's own read grant would not apply to
 * the directory node that names it.
 */
function dirChainFor(relativePath: string): string[] {
  const chain: string[] = [''];
  let acc = '';
  for (const p of relativePath.split('/')) {
    if (!p) continue;
    acc = acc ? `${acc}/${p}` : p;
    chain.push(acc);
  }
  return chain;
}

/**
 * Whether this path is readable by every signed-in user via the built-in
 * `everyone` role. Used only for display semantics: when this is true
 * the UI can say "everyone can see this" instead of listing a meaningless
 * role set. Any effective denial that carves someone out keeps the node
 * reported as restricted.
 */
function canEveryoneReadResolved(
  model: AccessModel,
  relativePath: string,
  fileOwn?: OwnEntries | null,
): boolean {
  const { byRole, byEmail } = resolveAtPath(model, 'read', relativePath, fileOwn);
  // Baseline: an unnamed signed-in user (no email/role entries) reads only via
  // `everyone`. As a single principal, its collapsed verdict is its closest —
  // exactly what that user resolves to.
  if (byRole.get(EVERYONE_CANONICAL) !== 'grant') return false;
  // Every *named* principal must also still read. A collapsed deny may have
  // been shadowed by a closer-scope `everyone` grant, so re-resolve each
  // candidate through the closeness-first gate rather than trusting the
  // collapsed deny state. (Role members live in roles.yaml; inline-named users
  // come from `byEmail`.)
  const candidates = new Set<string>();
  for (const email of model.roles.byEmail.keys()) candidates.add(email);
  for (const email of byEmail.keys()) candidates.add(email);
  for (const email of candidates) {
    if (!hasPermissionResolved(model, 'read', email, relativePath, fileOwn)) return false;
  }
  return true;
}

/**
 * Resolve whether `userEmail` may READ `relativePath`.
 *
 * Read is default-deny: a path is readable only when resolution grants the
 * caller `read` directly, via one of their roles, via the built-in `everyone`
 * role, or via `owner:` (owners implicitly read).
 *
 * No admin rescue (mirrors `download`): admins read a node only if an
 * `access.md` lists them — directly, via a role, through `everyone`, or as an
 * owner.
 */
function canReadResolved(
  model: AccessModel,
  userEmail: string,
  relativePath: string,
  fileOwn?: OwnEntries | null,
): boolean {
  return hasPermissionResolved(model, 'read', userEmail, relativePath, fileOwn);
}

function eligibleHoldersResolved(
  model: AccessModel,
  verb: Verb,
  relativePath: string,
  fileOwn?: OwnEntries | null,
): { roles: string[]; users: { name: string; email: string }[] } {
  const { byRole, byEmail } = resolveAtPath(model, verb, relativePath, fileOwn);

  const roleSet = new Set<string>();
  for (const [canonical, state] of byRole) {
    if (state !== 'grant') continue;
    const role = model.roles.byCanonical.get(canonical);
    roleSet.add(role ? role.displayName : canonical);
  }

  // Mirror the admin overrides applied in `hasPermissionResolved`: write on
  // `roles.yaml` and on any `access.md` is granted to Admin even if the
  // file content doesn't list it. Without surfacing that here, the
  // "restricted to …" banner under-reports who can actually fix a bad
  // access.md (it'd say "restricted to no one" when Admin is the answer).
  if (
    verb === 'write' &&
    (relativePath === 'roles.yaml' || isAccessMdPath(relativePath))
  ) {
    const adminRole = model.roles.byCanonical.get(ADMIN_CANONICAL);
    roleSet.add(adminRole ? adminRole.displayName : ADMIN_CANONICAL);
  }

  const roles = [...roleSet].sort();

  const users: { name: string; email: string }[] = [];
  for (const [email, state] of byEmail) {
    if (state !== 'grant') continue;
    users.push({ name: '', email });
  }
  users.sort((a, b) => a.email.localeCompare(b.email));

  return { roles, users };
}

/**
 * Expand the eligible-writer set to the underlying emails.
 *
 * Algorithm: for every email in roles.yaml, ask `canWriteResolved` whether
 * that email can write this path. That walks both the role-level and
 * email-level state with the correct precedence (user-level entries trump
 * role-level), so we don't have to reimplement the resolution logic — we
 * just enumerate candidates and let the resolver answer each one.
 *
 * Direct user grants (emails named inline with no `roles.yaml` entry) are
 * picked up from `byEmail` separately.
 */
function eligibleHolderEmailsResolved(
  model: AccessModel,
  verb: Verb,
  relativePath: string,
  fileOwn?: OwnEntries | null,
): Map<string, { name: string; email: string }> {
  const { byEmail } = resolveAtPath(model, verb, relativePath, fileOwn);
  const out = new Map<string, { name: string; email: string }>();

  // Candidate emails: all emails in roles.yaml, plus everyone named directly
  // in an access.md entry at this path's scope (whether granted or denied —
  // `hasPermissionResolved` filters denials out below). The built-in
  // `everyone` role can grant arbitrary signed-in users, but this finite
  // expansion can only return emails the access tree explicitly names.
  const candidates = new Set<string>();
  for (const email of model.roles.byEmail.keys()) candidates.add(email);
  for (const email of byEmail.keys()) candidates.add(email);

  for (const email of candidates) {
    if (hasPermissionResolved(model, verb, email, relativePath, fileOwn)) {
      out.set(email, { name: '', email });
    }
  }
  return out;
}

/**
 * The set of explicitly-named individuals (roles.yaml members + emails named
 * inline at this path's scope) who do NOT hold `verb` here. This is the
 * general exclusion set used by the merge gate to subtract from a blanket
 * `everyone` grant: it catches denials at *any* tier — a `deny email`, a
 * `deny role` covering one of the user's roles, or a `deny everyone` carve-out
 * — not just direct user denials, because each candidate is run through full
 * scope resolution. (The complement of `eligibleHolderEmailsResolved` over the
 * same candidate set.)
 */
function ineligibleNamedEmailsResolved(
  model: AccessModel,
  verb: Verb,
  relativePath: string,
  fileOwn?: OwnEntries | null,
): Set<string> {
  const { byEmail } = resolveAtPath(model, verb, relativePath, fileOwn);
  const candidates = new Set<string>();
  for (const email of model.roles.byEmail.keys()) candidates.add(email);
  for (const email of byEmail.keys()) candidates.add(email);

  const out = new Set<string>();
  for (const email of candidates) {
    if (!hasPermissionResolved(model, verb, email, relativePath, fileOwn)) out.add(email);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AccessControlService implements IAccessControl {
  /**
   * Per-workspace cache: `model` is the resolved access tree and `loadedAt`
   * is when we computed it. We re-load on a TTL — the validator runs on
   * every commit so stale state surfaces quickly anyway, and the read cost
   * is small (a few small files).
   */
  private readonly cache = new Map<string, { model: AccessModel; loadedAt: number }>();
  private static readonly CACHE_TTL_MS = 5_000;

  /**
   * Per-workspace memo of node frontmatter access entries (keyed by
   * repo-relative path), for the BATCH checks — the explorer tree resolves
   * every KB file on each load, which would otherwise cost one `fs.readFile`
   * per node per tree build. Dropped by `invalidate()` — which fires on every
   * commit / pull / branch switch, i.e. on every path a frontmatter edit can
   * land through — so that is the PRIMARY freshness mechanism; the TTL is
   * only a long backstop against a missed invalidation. It is deliberately
   * NOT the model cache's 5s TTL: at 5s every tree build was effectively
   * cold (~one full-KB read sweep per build). Single-file gates (`canRead` /
   * `canWrite`) stay uncached — the write gate reads disk-fresh on purpose.
   */
  private readonly ownEntriesCache = new Map<
    string,
    { loadedAt: number; byPath: Map<string, OwnEntries | null> }
  >();
  private static readonly OWN_ENTRIES_TTL_MS = 5 * 60_000;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly kbDirName: string,
  ) {}

  /**
   * Drop a workspace's cached model + frontmatter memo. Call after operations
   * that mutate the working tree — commit, push, pull, branch switch.
   */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
    this.ownEntriesCache.delete(workspaceId);
  }

  /** Memoized `readOwnEntries` for the batch paths; see `ownEntriesCache`. */
  private async cachedOwnEntries(
    workspaceId: string,
    repoDir: string,
    relativePath: string,
  ): Promise<OwnEntries | null> {
    let ws = this.ownEntriesCache.get(workspaceId);
    if (!ws || Date.now() - ws.loadedAt > AccessControlService.OWN_ENTRIES_TTL_MS) {
      ws = { loadedAt: Date.now(), byPath: new Map() };
      this.ownEntriesCache.set(workspaceId, ws);
    }
    const hit = ws.byPath.get(relativePath);
    if (hit !== undefined || ws.byPath.has(relativePath)) return hit ?? null;
    const own = await this.readOwnEntries(repoDir, relativePath);
    ws.byPath.set(relativePath, own);
    return own;
  }

  /**
   * Validate a candidate `roles.yaml` against the resolver's OWN parser without
   * writing it. See `IAccessControl.validateRolesYaml` — this is the gate that
   * makes a malformed-`roles.yaml` admin lockout structurally impossible: the
   * roles-admin service runs it on every candidate before committing, and
   * because it IS `parseRolesYaml`, any text that passes here is loadable by
   * `loadModel`.
   */
  validateRolesYaml(text: string): { ok: true } | { ok: false; errors: string[] } {
    const parsed = parseRolesYaml(text);
    return parsed.ok ? { ok: true } : { ok: false, errors: parsed.errors };
  }

  /**
   * Advisory scan of folder `access.md` files for references to a role (by
   * canonical name). See `IAccessControl.referencesToRole` — undercounts node
   * frontmatter by design; powers the delete warning only, never the rename
   * gate.
   */
  async referencesToRole(
    workspaceId: string,
    canonicalRole: string,
  ): Promise<{ path: string; verb: string }[]> {
    const model = await this.loadModel(workspaceId);
    const out: { path: string; verb: string }[] = [];
    for (const file of model.accessFilesByDir.values()) {
      for (const verb of KNOWN_VERBS) {
        for (const entry of file.entries[verb]) {
          if (entry.kind === 'role' && entry.role === canonicalRole) {
            out.push({ path: file.path, verb });
          }
        }
      }
    }
    return out;
  }

  async canWrite(
    workspaceId: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return hasPermissionResolved(model, 'write', userEmail, relativePath, own);
  }

  async canRead(
    workspaceId: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return canReadResolved(model, userEmail, relativePath, own);
  }

  async canReadBatch(
    workspaceId: string,
    userEmail: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean>> {
    const model = await this.loadModel(workspaceId);
    const repoDir = await this.repoDir(workspaceId);
    // Read each path's own-entries in parallel rather than serially (the batch
    // path otherwise bottlenecks on per-file disk latency), memoized per
    // workspace so repeat tree builds skip the disk entirely.
    const owns = await Promise.all(relativePaths.map((p) => this.cachedOwnEntries(workspaceId, repoDir, p)));
    const result = new Map<string, boolean>();
    relativePaths.forEach((p, i) => {
      result.set(p, canReadResolved(model, userEmail, p, owns[i]));
    });
    return result;
  }

  async canWriteBatch(
    workspaceId: string,
    userEmail: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean>> {
    const model = await this.loadModel(workspaceId);
    const repoDir = await this.repoDir(workspaceId);
    // Parallel own-entries reads, memoized — same shape as `canReadBatch`.
    const owns = await Promise.all(relativePaths.map((p) => this.cachedOwnEntries(workspaceId, repoDir, p)));
    const result = new Map<string, boolean>();
    relativePaths.forEach((p, i) => {
      result.set(p, hasPermissionResolved(model, 'write', userEmail, p, owns[i]));
    });
    return result;
  }

  async canDownload(
    workspaceId: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return hasPermissionResolved(model, 'download', userEmail, relativePath, own);
  }

  async canOwner(
    workspaceId: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return hasPermissionResolved(model, 'owner', userEmail, relativePath, own);
  }

  async eligibleOwners(
    workspaceId: string,
    relativePath: string,
  ): Promise<{ roles: string[]; users: { name: string; email: string }[] }> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return eligibleHoldersResolved(model, 'owner', relativePath, own);
  }

  async eligibleWriters(
    workspaceId: string,
    relativePath: string,
  ): Promise<{ roles: string[]; users: { name: string; email: string }[] }> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return eligibleHoldersResolved(model, 'write', relativePath, own);
  }

  async eligibleReaders(
    workspaceId: string,
    relativePath: string,
  ): Promise<{ restricted: boolean; roles: string[]; users: { name: string; email: string }[] }> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    // When `read: everyone` applies cleanly, the node is readable by all users
    // and the role/user lists are meaningless. Otherwise return the explicit
    // reader set; it may be empty for a default-denied path with no grants.
    if (canEveryoneReadResolved(model, relativePath, own)) {
      return { restricted: false, roles: [], users: [] };
    }
    const { roles, users } = eligibleHoldersResolved(model, 'read', relativePath, own);
    return { restricted: true, roles, users };
  }

  async eligibleDownloaders(
    workspaceId: string,
    relativePath: string,
  ): Promise<{ roles: string[]; users: { name: string; email: string }[] }> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return eligibleHoldersResolved(model, 'download', relativePath, own);
  }

  async eligibleWriterEmails(
    workspaceId: string,
    relativePath: string,
  ): Promise<Map<string, { name: string; email: string }>> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return eligibleHolderEmailsResolved(model, 'write', relativePath, own);
  }

  async eligibleOwnerEmails(
    workspaceId: string,
    relativePath: string,
  ): Promise<Map<string, { name: string; email: string }>> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return eligibleHolderEmailsResolved(model, 'owner', relativePath, own);
  }

  async grantSources(
    workspaceId: string,
    kind: AccessTargetKind,
    relativePath: string,
    principal: GrantPrincipal,
  ): Promise<GrantSources> {
    const model = await this.loadModel(workspaceId);
    // A file target consults its own frontmatter as the most-specific scope; a
    // folder target's most-specific scope is its own access.md (in the dir
    // chain), so it passes no fileOwn.
    const own =
      kind === 'file'
        ? await this.readOwnEntries(await this.repoDir(workspaceId), relativePath)
        : null;
    const out: GrantSources = {};
    for (const verb of KNOWN_VERBS) {
      const sources = resolveGrantSourcesForVerb(model, verb, kind, relativePath, principal, own);
      if (sources.length > 0) out[verb] = sources;
    }
    return out;
  }

  async kbPrincipals(
    workspaceId: string,
  ): Promise<{ groups: string[]; people: { name: string; email: string }[] }> {
    let model: AccessModel;
    try {
      model = await this.loadModel(workspaceId);
    } catch {
      return { groups: [], people: [] };
    }
    // Groups = the built-in `everyone` role plus every declared role's display
    // name. `everyone` is surfaced so the share UI can grant public read; the
    // grant route gates it to the `read` verb only (write/owner/download
    // everyone stay a direct-access.md edit).
    const groups = [
      EVERYONE_DISPLAY,
      ...[...model.roles.byCanonical.values()].map((r) => r.displayName),
    ];
    // People = roles.yaml member emails (name-less) ∪ access.md `Name <email>`
    // grants (named). The login-only users table is unioned in by the caller.
    const byEmail = new Map<string, string>(); // email -> display name ('' if unknown)
    for (const email of model.roles.byEmail.keys()) {
      if (!byEmail.has(email)) byEmail.set(email, '');
    }
    for (const file of model.accessFilesByDir.values()) {
      for (const verb of KNOWN_VERBS) {
        for (const entry of file.entries[verb]) {
          if (entry.kind === 'user' && entry.displayName && !byEmail.get(entry.email)) {
            byEmail.set(entry.email, entry.displayName);
          }
        }
      }
    }
    const people = [...byEmail.entries()].map(([email, name]) => ({
      name: name || email.split('@')[0],
      email,
    }));
    return { groups, people };
  }

  async findEmailByHash(
    workspaceId: string,
    hash: string,
  ): Promise<{ email: string; displayName: string } | null> {
    let model: AccessModel;
    try {
      model = await this.loadModel(workspaceId);
    } catch {
      return null;
    }

    // Build a name index from access.md user grants — those carry an
    // explicit `Name <email>` so we can show "Felix Kissel" instead of
    // "felix.kissel". roles.yaml only has emails, no names. Scan every
    // verb's entries so a user named only under `download:` still
    // contributes their display name.
    const namesByEmail = new Map<string, string>();
    for (const file of model.accessFilesByDir.values()) {
      for (const verb of KNOWN_VERBS) {
        for (const entry of file.entries[verb]) {
          if (entry.kind === 'user' && entry.displayName && !namesByEmail.has(entry.email)) {
            namesByEmail.set(entry.email, entry.displayName);
          }
        }
      }
    }

    const candidates = new Set<string>([
      ...model.roles.byEmail.keys(),
      ...namesByEmail.keys(),
    ]);
    for (const email of candidates) {
      if (sha256Email(email) === hash) {
        const displayName = namesByEmail.get(email) ?? email.split('@')[0];
        return { email, displayName };
      }
    }
    return null;
  }

  async canWriteAtRef(
    workspaceId: string,
    ref: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean | null> {
    const loaded = await this.loadModelAtRef(workspaceId, ref);
    if (!loaded) return null;
    const repoDir = await this.repoDir(workspaceId);
    const own = await this.readOwnEntriesAtRef(repoDir, loaded.resolvedRef, relativePath);
    return hasPermissionResolved(loaded.model, 'write', userEmail, relativePath, own);
  }

  async canReadAtRef(
    workspaceId: string,
    ref: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean | null> {
    const loaded = await this.loadModelAtRef(workspaceId, ref);
    if (!loaded) return null;
    const repoDir = await this.repoDir(workspaceId);
    const own = await this.readOwnEntriesAtRef(repoDir, loaded.resolvedRef, relativePath);
    return canReadResolved(loaded.model, userEmail, relativePath, own);
  }

  async canWriteBatchAtRef(
    workspaceId: string,
    ref: string,
    userEmail: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean> | null> {
    const loaded = await this.loadModelAtRef(workspaceId, ref);
    if (!loaded) return null;
    const repoDir = await this.repoDir(workspaceId);
    // One `git cat-file --batch` for the whole path set — a per-path `git
    // show` spawn made CR owner-routing take minutes on large change sets.
    const owns = await this.readOwnEntriesAtRefBatch(repoDir, loaded.resolvedRef, relativePaths);
    const result = new Map<string, boolean>();
    for (const p of relativePaths) {
      result.set(p, hasPermissionResolved(loaded.model, 'write', userEmail, p, owns.get(p) ?? null));
    }
    return result;
  }

  async existsAtRef(workspaceId: string, ref: string, relativePath: string): Promise<boolean> {
    try {
      const repoDir = await this.repoDir(workspaceId);
      // `-e` answers for trees as well as blobs, which is the point: the
      // caller is usually asking about a FOLDER. Exit status is the whole
      // answer, so nothing is read into memory. The empty path means the
      // repo root, which exists exactly when the ref itself resolves to a
      // tree — `<ref>^{tree}` asks git that question directly, so a bogus
      // ref answers false here too instead of an unconditional true.
      const target = relativePath ? `${ref}:${relativePath}` : `${ref}^{tree}`;
      await execFileAsync('git', ['-C', repoDir, 'cat-file', '-e', target]);
      return true;
    } catch {
      // Missing path, unresolvable ref, or no repo at all — indistinguishable
      // from the exit status, and deliberately not teased apart here. The one
      // caller that treats `false` as permission (the new-folder carve-out)
      // guards itself by ALSO requiring the parent to exist, so a bogus ref
      // fails that check first and grants nothing.
      return false;
    }
  }

  async eligibleWritersAtRef(
    workspaceId: string,
    ref: string,
    relativePath: string,
  ): Promise<{ roles: string[]; users: { name: string; email: string }[] } | null> {
    const loaded = await this.loadModelAtRef(workspaceId, ref);
    if (!loaded) return null;
    const repoDir = await this.repoDir(workspaceId);
    const own = await this.readOwnEntriesAtRef(repoDir, loaded.resolvedRef, relativePath);
    return eligibleHoldersResolved(loaded.model, 'write', relativePath, own);
  }

  async eligibleWritersForPathsAtRef(
    workspaceId: string,
    ref: string,
    relativePaths: string[],
  ): Promise<Map<
    string,
    {
      roles: string[];
      users: { name: string; email: string }[];
      emails: Set<string>;
      excludedEmails?: Set<string>;
    }
  > | null> {
    const loaded = await this.loadModelAtRef(workspaceId, ref);
    if (!loaded) return null;
    const repoDir = await this.repoDir(workspaceId);
    const result = new Map<
      string,
      {
        roles: string[];
        users: { name: string; email: string }[];
        emails: Set<string>;
        excludedEmails?: Set<string>;
      }
    >();
    // One `git cat-file --batch` for the whole path set — see canWriteBatchAtRef.
    const owns = await this.readOwnEntriesAtRefBatch(repoDir, loaded.resolvedRef, relativePaths);
    for (const p of relativePaths) {
      const own = owns.get(p) ?? null;
      const display = eligibleHoldersResolved(loaded.model, 'write', p, own);
      const emails = new Set(eligibleHolderEmailsResolved(loaded.model, 'write', p, own).keys());
      const excludedEmails = ineligibleNamedEmailsResolved(loaded.model, 'write', p, own);
      result.set(p, { roles: display.roles, users: display.users, emails, excludedEmails });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Model loading
  // -------------------------------------------------------------------------

  private async loadModel(workspaceId: string): Promise<AccessModel> {
    const cached = this.cache.get(workspaceId);
    if (cached && Date.now() - cached.loadedAt < AccessControlService.CACHE_TTL_MS) {
      return cached.model;
    }

    const repoDir = await this.repoDir(workspaceId);

    let rolesYaml: string;
    try {
      rolesYaml = await fs.readFile(path.join(repoDir, 'roles.yaml'), 'utf-8');
    } catch {
      throw new AccessConfigError([`roles.yaml not found in ${this.kbDirName}/`]);
    }

    const rolesParsed = parseRolesYaml(rolesYaml);
    if (!rolesParsed.ok) throw new AccessConfigError(rolesParsed.errors);

    const accessFiles = new Map<string, AccessFile>();

    // Walk the entire repo for `access.md` files. The access tree is
    // structure-agnostic — any `access.md` at any depth (including repo
    // root) participates, no matter the folder layout. The recursive
    // walker skips VCS metadata + `node_modules`; everything else is fair
    // game. Missing root `access.md` is OK at runtime — default-deny
    // applies (the validator surfaces it as a warning separately).
    //
    // Per-file failures (malformed YAML, bad role refs, unknown verbs)
    // are logged + the offending file is dropped from the model — they
    // do NOT throw `AccessConfigError`. A typo in one nested access.md
    // must not 500 the entire editor; admins can still write `access.md`
    // / `roles.yaml` because `hasPermissionResolved` admin-rescues those
    // paths, so the bad config remains fixable from inside the app.
    await this.collectAccessFiles(repoDir, '', accessFiles);

    // Validate role refs against roles.yaml. `everyone` is a built-in role and
    // is valid without a roles.yaml entry. Unknown refs are dropped from the
    // parsed entry list (along with a warn log) so the rest of the file still
    // applies.
    for (const [, file] of accessFiles) {
      for (const verb of KNOWN_VERBS) {
        file.entries[verb] = file.entries[verb].filter((entry) => {
          if (entry.kind === 'role' && !roleKnown(rolesParsed.index, entry.role)) {
            console.warn(
              `[access] ${file.path}: '${verb}' references unknown role '${entry.displayRole}' — entry ignored`,
            );
            return false;
          }
          return true;
        });
      }
    }

    const model: AccessModel = {
      roles: rolesParsed.index,
      accessFilesByDir: accessFiles,
    };
    this.cache.set(workspaceId, { model, loadedAt: Date.now() });
    return model;
  }

  private async collectAccessFiles(
    absDir: string,
    relDir: string,
    out: Map<string, AccessFile>,
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip VCS metadata + vendored deps. Hidden dirs (`.git`, `.vscode`,
      // etc.) and `node_modules` can't host KB rules and are often huge —
      // walking them would slow every cache miss without benefit.
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.collectAccessFiles(abs, rel, out);
      } else if (entry.isFile() && entry.name === 'access.md') {
        const text = await fs.readFile(abs, 'utf-8');
        const parsed = parseAccessFile(text, rel);
        if (!parsed.ok) {
          // Treat as if the file didn't exist for resolution purposes.
          // Admin-rescue on access.md paths still lets an admin fix it.
          for (const e of parsed.errors) console.warn(`[access] ${e} — file ignored`);
          continue;
        }
        for (const w of parsed.warnings) console.warn(`[access] ${w}`);
        if (out.has(parsed.file.dir)) {
          console.warn(
            `[access] ${rel}: duplicate access.md for directory '${parsed.file.dir}' — keeping the first one seen`,
          );
          continue;
        }
        out.set(parsed.file.dir, parsed.file);
      }
    }
  }

  private async repoDir(workspaceId: string): Promise<string> {
    const wsDir = await this.workspaceService.getWorkspacePath(workspaceId);
    return path.join(wsDir, this.kbDirName);
  }

  /**
   * Read the access verbs a file declares FOR ITSELF from the working tree.
   * Returns null when the file has no per-file access config (the common
   * case). `roles.yaml` is never a node; an `access.md` governs itself only
   * in the new (body-governed) format, where its frontmatter is self-access —
   * see {@link accessMdSelfEntries}. A legacy `access.md` still yields null:
   * its frontmatter IS the folder rules the dir chain already applies.
   */
  private async readOwnEntries(
    repoDir: string,
    relativePath: string,
  ): Promise<OwnEntries | null> {
    if (relativePath === 'roles.yaml') return null;
    let text: string;
    try {
      text = await fs.readFile(path.join(repoDir, relativePath), 'utf-8');
    } catch {
      return null;
    }
    if (isAccessMdPath(relativePath)) return accessMdSelfEntries(text);
    return parseOwnAccessEntries(text);
  }

  /**
   * Same as `readOwnEntries` but reads the file at a specific git ref. The ref
   * MUST be the same one the dir model was loaded at — otherwise a user could
   * grant themselves rights by editing a file's frontmatter in a branch the
   * gate isn't reading from.
   */
  private async readOwnEntriesAtRef(
    repoDir: string,
    ref: string,
    relativePath: string,
  ): Promise<OwnEntries | null> {
    if (relativePath === 'roles.yaml') return null;
    const text = await this.showAtRef(repoDir, ref, relativePath);
    if (text === null) return null;
    if (isAccessMdPath(relativePath)) return accessMdSelfEntries(text);
    return parseOwnAccessEntries(text);
  }

  /**
   * Batched `readOwnEntriesAtRef`: ONE `git cat-file --batch` process reads
   * every path's blob at `ref`, instead of one `git show` SPAWN per path —
   * the difference between minutes and sub-second when a change request
   * touches hundreds of files. Paths missing at the ref, non-blob paths, and
   * `access.md`/`roles.yaml` (which carry no own-entries) resolve to null,
   * mirroring the single-path helper.
   */
  private async readOwnEntriesAtRefBatch(
    repoDir: string,
    ref: string,
    relativePaths: string[],
  ): Promise<Map<string, OwnEntries | null>> {
    const result = new Map<string, OwnEntries | null>();
    const wanted: string[] = [];
    for (const p of relativePaths) {
      if (p === 'roles.yaml') result.set(p, null);
      else if (!wanted.includes(p)) wanted.push(p);
    }
    if (wanted.length === 0) return result;
    const texts = await catFileBatch(repoDir, wanted.map((p) => `${ref}:${p}`));
    wanted.forEach((p, i) => {
      const text = texts[i];
      if (text === null) result.set(p, null);
      else result.set(p, isAccessMdPath(p) ? accessMdSelfEntries(text) : parseOwnAccessEntries(text));
    });
    return result;
  }

  /**
   * Resolve a candidate ref to one git accepts. Falls back to `origin/<ref>`
   * for short branch names, matching the heuristic in
   * `WorkspaceService.readFileAtRef`.
   */
  private refCandidates(ref: string): string[] {
    if (ref.startsWith('origin/') || ref.startsWith('refs/')) return [ref];
    return [ref, `origin/${ref}`];
  }

  /**
   * Read a file's content at a specific ref via `git show <ref>:<path>`.
   * Returns null when the file is absent on that ref (or the ref doesn't
   * resolve).
   */
  private async showAtRef(repoDir: string, ref: string, relativePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repoDir, 'show', `${ref}:${relativePath}`],
        { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * List every `access.md` path that exists at any depth as of `ref`.
   * The access tree is structure-agnostic: any `access.md` participates
   * regardless of where it sits. Uses `git ls-tree -r --name-only`.
   */
  private async listAccessFilesAtRef(repoDir: string, ref: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repoDir, 'ls-tree', '-r', '--name-only', ref],
        { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
      );
      const out: string[] = [];
      for (const line of stdout.split('\n')) {
        const p = line.trim();
        if (!p) continue;
        if (p === 'access.md' || p.endsWith('/access.md')) out.push(p);
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Build the access model from the access tree as it exists on a specific
   * ref. The ref is the authoritative source — typically `origin/<base>`
   * for PR-time decisions, so a malicious user can't grant themselves
   * approval rights by editing access.md in their working tree (or even on
   * an unmerged branch).
   *
   * Returns null when the ref doesn't carry usable access config (no
   * `roles.yaml`, or roles.yaml is malformed). Callers treat null as
   * "can't determine eligibility, deny." That includes the bootstrap case
   * where access.md hasn't been merged to the target branch yet — admins
   * must commit the initial config directly to the protected branch before
   * the gate becomes useful. NEVER fall back to the working tree here: a
   * working-tree fallback lets anyone with edit access to access.md grant
   * themselves approval rights.
   */
  private async loadModelAtRef(
    workspaceId: string,
    ref: string,
  ): Promise<{ model: AccessModel; resolvedRef: string } | null> {
    const repoDir = await this.repoDir(workspaceId);

    // Refresh remote-tracking refs so a PR branch we've never personally
    // checked out is resolvable. Best-effort — a fetch failure shouldn't
    // block the lookup if the ref already exists locally.
    await this.workspaceService.ensureRemotesFetched(workspaceId).catch(() => undefined);

    let rolesYaml: string | null = null;
    let resolvedRef: string | null = null;
    for (const candidate of this.refCandidates(ref)) {
      const text = await this.showAtRef(repoDir, candidate, 'roles.yaml');
      if (text !== null) {
        rolesYaml = text;
        resolvedRef = candidate;
        break;
      }
    }
    if (!rolesYaml || !resolvedRef) return null;

    const rolesParsed = parseRolesYaml(rolesYaml);
    if (!rolesParsed.ok) return null;

    const accessFiles = new Map<string, AccessFile>();
    const accessPaths = await this.listAccessFilesAtRef(repoDir, resolvedRef);
    for (const p of accessPaths) {
      const text = await this.showAtRef(repoDir, resolvedRef, p);
      if (text === null) continue;
      const parsed = parseAccessFile(text, p);
      if (!parsed.ok) continue;
      // Last-writer-wins on dir collisions; the at-ref path should never
      // collide in a healthy tree because the working-tree validator forbids
      // duplicates, but be defensive.
      accessFiles.set(parsed.file.dir, parsed.file);
    }

    // Mirror `loadModel`: drop entries whose role ref is unknown to roles.yaml,
    // while preserving the built-in `everyone` role.
    for (const [, file] of accessFiles) {
      for (const verb of KNOWN_VERBS) {
        file.entries[verb] = file.entries[verb].filter(
          (entry) => entry.kind !== 'role' || roleKnown(rolesParsed.index, entry.role),
        );
      }
    }

    return {
      model: {
        roles: rolesParsed.index,
        accessFilesByDir: accessFiles,
      },
      resolvedRef,
    };
  }
}

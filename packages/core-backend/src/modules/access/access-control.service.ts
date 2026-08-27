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
  ResolvedPrincipal,
} from './access-control.interface.js';
import { AccessConfigError, AccessUnreadableError } from '../access-model/access-errors.js';
import {
  GROUPS_YAML,
  SYNCED_GROUPS_YAML,
  parseGroupsFile,
  type GroupsIndex,
} from '../access-model/group-files.js';
import {
  ADMIN_CANONICAL,
  EVERYONE_CANONICAL,
  EVERYONE_DISPLAY,
  KNOWN_VERBS,
  ROLE_TOKEN_PREFIX,
  accessMdSelfEntries,
  canonicalEmail,
  canonicalRoleName,
  isAccessMdPath,
  mergeGroupsIntoRoles,
  parseAccessFile,
  parseOwnAccessEntries,
  parseRolesYaml,
  sourceVerbsFor,
  type AccessFile,
  type OwnEntries,
  type ParsedEntry,
  type RolesIndex,
  type Verb,
} from '../access-model/access-grammar.js';
import {
  DIRECTORY_SYNC_BOT_EMAIL,
  DIRECTORY_SYNC_BOT_NAME,
} from './directory-sync-bot.js';

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


interface AccessModel {
  roles: RolesIndex;
  accessFilesByDir: Map<string, AccessFile>;
  /**
   * Whether the active groups source loaded cleanly — see {@link GroupsHealth}.
   * A broken source degrades (groups contribute nothing) but is recorded here
   * so admin surfaces can banner it instead of silently resolving without
   * groups.
   */
  groupsHealth: GroupsHealth;
  /**
   * Canonical emails that count as Admin whatever `roles.yaml` says — the
   * deployment owner (`ADMIN_EMAIL`). Empty when none is configured.
   *
   * This exists for the two hardcoded `write` rescues below, and only those.
   * It is NOT a general grant: it never enters scope resolution, so it gives
   * no read, no download, and no write anywhere except `roles.yaml` and
   * `access.md`. The deployment owner is the person who can already change
   * `ADMIN_EMAIL` itself, so admitting them to the rescue path concedes
   * nothing they could not already take — while withholding it turns a
   * `roles.yaml` that has lost its last Admin into a knowledge base nobody
   * can repair through the app.
   */
  deploymentOwners: ReadonlySet<string>;
}

function isBuiltInRole(canonicalRole: string): boolean {
  return canonicalRole === EVERYONE_CANONICAL;
}

function roleKnown(roles: RolesIndex, canonicalRole: string): boolean {
  return roles.byCanonical.has(canonicalRole) || isBuiltInRole(canonicalRole);
}


/**
 * Health of the ACTIVE groups source as of the last load. `ok: false` means
 * the source EXISTS but could not be read or parsed — groups contribute
 * nothing, bare grant tokens fall through to roles, and group-backed denies
 * drop (the owner's explicit degrade-loudly decision, NOT fail-closed). The
 * marker is carried on the loaded model and surfaced by the groups admin
 * endpoints so the Groups page can banner it.
 */
export type GroupsHealth = { ok: true } | { ok: false; file: string; reason: string };

/** True for the errno codes that mean "the file genuinely is not there". */
function isAbsenceError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Load the ACTIVE group source through `read` (working tree or at-ref — the
 * caller supplies the reader, so both model loaders share one mode rule):
 * `synced-groups.yaml` existing → IdP mode (groups.yaml ignored entirely,
 * even when the synced file is empty or malformed — falling back would
 * resurrect retired manual groups); otherwise `groups.yaml` → manual mode.
 *
 * `read` returns null for a genuinely-absent file and may THROW for any other
 * failure. Only ENOENT/ENOTDIR count as absent (the caller may also whitelist
 * them into null); every other read error — notably a non-absence error on
 * `synced-groups.yaml` — is treated as a BROKEN source: no groups, no
 * fallback to the manual file (falling back would resurrect retired groups),
 * and an `ok: false` health marker. Structural parse failures degrade the
 * same way; this function never throws.
 */
export async function loadActiveGroups(
  read: (filename: string) => Promise<string | null>,
): Promise<{ groups: GroupsIndex; sourceFile: string; warnings: string[]; health: GroupsHealth }> {
  const broken = (file: string, reason: string) => ({
    groups: new Map() as GroupsIndex,
    sourceFile: file,
    warnings: [],
    health: { ok: false as const, file, reason },
  });

  let syncedText: string | null;
  try {
    syncedText = await read(SYNCED_GROUPS_YAML);
  } catch (err) {
    // An at-ref `read` throws this when git itself failed — the file's
    // existence is UNKNOWN, not absent and not broken. That must propagate:
    // swallowing it into a broken-groups marker builds a model with no groups
    // in it and caches that model for the commit, so every group-based grant
    // and denial at that commit is wrong on the strength of a flaky
    // subprocess. roles.yaml and access.md already fail the build closed on
    // the same error; groups cannot be the one input that does not.
    if (err instanceof AccessUnreadableError) throw err;
    if (isAbsenceError(err)) {
      syncedText = null;
    } else {
      // A non-absence read error on the SYNCED source must NOT fall back to
      // groups.yaml — the synced file may exist and its manual predecessor is
      // retired. Broken-groups instead.
      return broken(SYNCED_GROUPS_YAML, err instanceof Error ? err.message : String(err));
    }
  }

  const sourceFile = syncedText !== null ? SYNCED_GROUPS_YAML : GROUPS_YAML;
  let text: string | null;
  if (syncedText !== null) {
    text = syncedText;
  } else {
    try {
      text = await read(GROUPS_YAML);
    } catch (err) {
      if (err instanceof AccessUnreadableError) throw err; // see above
      if (isAbsenceError(err)) text = null;
      else return broken(GROUPS_YAML, err instanceof Error ? err.message : String(err));
    }
  }
  if (text === null) return { groups: new Map(), sourceFile, warnings: [], health: { ok: true } };

  const parsed = parseGroupsFile(text, sourceFile);
  if (!parsed.ok) return broken(sourceFile, parsed.errors.join('; '));
  return { groups: parsed.groups, sourceFile, warnings: parsed.warnings, health: { ok: true } };
}


// ---------------------------------------------------------------------------
// Resolver — walks repo root → file dir, accumulating per-principal state.
// ---------------------------------------------------------------------------

type GrantState = 'grant' | 'denied';


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
  if (model.deploymentOwners.has(email)) return true;
  const roles = model.roles.byEmail.get(email);
  // Check the explicit `role/admin` alias, NOT the bare token: bare-name
  // precedence is group-first, so a group that happens to be named "Admin"
  // owns the bare key — and its members must never inherit the capability.
  return !!roles && roles.has(`${ROLE_TOKEN_PREFIX}${ADMIN_CANONICAL}`);
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
 * "Admin" for BOTH rescues means the `Admin` role in `roles.yaml` OR the
 * deployment owner (`ADMIN_EMAIL`). Without the second, the first rule turns
 * into the lockout it exists to prevent: a `roles.yaml` that has lost its last
 * Admin — a bad merge, a renamed address, a restored backup — can then be
 * repaired only by committing to the KB repo by hand, because the one file
 * that decides who may fix it is the one file nobody may write. The deployment
 * owner is whoever can already set `ADMIN_EMAIL`, so this concedes no
 * authority they did not have; it only gives it a door.
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
 * a `role` by its role token. A grant that reaches the user via a group/role they
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
 * in (removing it is still meaningful if the group/role grant is later removed).
 */
function resolveGrantSourcesForVerb(
  model: AccessModel,
  verb: Verb,
  kind: AccessTargetKind,
  relativePath: string,
  principal: GrantPrincipal,
  fileOwn?: OwnEntries | null,
  tokenMatch?: 'exact' | 'name',
): GrantSource[] {
  const scopes = resolveScopes(model, verb, relativePath, fileOwn);
  const out: GrantSource[] = [];

  if (principal.kind === 'role') {
    // A named principal can be spelled two ways in a file: the bare token and
    // the explicit `role/<name>` token. WHICH spellings are THIS principal's
    // entries depends on who owns the bare key in the merged index:
    //
    //   - UNSHADOWED (no group named `<bare>`): both spellings resolve to the
    //     role, so both count — a grant under either adds a source; a deny
    //     under either cuts off farther grants. (The revoke splice strips both
    //     spellings in this case too, so classification and removal agree.)
    //   - SHADOWED (a group owns the bare key): the spellings are DIFFERENT
    //     principals. A bare-token principal is the GROUP — only bare entries
    //     are its own; a `role/`-token principal is the ROLE — only `role/`
    //     entries are its own. Counting the other spelling would attribute a
    //     shadowed bare token to the role (hiding a real `role/<name>`
    //     ancestor grant and making its revoke a false no-op), or vice versa.
    //
    //   - PINNED EXACT (`tokenMatch: 'exact'`): only the literally-spelled
    //     token is this principal's entry, shadowing notwithstanding. The
    //     caller pinned the same identity into the splice it is checking —
    //     a GROUP whose group has VANISHED reads "unshadowed" here, and the
    //     alias-tolerant pair would then attribute a same-named role's
    //     surviving `role/<name>` grant to the group.
    const canonical = canonicalRoleName(principal.role);
    const explicit = canonical.startsWith(ROLE_TOKEN_PREFIX);
    const bare = explicit ? canonical.slice(ROLE_TOKEN_PREFIX.length) : canonical;
    const shadowed = model.roles.byCanonical.get(bare)?.kind === 'group';
    const tokens =
      tokenMatch === 'exact' || shadowed
        ? [explicit ? `${ROLE_TOKEN_PREFIX}${bare}` : bare]
        : [bare, `${ROLE_TOKEN_PREFIX}${bare}`];
    for (const scope of scopes) {
      const states = tokens.map((t) => scope.byRole.get(t));
      if (states.includes('grant')) {
        out.push(scopeToGrantSource(scope, kind, relativePath));
        continue;
      }
      if (states.includes('denied')) break; // a closer deny cuts off farther grants
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
): { principals: ResolvedPrincipal[]; roles: string[]; users: { name: string; email: string }[] } {
  const { byRole, byEmail } = resolveAtPath(model, verb, relativePath, fileOwn);

  // (kind, display name) → one entry. The `byRole` keys are the merged
  // index's canonical tokens exactly as granted (bare, or the
  // `role/<canonical>` alias); the `byCanonical` record a key hits carries
  // its kind — a `role/` alias always hits the role record, a bare key hits
  // whichever principal owns it under group-first precedence. A token with no
  // record (the built-in `everyone`, or a grant naming a since-vanished
  // principal) degrades to 'role', the pre-groups display. When one display
  // name is granted as BOTH (a role via its `role/` alias plus a same-named
  // group via the bare token) BOTH entries survive — they are DIFFERENT
  // principals, and collapsing them to one would hide the role's live
  // `role/<name>` grant from every consumer of the eligible list.
  const byIdentity = new Map<string, ResolvedPrincipal>();
  const addPrincipal = (name: string, kind: 'role' | 'group') => {
    const key = `${kind}\0${name.toLowerCase()}`;
    if (!byIdentity.has(key)) byIdentity.set(key, { name, kind });
  };
  for (const [canonical, state] of byRole) {
    if (state !== 'grant') continue;
    const record = model.roles.byCanonical.get(canonical);
    addPrincipal(record ? record.displayName : canonical, record?.kind ?? 'role');
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
    // Look the Admin ROLE up via its explicit alias — the bare key may be
    // owned by a same-named group under group-first precedence. The override
    // is the ROLE's capability, so the row's kind is 'role' regardless.
    const adminRole = model.roles.byCanonical.get(`${ROLE_TOKEN_PREFIX}${ADMIN_CANONICAL}`);
    addPrincipal(adminRole ? adminRole.displayName : ADMIN_CANONICAL, 'role');
  }

  const principals: ResolvedPrincipal[] = [...byIdentity.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
  // Legacy name-only list, kind erased — kept for the many consumers that
  // only ever render names (banners, contact lines, PR-routing messages).
  // De-duplicated: a name granted as both group and role appears once here.
  const roles = [...new Set(principals.map((p) => p.name))];

  const users: { name: string; email: string }[] = [];
  for (const [email, state] of byEmail) {
    if (state !== 'grant') continue;
    users.push({ name: '', email });
  }
  users.sort((a, b) => a.email.localeCompare(b.email));

  return { principals, roles, users };
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

/**
 * An access model read at a git ref. `resolvedRef` is the COMMIT the model
 * was built from (not the ref name that led there), so the per-file
 * own-entries reads that follow a gate resolve against exactly that tree.
 */
type AtRefModel = { model: AccessModel; resolvedRef: string };
/**
 * One build's outcome: a model, no roles.yaml at the commit, or one that
 * doesn't parse. A git read failure is none of these: it throws
 * AccessUnreadableError out of the build instead.
 */
type AtRefBuild = AtRefModel | 'no-roles' | 'malformed';

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

  /**
   * At-ref models keyed by workspace + the COMMIT the ref resolved to. The
   * tree at a commit is immutable, so an entry can never go stale: a push
   * that moves `origin/<base>` resolves to a new commit and simply misses.
   * No TTL, and `invalidate()` leaves it alone, for the same reason.
   *
   * This is what makes the change-request gates affordable. One detail read
   * plus one approval click runs six at-ref gates, and before this cache
   * every one of them rebuilt the model from git: an `ls-tree -r` plus a
   * `git show` per `access.md`, ~270ms each on a real knowledge base. Six
   * builds per click was the lag behind the approve checkmark.
   *
   * Bounded FIFO, so a long-lived server holds the last few tips rather than
   * one model per commit it ever gated against. A build that found no usable
   * roles.yaml is deliberately NOT cached, and a build that saw any git read
   * fail never becomes a model at all: it throws AccessUnreadableError and the
   * gate fails closed for that call. Both are what a transient failure looks
   * like, and pinning either to a commit would turn one hiccup into a wrong
   * verdict, denying or granting, until the base branch moved. Concurrent
   * misses on the same commit share one build via `atRefInFlight`.
   */
  private readonly atRefCache = new Map<string, AtRefModel>();
  private readonly atRefInFlight = new Map<string, Promise<AtRefBuild>>();
  private static readonly AT_REF_CACHE_MAX = 64;

  /**
   * Canonicalised deployment-owner emails (see `AccessModel.deploymentOwners`).
   * Held on the service rather than read per-model because it comes from the
   * environment, not from the knowledge base.
   */
  private readonly deploymentOwners: ReadonlySet<string>;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly kbDirName: string,
    /**
     * Emails that count as Admin for the two hardcoded `write` rescues,
     * whatever `roles.yaml` says — in practice `ADMIN_EMAIL`. Optional so the
     * many test fixtures that construct this service directly keep their
     * current behaviour (no owner, roles.yaml is the only authority).
     */
    deploymentOwners: readonly string[] = [],
  ) {
    this.deploymentOwners = new Set(
      deploymentOwners.filter(Boolean).map((e) => canonicalEmail(e)),
    );
  }

  /**
   * Drop a workspace's cached model + frontmatter memo. Call after operations
   * that mutate the working tree — commit, push, pull, branch switch. The
   * at-ref cache is untouched on purpose: its entries are keyed by commit,
   * and nothing that happens in a working tree changes what a commit holds.
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

  async canWrite(
    workspaceId: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean> {
    const machineOwned = this.machineOwnedWriteRule(userEmail, relativePath);
    if (machineOwned !== null) return machineOwned;
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
      const machineOwned = this.machineOwnedWriteRule(userEmail, p);
      result.set(p, machineOwned ?? hasPermissionResolved(model, 'write', userEmail, p, owns[i]));
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

  async canOwnerBatch(
    workspaceId: string,
    userEmail: string,
    relativePaths: string[],
  ): Promise<Map<string, boolean>> {
    const model = await this.loadModel(workspaceId);
    const repoDir = await this.repoDir(workspaceId);
    // Parallel own-entries reads, memoized — same shape as `canWriteBatch`.
    const owns = await Promise.all(relativePaths.map((p) => this.cachedOwnEntries(workspaceId, repoDir, p)));
    const result = new Map<string, boolean>();
    relativePaths.forEach((p, i) => {
      result.set(p, hasPermissionResolved(model, 'owner', userEmail, p, owns[i]));
    });
    return result;
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
  ): Promise<{
    principals: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
  }> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return eligibleHoldersResolved(model, 'owner', relativePath, own);
  }

  async eligibleWriters(
    workspaceId: string,
    relativePath: string,
  ): Promise<{
    principals: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
  }> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    return eligibleHoldersResolved(model, 'write', relativePath, own);
  }

  async eligibleReaders(
    workspaceId: string,
    relativePath: string,
  ): Promise<{
    restricted: boolean;
    principals: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
  }> {
    const model = await this.loadModel(workspaceId);
    const own = await this.readOwnEntries(await this.repoDir(workspaceId), relativePath);
    // When `read: everyone` applies cleanly, the node is readable by all users
    // and the role/user lists are meaningless. Otherwise return the explicit
    // reader set; it may be empty for a default-denied path with no grants.
    if (canEveryoneReadResolved(model, relativePath, own)) {
      return { restricted: false, principals: [], roles: [], users: [] };
    }
    const { principals, roles, users } = eligibleHoldersResolved(model, 'read', relativePath, own);
    return { restricted: true, principals, roles, users };
  }

  async eligibleDownloaders(
    workspaceId: string,
    relativePath: string,
  ): Promise<{
    principals: ResolvedPrincipal[];
    roles: string[];
    users: { name: string; email: string }[];
  }> {
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
    opts?: { tokenMatch?: 'exact' | 'name' },
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
      const sources = resolveGrantSourcesForVerb(
        model,
        verb,
        kind,
        relativePath,
        principal,
        own,
        opts?.tokenMatch,
      );
      if (sources.length > 0) out[verb] = sources;
    }
    return out;
  }

  async kbPrincipals(
    workspaceId: string,
  ): Promise<{ roles: string[]; groups: string[]; people: { name: string; email: string }[] }> {
    let model: AccessModel;
    try {
      model = await this.loadModel(workspaceId);
    } catch {
      return { roles: [], groups: [], people: [] };
    }
    // Roles = the built-in `everyone` role plus every declared role's display
    // name — ROLE principals only, never groups. Each role is enumerated via
    // its `role/<canonical>` alias key, which exists exactly once per role
    // (the bare key may be owned by a same-named group under group-first
    // precedence, and merged group entries must not appear here). `everyone`
    // is surfaced so the share UI can grant public read; the grant route
    // gates it to the `read` verb only (write/owner/download everyone stay a
    // direct-access.md edit).
    const roles = [EVERYONE_DISPLAY];
    const groups: string[] = [];
    for (const [key, principal] of model.roles.byCanonical) {
      if (key.startsWith(ROLE_TOKEN_PREFIX)) roles.push(principal.displayName);
      else if (principal.kind === 'group') groups.push(principal.displayName);
    }
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
    return { roles, groups, people };
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

  /**
   * `synced-groups.yaml` is MACHINE-OWNED: regenerated wholesale from the
   * directory mirror and committed by the directory-sync bot. The bot is its
   * ONLY writer — role/grant resolution never applies to it. That cuts both
   * ways: the bot needs no role to write it (it isn't in roles.yaml, and on a
   * protected branch nothing else would make it eligible), and no HUMAN can
   * hand-edit it through the app (an edit would be silently overwritten by
   * the next provisioning push anyway).
   */
  private machineOwnedWriteRule(userEmail: string, relativePath: string): boolean | null {
    if (relativePath !== SYNCED_GROUPS_YAML) return null;
    return userEmail.trim().toLowerCase() === DIRECTORY_SYNC_BOT_EMAIL;
  }

  async canWriteAtRef(
    workspaceId: string,
    ref: string,
    userEmail: string,
    relativePath: string,
  ): Promise<boolean | null> {
    const machineOwned = this.machineOwnedWriteRule(userEmail, relativePath);
    if (machineOwned !== null) return machineOwned;
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
    // Machine-owned paths resolve without the model (see machineOwnedWriteRule)
    // — matching canWriteAtRef, including on a repo with no rules at the ref.
    const machineAnswers = new Map<string, boolean>();
    for (const p of relativePaths) {
      const machineOwned = this.machineOwnedWriteRule(userEmail, p);
      if (machineOwned !== null) machineAnswers.set(p, machineOwned);
    }
    if (machineAnswers.size === relativePaths.length) return machineAnswers;
    const loaded = await this.loadModelAtRef(workspaceId, ref);
    if (!loaded) return null;
    const repoDir = await this.repoDir(workspaceId);
    // One `git cat-file --batch` for the whole path set — a per-path `git
    // show` spawn made CR owner-routing take minutes on large change sets.
    const owns = await this.readOwnEntriesAtRefBatch(repoDir, loaded.resolvedRef, relativePaths);
    const result = new Map<string, boolean>();
    for (const p of relativePaths) {
      const machineOwned = machineAnswers.get(p);
      result.set(
        p,
        machineOwned ?? hasPermissionResolved(loaded.model, 'write', userEmail, p, owns.get(p) ?? null),
      );
    }
    return result;
  }

  async eligibleWritersAtRef(
    workspaceId: string,
    ref: string,
    relativePath: string,
  ): Promise<{ roles: string[]; users: { name: string; email: string }[] } | null> {
    if (relativePath === SYNCED_GROUPS_YAML) {
      // Machine-owned — see machineOwnedWriteRule.
      return {
        roles: [],
        users: [{ name: DIRECTORY_SYNC_BOT_NAME, email: DIRECTORY_SYNC_BOT_EMAIL }],
      };
    }
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
    const result = new Map<
      string,
      {
        roles: string[];
        users: { name: string; email: string }[];
        emails: Set<string>;
        excludedEmails?: Set<string>;
      }
    >();
    // Machine-owned paths resolve without the model — same answer
    // eligibleWritersAtRef gives (including at a ref with no usable
    // roles.yaml), so batched consumers (CR owner-routing, approval state)
    // agree with the single-path surface.
    for (const p of relativePaths) {
      if (p === SYNCED_GROUPS_YAML) {
        result.set(p, {
          roles: [],
          users: [{ name: DIRECTORY_SYNC_BOT_NAME, email: DIRECTORY_SYNC_BOT_EMAIL }],
          emails: new Set([DIRECTORY_SYNC_BOT_EMAIL]),
        });
      }
    }
    // Only short-circuit when there IS a machine-owned path covering the
    // whole request: an EMPTY request must still answer null for an
    // unresolvable ref, as documented.
    if (relativePaths.length > 0 && result.size === relativePaths.length) return result;
    const loaded = await this.loadModelAtRef(workspaceId, ref);
    if (!loaded) return null;
    const repoDir = await this.repoDir(workspaceId);
    // One `git cat-file --batch` for the whole path set — see canWriteBatchAtRef.
    const owns = await this.readOwnEntriesAtRefBatch(repoDir, loaded.resolvedRef, relativePaths);
    for (const p of relativePaths) {
      if (result.has(p)) continue;
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

    // Groups — the other named-principal source. Loaded forgivingly (a broken
    // group file degrades to "contributes nothing"; only roles.yaml problems
    // may throw) and merged into the principal index, after which the resolver
    // below needs no group awareness at all. The reader whitelists ONLY
    // genuine absence (ENOENT/ENOTDIR → null, like synced-groups-committer);
    // any other read error propagates so loadActiveGroups records a
    // broken-groups marker instead of silently treating the file as missing.
    const activeGroups = await loadActiveGroups(async (filename) => {
      try {
        return await fs.readFile(path.join(repoDir, filename), 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw err;
      }
    });
    if (!activeGroups.health.ok) {
      console.error(
        `[access] groups source ${activeGroups.health.file} is broken (${activeGroups.health.reason}) — groups contribute nothing until it is fixed`,
      );
    }
    for (const w of activeGroups.warnings) console.warn(`[access] ${w}`);
    const mergeWarnings = mergeGroupsIntoRoles(
      rolesParsed.index,
      activeGroups.groups,
      activeGroups.sourceFile,
    );
    for (const w of mergeWarnings) console.warn(`[access] ${w}`);

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
      groupsHealth: activeGroups.health,
      deploymentOwners: this.deploymentOwners,
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
   * resolve) and also on any other git failure: the single-path gates that
   * call this have always treated the two alike. The at-ref model build
   * needs them told apart, so it reads through `showAtRefOutcome` instead.
   */
  private async showAtRef(repoDir: string, ref: string, relativePath: string): Promise<string | null> {
    const outcome = await this.showAtRefOutcome(repoDir, ref, relativePath);
    return outcome.kind === 'text' ? outcome.text : null;
  }

  /**
   * `git show <ref>:<path>`, telling "not there" apart from "git failed".
   * Absence is what git reports as `path '<p>' does not exist in '<ref>'`
   * (or `exists on disk, but not in`), plus an unresolvable ref; anything
   * else (an IO error, a corrupt object, a dying subprocess) is `error`.
   * `LC_ALL=C` pins the messages this classifies to English.
   */
  private async showAtRefOutcome(
    repoDir: string,
    ref: string,
    relativePath: string,
  ): Promise<{ kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'error' }> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repoDir, 'show', `${ref}:${relativePath}`],
        {
          encoding: 'utf-8',
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        },
      );
      return { kind: 'text', text: stdout };
    } catch (err) {
      const stderr =
        (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err));
      return /does not exist in|exists on disk, but not in|invalid object name|unknown revision|bad revision/.test(
        stderr,
      )
        ? { kind: 'absent' }
        : { kind: 'error' };
    }
  }

  /**
   * List every `access.md` path that exists at any depth as of `ref`.
   * The access tree is structure-agnostic: any `access.md` participates
   * regardless of where it sits. Uses `git ls-tree -r --name-only`.
   * `'error'` when git failed: a model built without its access files is
   * not the model, and the caller must not cache it as one.
   */
  private async listAccessFilesAtRef(repoDir: string, ref: string): Promise<string[] | 'error'> {
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
      return 'error';
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
   *
   * Cached per commit (see `atRefCache`): the ref is resolved to the commit
   * it points at first, and that commit is both the cache key and the ref
   * every read is pinned to. `resolvedRef` in the result is therefore a
   * commit SHA, so the own-entries read callers do afterwards can never
   * straddle a push that lands between the two.
   */
  private async loadModelAtRef(workspaceId: string, ref: string): Promise<AtRefModel | null> {
    const repoDir = await this.repoDir(workspaceId);

    // Refresh remote-tracking refs so a PR branch we've never personally
    // checked out is resolvable. Best-effort — a fetch failure shouldn't
    // block the lookup if the ref already exists locally.
    await this.workspaceService.ensureRemotesFetched(workspaceId).catch(() => undefined);

    // Same candidate order as before the cache existed: the first candidate
    // that carries a roles.yaml wins, so a local branch without one still
    // defers to `origin/<branch>`.
    for (const candidate of this.refCandidates(ref)) {
      const commit = await this.revParseCommit(repoDir, candidate);
      if (!commit) continue;
      const key = `${workspaceId}\0${commit}`;
      const hit = this.atRefCache.get(key);
      if (hit) return hit;
      // Registered BEFORE the first await on the build path, so concurrent
      // misses on one commit share a single build instead of all racing past
      // an empty in-flight check together.
      let pending = this.atRefInFlight.get(key);
      if (!pending) {
        pending = this.buildModelAtCommit(repoDir, commit, candidate)
          .then((built) => {
            if (typeof built !== 'string') this.rememberAtRef(key, built);
            return built;
          })
          .finally(() => {
            if (this.atRefInFlight.get(key) === pending) this.atRefInFlight.delete(key);
          });
        this.atRefInFlight.set(key, pending);
      }
      const built = await pending;
      if (built === 'no-roles') continue;
      if (built === 'malformed') return null;
      return built;
    }
    return null;
  }

  /** The commit `ref` points at in this clone, or null when it doesn't resolve. */
  private async revParseCommit(repoDir: string, ref: string): Promise<string | null> {
    if (!ref || ref.startsWith('-')) return null;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
        { encoding: 'utf-8' },
      );
      const sha = stdout.trim();
      return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  private rememberAtRef(key: string, value: AtRefModel): void {
    this.atRefCache.set(key, value);
    if (this.atRefCache.size > AccessControlService.AT_REF_CACHE_MAX) {
      const oldest = this.atRefCache.keys().next().value;
      if (oldest !== undefined) this.atRefCache.delete(oldest);
    }
  }

  /**
   * The uncached build behind `loadModelAtRef`: the whole access tree read
   * at `commit`. `label` is the candidate ref the commit came from, kept for
   * log lines only; every git read here is pinned to the commit. `'no-roles'`
   * means the commit carries no roles.yaml (the caller tries its next
   * candidate); `'malformed'` means it does but it doesn't parse (the caller
   * answers null, as it always has).
   */
  private async buildModelAtCommit(
    repoDir: string,
    commit: string,
    label: string,
  ): Promise<AtRefBuild> {
    // Every read below tells "absent" apart from "git failed". A failure
    // refuses the whole build: a model missing one access.md could grant what
    // that file denies, so no verdict is answered from it, nothing is cached,
    // and the caller fails closed (AccessUnreadableError, a 503) until a
    // retry reads the tree in full.
    const tag = `${label}@${commit.slice(0, 7)}`;
    const read = async (relativePath: string): Promise<string | null> => {
      const outcome = await this.showAtRefOutcome(repoDir, commit, relativePath);
      if (outcome.kind === 'error') {
        // The operational signal: one line per failed read, naming the commit
        // and the path, so a run of these is visible in the logs.
        console.warn(`[access@${tag}] git read of ${relativePath} failed; refusing to decide from a partial tree`);
        throw new AccessUnreadableError(label, relativePath);
      }
      return outcome.kind === 'text' ? outcome.text : null;
    };

    const rolesYaml = await read('roles.yaml');
    if (rolesYaml === null) return 'no-roles';
    const rolesParsed = parseRolesYaml(rolesYaml);
    if (!rolesParsed.ok) return 'malformed';

    // Same group loading as the working-tree model, read AT THE COMMIT — the
    // whole point of file-materialized groups is that the merge/push gates
    // can evaluate them at the commit they gate. `read` throws
    // `AccessUnreadableError` on a git failure and `loadActiveGroups` lets
    // that through, so a flaky subprocess fails this build closed exactly as
    // it does for roles.yaml and access.md; the broken-groups marker below
    // fires only on a file that was read and would not parse.
    const activeGroups = await loadActiveGroups(read);
    if (!activeGroups.health.ok) {
      console.error(
        `[access@${tag}] groups source ${activeGroups.health.file} is broken (${activeGroups.health.reason}) — groups contribute nothing until it is fixed`,
      );
    }
    for (const w of activeGroups.warnings) console.warn(`[access@${tag}] ${w}`);
    const mergeWarnings = mergeGroupsIntoRoles(
      rolesParsed.index,
      activeGroups.groups,
      activeGroups.sourceFile,
    );
    for (const w of mergeWarnings) console.warn(`[access@${tag}] ${w}`);

    const accessFiles = new Map<string, AccessFile>();
    const listed = await this.listAccessFilesAtRef(repoDir, commit);
    if (listed === 'error') {
      console.warn(`[access@${tag}] listing access.md files failed; refusing to decide from a partial tree`);
      throw new AccessUnreadableError(label, 'access.md (ls-tree)');
    }
    for (const p of listed) {
      const text = await read(p);
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
        groupsHealth: activeGroups.health,
        // Same owners as the working-tree model. The at-ref model backs the
        // PUSH gate, so omitting them here would let the deployment owner save
        // a roles.yaml repair locally and then be refused when it tries to
        // land — the lockout moved one step later, not removed.
        deploymentOwners: this.deploymentOwners,
      },
      resolvedRef: commit,
    };
  }
}

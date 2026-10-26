/**
 * SHARED grant-reference machinery — the single implementation both admin
 * services (roles + groups) drive for "which access rules name this
 * principal" and "rewrite every reference atomically":
 *
 *   - `resolverRoleRefs`: what IS a principal reference — the resolver's own
 *     parse of each file, so the reports name every enforced rule.
 *   - `findRoleRefsInText` / `rewriteRoleTokensInText`: the line-level walk
 *     the rename edits text with. It handles block lists and `key: value`
 *     entries; quoted and flow-YAML own frontmatter is rewritten by the
 *     full parser's own tree (`rewriteOwnFrontmatterStructurally`). The
 *     rewrite re-checks its result with `resolverRoleRefs` and refuses
 *     when a reference survives, so the warning and the rename can never
 *     disagree.
 *   - `KbReferenceScanner`: candidate collection (every KB file with an
 *     access-frontmatter extension — `.md` and `.tool`, the resolver's own
 *     set), the advisory reference scan (cached — roster mutations must not
 *     rerun a full-KB read sweep, invalidated by file-changed events and a
 *     TTL backstop), and the fail-closed reference rewrite (returns each
 *     file's ORIGINAL text too, so rollback snapshots reuse the read the
 *     rewrite already did instead of a second full-KB pass).
 *
 * Tokens here are the ENTRY-GRAMMAR canonical tokens: a bare name (the role
 * when one exists, else the group) or an explicit `role/<name>` /
 * `group/<name>`. Callers translate: a ROLE's references are its bare token
 * plus its `role/` token; a GROUP's are its `group/` token, plus the bare
 * token while no role shares the name.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { Scalar, isAlias, isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { isFrontmatterFence, type IWorkspaceService } from '@bevel-software/platform-shared';
import type { ITreeWalker } from '../../shared/fs.contract.js';
import { logger } from '../../shared/logging.js';
import { printable, sanitizedPath } from '../../shared/printable.js';
import {
  AccessDeniedError,
  KNOWN_VERBS,
  accessMdDeclaresBodyRules,
  accessMdSelfEntries,
  canonicalRoleName,
  hasAccessFrontmatterExtension,
  isAccessMdPath,
  parseAccessEntry,
  parseAccessFile,
  parseOwnAccessEntries,
  stripComment,
} from '../access-model/index.js';
import type { ParsedEntry, Verb } from '../access-model/index.js';

const log = logger('access');

/**
 * Resolve the [start, end) line range that role rewrites may touch — the YAML
 * config region only, NEVER the markdown body (CodeRabbit: a body line like
 * `- Sales` or `owner: Sales` must not be rewritten).
 *
 *   - A file with leading `---` frontmatter (folder `access.md`, node `.md`):
 *     only the lines BETWEEN the opening and closing `---` are eligible.
 *   - A fence-less file (e.g. a bare `roles.yaml`-style access config with no
 *     `---`): the whole file is config, so all lines are eligible.
 *   - A `.md` file with no frontmatter fence: no config region → empty range,
 *     nothing is rewritten.
 */
function configLineRange(lines: string[], isMarkdown: boolean): { start: number; end: number } {
  if (lines.length > 0 && isFrontmatterFence(lines[0])) {
    for (let i = 1; i < lines.length; i++) {
      if (isFrontmatterFence(lines[i])) return { start: 1, end: i };
    }
    // Unterminated frontmatter — treat nothing as eligible (don't risk the body).
    return { start: 0, end: 0 };
  }
  // No fence: a markdown file has no config region; a non-markdown access file
  // (no body) is entirely config.
  return isMarkdown ? { start: 0, end: 0 } : { start: 0, end: lines.length };
}

/** The line range AFTER the closing frontmatter fence — empty when there is
 *  no fence or it never closes, mirroring `bodyAfterFrontmatter` (a
 *  fence-less access.md is a hard parse error to the resolver, so it is not
 *  a rule source and must not be rewritten). */
function bodyLineRange(lines: string[]): { start: number; end: number } {
  if (lines.length > 0 && isFrontmatterFence(lines[0])) {
    for (let i = 1; i < lines.length; i++) {
      if (isFrontmatterFence(lines[i])) return { start: i + 1, end: lines.length };
    }
  }
  return { start: 0, end: 0 };
}

/**
 * The line ranges that are RULE SOURCES for this file — the ranges the
 * resolver actually parses rules from, so the scan/rewrite can never miss a
 * rule the resolver enforces:
 *
 *   - A body-governed `access.md` (see {@link accessMdDeclaresBodyRules}):
 *     the BODY carries the folder's rules and the frontmatter carries the
 *     file's own rules — both are rule sources.
 *   - Everything else: the config region as before (frontmatter for markdown,
 *     the whole file for a fence-less config file). A legacy `access.md`'s
 *     body and a node file's body are prose and stay untouchable.
 */
function ruleLineRanges(
  text: string,
  lines: string[],
  isMarkdown: boolean,
  isAccessMd: boolean,
): { start: number; end: number }[] {
  if (isAccessMd && accessMdDeclaresBodyRules(text)) {
    return [configLineRange(lines, true), bodyLineRange(lines)];
  }
  return [configLineRange(lines, isMarkdown)];
}

/** The access verb keys the resolver reads (kept in lockstep via KNOWN_VERBS). */
const VERB_KEYS: ReadonlySet<string> = new Set<string>(KNOWN_VERBS);

/**
 * Walk the CONFIG-REGION lines of `text`, invoking `onRoleRef` for every line
 * that PARSES as a genuine role entry — both the block-list form (`- <token>`
 * under a ROOT-mapping `read:`/`write:`/… key) and the inline scalar form
 * (`owner: <token>`). `verb` is the access verb the reference sits under.
 * This is the SINGLE source of truth for "what is a role reference" — both
 * the delete-warning scan and the rename rewrite drive off it, so they cannot
 * disagree. The callback may mutate `lines[i]` (the rewrite does; the scan
 * does not). User entries, other keys, nested mappings' verb-looking keys,
 * comments and substrings never fire it.
 *
 * "Root" follows the resolver's OWN semantics, not column zero: the
 * YAML-subset parser's root frame sits at indent -1 (`parseYamlSubset`), so a
 * uniformly-INDENTED root mapping (`  read:` at column 2 with nothing
 * enclosing it) is a live rule mapping the resolver enforces — a column-zero
 * regex would silently skip it, and a rename would strand those grants. This
 * walker mirrors the parser's frame stack: a key whose enclosing frame is the
 * root is a root key; a verb key nested under some other mapping is not a
 * rule. On a STRUCTURAL error the resolver rejects the whole region (an
 * access.md hard-errors; node frontmatter yields no own-entries), so the walk
 * stops — nothing there is an enforced rule.
 *
 * Comments follow the resolver's tokeniser rule (`stripComment`): they are
 * invisible to MATCHING — a trailing `# note` never becomes part of the
 * token, and a full-line comment neither ends a block nor is an entry — but
 * the rewrite preserves them: `suffix` carries the stripped tail (trailing
 * whitespace + comment) verbatim for re-append.
 */
function walkRoleRefs(
  lines: string[],
  start: number,
  end: number,
  onRoleRef: (ctx: {
    i: number;
    verb: string;
    entry: { role: string; deny: boolean };
    indent: string;
    prefix: string;
    /** Trailing whitespace + `# comment` of the original line, preserved on rewrite. */
    suffix: string;
  }) => void,
): void {
  /** A role-entry value → its parsed role entry, else null (user/empty/other). */
  const roleEntry = (rawValue: string): { role: string; deny: boolean } | null => {
    const parsed = parseAccessEntry(rawValue);
    return parsed.ok && parsed.entry.kind === 'role'
      ? { role: parsed.entry.role, deny: parsed.entry.deny }
      : null;
  };
  // Mirror of the subset parser's frame stack. `pending` is a key whose value
  // is still unknown — the next token decides whether it opens a list (an
  // item deeper than the key), a nested mapping (a kv deeper than the key),
  // or nothing (a peer/outdented token pops it, i.e. the key was null).
  // `verb` is set only on a ROOT verb key's frame — its list items are the
  // entries the resolver reads for that verb.
  type Frame = { indent: number; kind: 'pending' | 'list' | 'map'; verb: string | null };
  const stack: Frame[] = [{ indent: -1, kind: 'map', verb: null }];
  for (let i = start; i < end; i++) {
    const raw = lines[i];
    // Match against the COMMENT-STRIPPED line — the resolver's tokeniser view.
    // `suffix` is everything stripping removed (trailing whitespace + comment),
    // kept so a rewrite can re-append it byte-for-byte.
    const line = stripComment(raw).replace(/\s+$/, '');
    const suffix = raw.slice(line.length);
    // A full-line comment (or blank line) is invisible: not an entry, and it
    // does NOT end the current block — the tokeniser skips it entirely.
    if (!line.trim()) continue;
    // Same indent rule as the tokeniser: leading SPACES only.
    const indent = /^( *)/.exec(line)![1].length;
    const content = line.slice(indent);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const top = stack[stack.length - 1];

    if (content === '-' || content.startsWith('- ')) {
      if (top.kind === 'pending') top.kind = 'list';
      // An item with no enclosing list is a structural error — the resolver
      // rejects the whole region, so nothing here is an enforced rule.
      if (top.kind !== 'list') return;
      if (top.verb !== null) {
        const rest = content.slice(2);
        const ws = /^\s*/.exec(rest)![0];
        const entry = roleEntry(rest.trim());
        if (entry) {
          onRoleRef({
            i,
            verb: top.verb,
            entry,
            indent: '',
            prefix: line.slice(0, indent + 2) + ws,
            suffix,
          });
        }
      }
      continue;
    }

    const colonIdx = content.indexOf(':');
    // Not a `key:` or `- value` line, or an empty key: a structural error the
    // resolver rejects — stop, this region enforces nothing.
    if (colonIdx < 0) return;
    const key = content.slice(0, colonIdx).trim();
    if (!key) return;
    if (top.kind === 'pending') {
      // The previous key's value turned out to be a nested MAPPING.
      top.kind = 'map';
      top.verb = null;
    }
    // A kv inside a list is a structural error (mapping key inside a list).
    if (top.kind !== 'map') return;
    // Root per the parser's frames — NOT "column zero".
    const verbKey = stack.length === 1 && VERB_KEYS.has(key) ? key : null;
    const value = content.slice(colonIdx + 1).trim();
    if (value !== '') {
      // Inline value — no frame opens. A scalar under a root verb key is the
      // inline scalar reference form (`owner: Sales`); `[]` is an empty list.
      if (verbKey && value !== '[]') {
        const afterColon = content.slice(colonIdx + 1);
        const ws = /^\s*/.exec(afterColon)![0];
        const entry = roleEntry(value);
        if (entry) {
          onRoleRef({
            i,
            verb: verbKey,
            entry,
            indent: line.slice(0, indent + colonIdx + 1) + ws,
            prefix: '',
            suffix,
          });
        }
      }
      continue;
    }
    // Empty value: what it opens (list/map/null) is decided by the next token.
    stack.push({ indent, kind: 'pending', verb: verbKey });
  }
}

/**
 * Every genuine role/group reference in `text`'s rule regions, as
 * {role, verb} where `role` is the canonical ENTRY TOKEN (bare name,
 * `role/<name>` or `group/<name>`). `isAccessMd` marks an `access.md` file, whose BODY is a
 * rule source in the body-governed format — see {@link ruleLineRanges}.
 */
export function findRoleRefsInText(
  text: string,
  isMarkdown = true,
  isAccessMd = false,
): { role: string; verb: string }[] {
  const lines = text.split('\n');
  const out: { role: string; verb: string }[] = [];
  for (const { start, end } of ruleLineRanges(text, lines, isMarkdown, isAccessMd)) {
    if (start >= end) continue;
    walkRoleRefs(lines, start, end, ({ verb, entry }) => out.push({ role: entry.role, verb }));
  }
  return out;
}

/**
 * Rewrite every RULE-REGION line that PARSES as a role reference whose
 * canonical token == `oldToken`, replacing the token with `newDisplayName`
 * (preserving any leading `deny ` and indentation). A prose body is never
 * touched — a line like `- Sales` in a node file or a legacy `access.md`
 * stays byte-for-byte intact; the body is eligible ONLY when the file is a
 * body-governed `access.md` (`isAccessMd` + the body parses as rules), where
 * the body IS what the resolver enforces — see {@link ruleLineRanges}. Lines
 * that don't parse as a matching role entry (user entries, other keys,
 * substrings) are also untouched. Exported for test.
 *
 * `isMarkdown` (default true) marks files that carry a markdown body below the
 * frontmatter; pass false only for a pure-config file with no body.
 */
export function rewriteRoleTokensInText(
  text: string,
  oldToken: string,
  newDisplayName: string,
  isMarkdown = true,
  isAccessMd = false,
): string {
  const lines = text.split('\n');
  let changed = false;
  for (const { start, end } of ruleLineRanges(text, lines, isMarkdown, isAccessMd)) {
    if (start >= end) continue;
    walkRoleRefs(lines, start, end, ({ i, entry, indent, prefix, suffix }) => {
      if (entry.role !== oldToken) return;
      // `suffix` re-appends the trailing whitespace + `# comment` the match
      // ignored — a rename must not eat an entry's comment.
      lines[i] = `${indent}${prefix}${entry.deny ? 'deny ' : ''}${newDisplayName}${suffix}`;
      changed = true;
    });
  }
  return changed ? lines.join('\n') : text;
}

/**
 * The structural rewrite, for the references the line walk cannot edit:
 * a file's OWN frontmatter is read by the full YAML parser whenever it holds
 * flow sequences, quoted scalars or other real YAML (`ownEntriesRoot` in the
 * grammar), and the line walk only knows block lists and `key: value`. So
 * this edits the same document the resolver reads — the frontmatter's
 * top-level verb keys, by the full parser's own node tree with the same
 * FAILSAFE schema — and replaces each scalar entry whose token is in
 * `oldTokens`, keeping its quoting, its comments and every other node. An
 * alias under a verb key is replaced by a plain scalar, so the anchor it
 * points at (which may sit under any other key) is left alone.
 *
 * The other rule sources — a legacy `access.md`'s frontmatter and a
 * body-governed one's body — are read by the YAML-subset parser only, which
 * the line walk mirrors, so they never need this.
 */
function rewriteOwnFrontmatterStructurally(
  text: string,
  oldTokens: ReadonlySet<string>,
  newDisplayName: string,
): string {
  const lines = text.split('\n');
  const { start, end } = configLineRange(lines, true);
  if (start >= end) return text;
  // Typed as an editable document: the rewrite puts new, unparsed scalars in it.
  const doc: Document = parseDocument(lines.slice(start, end).join('\n'), { schema: 'failsafe' });
  // A document the full parser rejects is not what the resolver read: it fell
  // back to the subset parser, whose reading the line walk already covers.
  if (doc.errors.length > 0 || !isMap(doc.contents)) return text;
  let changed = false;
  const rewritten = (node: unknown): Scalar | null => {
    const target = isAlias(node) ? node.resolve(doc) : node;
    if (!isScalar(target) || typeof target.value !== 'string') return null;
    const parsed = parseAccessEntry(target.value);
    if (!parsed.ok || parsed.entry.kind !== 'role' || !oldTokens.has(parsed.entry.role)) return null;
    const value = `${parsed.entry.deny ? 'deny ' : ''}${newDisplayName}`;
    changed = true;
    if (isAlias(node)) return new Scalar(value);
    target.value = value;
    return target;
  };
  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    if (typeof key !== 'string' || !VERB_KEYS.has(key)) continue;
    if (isSeq(pair.value)) {
      pair.value.items = pair.value.items.map((item) => rewritten(item) ?? item);
    } else {
      const scalar = rewritten(pair.value);
      if (scalar) pair.value = scalar;
    }
  }
  if (!changed) return text;
  // Never fold a long value onto a second line, nor pad a flow list.
  const frontmatter = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n$/, '');
  return [...lines.slice(0, start), frontmatter, ...lines.slice(end)].join('\n');
}

/**
 * The principal references the RESOLVER reads from one candidate file, by
 * the resolver's own parsers: an `access.md`'s folder rules
 * (`parseAccessFile`) and its self-rules (`accessMdSelfEntries`), any other
 * file's own frontmatter (`parseOwnAccessEntries`). Those parsers read
 * quoted scalars and flow sequences (`read: ["Admin"]`) the line walker
 * above does not, so the reports built on this name every rule that is
 * actually enforced — and nothing the resolver ignores (a broken
 * `access.md` is dropped from the model, so it references nothing).
 */
export function resolverRoleRefs(text: string, repoRel: string): { role: string; verb: string }[] {
  const out: { role: string; verb: string }[] = [];
  const add = (entries: Record<Verb, ParsedEntry[]> | null): void => {
    if (!entries) return;
    for (const verb of KNOWN_VERBS) {
      for (const e of entries[verb]) if (e.kind === 'role') out.push({ role: e.role, verb });
    }
  };
  if (isAccessMdPath(repoRel)) {
    const folder = parseAccessFile(text, repoRel);
    if (folder.ok) add(folder.file.entries);
    add(accessMdSelfEntries(text));
  } else {
    add(parseOwnAccessEntries(text));
  }
  return out;
}

export interface ReferenceHit {
  path: string;
  verb: string;
}

/** One rewritten file: the new content plus the ORIGINAL text the rewrite
 *  read (rollback snapshots reuse it — no second full-KB read). */
export interface ReferenceRewrite {
  repoRelativePath: string;
  content: string;
  original: string;
}

/**
 * Which of the given repo-relative paths the person a refusal is for may
 * read — `canReadBatch` bound to that person. A path is itself a disclosure,
 * so a refusal names only these and says nothing of the rest.
 */
export type PathVisibility = (repoRelPaths: string[]) => Promise<ReadonlyMap<string, boolean>>;

/**
 * The one refusal for a rename blocked by a place the renaming person may
 * not be shown — a folder the walk cannot list, a file it cannot read, or a
 * file the person may not read that still names the old principal after the
 * rewrite (a backstop: every form the resolver reads is rewritten). The same
 * words whatever the cause: no path, no count, no hint of a reference, since
 * Admin status does not grant read and each of those is a disclosure. The
 * log names the place.
 */
export const UNSHOWN_REFERENCE_REFUSAL =
  'This rename rewrites access rules across the knowledge base, and part of the knowledge base could not be rewritten, so it may still reference the old principal; rename aborted with no changes. The server log names where.';

/**
 * The commit's own write gate refusing a rename's rewrite, translated for the
 * person who asked. The gate judges every file the rewrite touches against the
 * actor's WRITE rules (a rename's references reach files private to others,
 * which an Admin may be unable to write), and its refusal names the file. A
 * file its person may read keeps that refusal: the path and its eligible
 * writers say whom to ask. A file they may not read gets
 * `UNSHOWN_REFERENCE_REFUSAL` instead, so the hidden path stays unnamed; the
 * log names it. Anything else comes back unchanged.
 *
 * The one bit left (some file the person cannot see names the old principal)
 * is the hidden-blocker exception of "A Guard's Answer Is a Disclosure": an
 * Admin's refused rename of a principal they manage says only that an unshown
 * place blocks it.
 */
export async function translateRewriteWriteRefusal(
  err: unknown,
  visible: PathVisibility,
  makeError: (message: string) => Error,
): Promise<unknown> {
  if (!(err instanceof AccessDeniedError)) return err;
  const p = err.access.path;
  let shown = false;
  try {
    shown = (await visible([p])).get(p) === true;
  } catch {
    // Cannot tell whether the person may see it: say nothing of it.
  }
  if (shown) return err;
  log.warn(`reference rewrite: the acting person may not write ${printable(p)}`);
  const translated = makeError(UNSHOWN_REFERENCE_REFUSAL);
  // withFileLocks reads the paths whose restore failed off the error it
  // catches, to discard their partial bytes; the translation must carry them.
  const unrestored = (err as { unrestoredPaths?: Set<string> }).unrestoredPaths;
  if (unrestored) (translated as { unrestoredPaths?: Set<string> }).unrestoredPaths = unrestored;
  return translated;
}

/**
 * The rows of `refs` whose file `readable` allows. The rest are dropped
 * outright, not counted: Admin status does not grant read, so even a count of
 * rules in content the viewer cannot read is a disclosure.
 */
export function readableReferences(
  refs: readonly ReferenceHit[],
  readable: ReadonlyMap<string, boolean>,
): ReferenceHit[] {
  return refs.filter((r) => readable.get(r.path) === true);
}

/** How long a cached reference scan may serve after its load. Backstop only —
 *  reference-changing writes invalidate explicitly (the admin services after
 *  their own rewrites, and the event-bus tap below for everyone else's). */
const SCAN_TTL_MS = 30_000;

/**
 * The slice of the workflow event bus the scanner taps for cache
 * invalidation. Structural (not the concrete class) so test doubles and the
 * services' optional bus stay compatible.
 */
export interface ReferenceScanInvalidationBus {
  /** Optional so record-only test doubles (emit-only stubs) stay valid. */
  onEmit?(listener: (event: { kind: string; workspaceId?: string; path?: string }) => void): () => void;
}

/**
 * Candidate collection + cached scan + fail-closed rewrite over one KB.
 * Constructed per admin service; the cache means roster MUTATIONS never rerun
 * the full-KB reference sweep (only the roster GET pays it, at most once per
 * TTL), and `invalidate` drops it whenever a write could have moved
 * references (rename/delete rewrites, or any external change signal).
 *
 * FRESHNESS: an `access.md` grant/revoke (or any other write to a scanned
 * file) lands OUTSIDE the admin services, so their explicit invalidations
 * can't see it — the roster's `referencedBy` would serve up to `SCAN_TTL_MS`
 * of staleness. When an `eventBus` is provided, the scanner taps its emits
 * and drops the workspace's cache on every path-carrying event
 * (`file-changed` from the commit pipeline, and `lock-released` — which the
 * share routes emit synchronously at write time, before the async commit's
 * `file-changed` lands) whose path has a scanned extension. The TTL stays as
 * the backstop for deployments/tests without a bus.
 */
export class KbReferenceScanner {
  private readonly cache = new Map<
    string,
    { loadedAt: number; byToken: Map<string, ReferenceHit[]> }
  >();
  /**
   * Per-workspace in-flight scan state: a scan may only CACHE its result if
   * no invalidation landed after it started — otherwise the pre-change
   * snapshot would repopulate the cache and stick for a whole TTL. Tracked
   * ONLY while scans run (a future scan reads post-write state by nature, so
   * an invalidation with nothing in flight needs only the cache drop): the
   * entry is created by the first concurrent scan and removed by the last,
   * so the map never accumulates workspaces.
   */
  private readonly inFlight = new Map<string, { gen: number; scans: number }>();

  constructor(
    private readonly workspaceService: IWorkspaceService,
    /** The resolver's walk (see `collectCandidateFiles`), injected by the composition root. */
    private readonly disk: ITreeWalker,
    private readonly kbDirName: string,
    eventBus?: ReferenceScanInvalidationBus,
  ) {
    eventBus?.onEmit?.((event) => {
      if (event.kind !== 'file-changed' && event.kind !== 'lock-released') return;
      if (!event.workspaceId || !event.path) return;
      // Paths on the bus are workspace-relative; only writes UNDER the KB dir
      // to files the scan reads can move references — a `.md` elsewhere in
      // the workspace is not scan material.
      if (!event.path.startsWith(`${this.kbDirName}/`)) return;
      if (!hasAccessFrontmatterExtension(event.path)) return;
      this.invalidate(event.workspaceId);
    });
  }

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
    const flight = this.inFlight.get(workspaceId);
    if (flight) flight.gen++;
  }

  /**
   * Repo-relative paths of every file that could carry a principal reference:
   * all `access.md` files plus every node file whose own frontmatter the
   * resolver reads access verbs from — the shared
   * `ACCESS_FRONTMATTER_EXTENSIONS` set (`.md` AND `.tool`; a rename that
   * skipped `.tool` would strand a live frontmatter grant there). Sourced
   * from the RESOLVER'S OWN walk (`walkKb`: dot-entries and vendored
   * dependencies skipped, `.bevelignore` NOT honoured) — the resolver
   * enforces an `access.md` the explorer hides, so a scan that honoured the
   * ignore file would leave its rules out of the roster's reports and a
   * rename would strand them. Paths are relative to the KB dir. (`roles.yaml`
   * matches no scanned extension, so it's excluded; callers commit it
   * separately.)
   *
   * `holes` names every folder the walk could not list: the candidate set
   * is INCOMPLETE when it is non-empty, and each caller decides what that
   * means — the rewrite refuses, the advisory scan says so and does not cache.
   */
  async collectCandidateFiles(workspaceId: string): Promise<{ files: string[]; holes: string[] }> {
    const out: string[] = [];
    const { holes } = await this.disk.walkKb(await this.repoDir(workspaceId), [
      {
        onFile(dir, name) {
          const rel = dir ? `${dir}/${name}` : name;
          if (hasAccessFrontmatterExtension(rel)) out.push(rel);
        },
      },
    ]);
    return { files: out, holes };
  }

  /**
   * Sound scan of EVERY candidate file (folder `access.md` + `.md`/`.tool`
   * node frontmatter) for genuine principal references, indexed by canonical
   * entry TOKEN, read by the resolver's own parse ({@link resolverRoleRefs}).
   * Shares the candidate set with the rename rewrite, and the rewrite checks
   * its result against the same parse, so the delete warning and the rewrite
   * cannot disagree on what references a principal. A file we cannot
   * read is skipped (this is an advisory read, not the atomic write path),
   * and the scan that skipped it is not cached.
   * Cached per workspace (see class doc); reads are batched with Promise.all
   * rather than serial per-file awaits.
   */
  async scan(workspaceId: string): Promise<Map<string, ReferenceHit[]>> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.loadedAt < SCAN_TTL_MS) return hit.byToken;

    let flight = this.inFlight.get(workspaceId);
    if (!flight) {
      flight = { gen: 0, scans: 0 };
      this.inFlight.set(workspaceId, flight);
    }
    flight.scans++;
    const startedUnder = flight.gen;
    try {
      const repoDir = await this.repoDir(workspaceId);
      const { files: candidates, holes } = await this.collectCandidateFiles(workspaceId);
      if (holes.length > 0) {
        log.warn(
          `reference scan: cannot list ${holes.map((h) => printable(h || '.')).join(', ')} — references there are not reported`,
        );
      }
      const texts = await Promise.all(
        candidates.map(async (repoRel) => {
          try {
            return await fs.readFile(path.join(repoDir, repoRel), 'utf-8');
          } catch {
            return null;
          }
        }),
      );
      const byToken = new Map<string, ReferenceHit[]>();
      candidates.forEach((repoRel, i) => {
        const text = texts[i];
        if (text === null) return;
        for (const ref of resolverRoleRefs(text, repoRel)) {
          const list = byToken.get(ref.role);
          if (list) list.push({ path: repoRel, verb: ref.verb });
          else byToken.set(ref.role, [{ path: repoRel, verb: ref.verb }]);
        }
      });
      // Cache only when no invalidation landed mid-scan; the caller still gets
      // this snapshot (at worst one write stale — same as the pre-scan world),
      // but a stale snapshot must never STICK for a TTL. The next call re-scans.
      // An incomplete scan (a folder could not be listed, or a candidate file
      // could not be read) is never cached either: the next call retries it.
      const unread = texts.some((t) => t === null);
      if (flight.gen === startedUnder && holes.length === 0 && !unread) {
        this.cache.set(workspaceId, { loadedAt: Date.now(), byToken });
      }
      return byToken;
    } finally {
      flight.scans--;
      if (flight.scans === 0) this.inFlight.delete(workspaceId);
    }
  }

  /**
   * Find every genuine reference to `oldToken` (or any of several spellings
   * of one principal) and rewrite it to `newDisplayName`. FAIL-CLOSED: a candidate we cannot read might reference
   * the old token, and skipping it would commit a partial rewrite (a
   * half-renamed principal still pointed at by stragglers = silent access
   * drop) — so any read failure aborts via `makeError` with nothing written.
   * Returns the writes WITH each file's original text (rollback snapshots).
   *
   * The rename keeps the KB's references to a principal whole, so it rewrites
   * every candidate, files its person may not read included: a file private
   * to others blocks nothing here, and no answer of this method depends on
   * what such a file holds. Whether the person may WRITE each rewritten file
   * is the commit's gate to decide, not this method's (see
   * `translateRewriteWriteRefusal`). Every form the resolver reads
   * is rewritten — block lists and `key: value` by the line walk, quoted and
   * flow-YAML own frontmatter by the structural rewrite — so there is no
   * "cannot rewrite" answer for hidden content to give. The writes reach a
   * caller only through surfaces gated on read (the roster, the event
   * delivery), never through this method's answer.
   *
   * A reference the resolver still sees after both rewrites is refused: named
   * with how to fix it when `visible` says its person may read the file, with
   * `UNSHOWN_REFERENCE_REFUSAL` otherwise (no path, no count). Nothing the
   * resolver reads should reach that, so the refusal is a backstop, not an
   * answer the content of a hidden file can choose.
   */
  async rewriteReferences(
    workspaceId: string,
    oldToken: string | readonly string[],
    newDisplayName: string,
    makeError: (message: string, cause?: string) => Error,
    visible: PathVisibility,
  ): Promise<ReferenceRewrite[]> {
    const oldTokens = typeof oldToken === 'string' ? [oldToken] : oldToken;
    const repoDir = await this.repoDir(workspaceId);
    const writes: ReferenceRewrite[] = [];
    const { files: candidates, holes } = await this.collectCandidateFiles(workspaceId);
    // A folder we cannot list might hold references to the old token — same
    // fail-closed rule as an unreadable file below, and never named nor
    // counted, for the same reason: its own access.md may be just as
    // unreadable, so `visible` could not see the rules that close it.
    if (holes.length > 0) {
      log.warn(`reference rewrite: cannot list ${holes.map((h) => printable(h || '.')).join(', ')}`);
      throw makeError(UNSHOWN_REFERENCE_REFUSAL);
    }
    const texts = await Promise.all(
      candidates.map(async (repoRel) => {
        try {
          return { ok: true as const, text: await fs.readFile(path.join(repoDir, repoRel), 'utf-8') };
        } catch (err) {
          return { ok: false as const, repoRel, cause: (err as Error)?.message };
        }
      }),
    );
    for (const t of texts) {
      if (!t.ok) {
        // Never named, not even to a reader: `visible` decides from the
        // file's own rules, and a file we cannot read has none it can see —
        // an inherited grant would then disclose a path its own rules may
        // close. The fs cause carries the path too, so it stays in the log.
        log.warn(`reference rewrite: cannot read ${printable(t.repoRel)}`, { cause: t.cause });
        throw makeError(UNSHOWN_REFERENCE_REFUSAL);
      }
    }
    // Old tokens the rename must leave no reference to (the new name's own
    // token is exempt: it IS the rewrite's result).
    const newToken = canonicalRoleName(newDisplayName);
    const gone = new Set(oldTokens.filter((t) => t !== newToken));
    const stranded: string[] = [];
    candidates.forEach((repoRel, i) => {
      const entry = texts[i];
      if (!entry.ok) return; // unreachable — the loop above threw
      let rewritten = entry.text;
      for (const token of oldTokens) {
        rewritten = rewriteRoleTokensInText(rewritten, token, newDisplayName, true, isAccessMdPath(repoRel));
      }
      // The line rewrite edits block-list and `key: value` entries; the
      // resolver also reads quoted and flow-YAML own frontmatter, which the
      // structural rewrite edits by the full parser's own tree.
      const stillNamed = (t: string) => resolverRoleRefs(t, repoRel).some((r) => gone.has(r.role));
      if (stillNamed(rewritten)) {
        rewritten = rewriteOwnFrontmatterStructurally(rewritten, new Set(oldTokens), newDisplayName);
      }
      // A reference the resolver still sees would be stranded by the rename.
      if (stillNamed(rewritten)) {
        stranded.push(repoRel);
        return;
      }
      if (rewritten !== entry.text) {
        writes.push({ repoRelativePath: repoRel, content: rewritten, original: entry.text });
      }
    });
    if (stranded.length > 0) {
      const verdicts = await visible(stranded);
      const shown = stranded.filter((p) => verdicts.get(p) === true);
      if (shown.length < stranded.length) {
        log.warn(
          `reference rewrite: cannot rewrite ${stranded.map((p) => printable(p || '.')).join(', ')}`,
        );
        throw makeError(UNSHOWN_REFERENCE_REFUSAL);
      }
      throw makeError(
        `${shown.map((p) => sanitizedPath(p || '.')).join(', ')} name the old principal in a form the rename cannot rewrite; rewrite it as a \`- Name\` list item, then rename again. Rename aborted with no changes`,
      );
    }
    return writes;
  }

  private async repoDir(workspaceId: string): Promise<string> {
    const wsDir = await this.workspaceService.getWorkspacePath(workspaceId);
    return path.join(wsDir, this.kbDirName);
  }
}

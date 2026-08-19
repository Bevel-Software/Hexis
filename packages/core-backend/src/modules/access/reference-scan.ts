/**
 * SHARED grant-reference machinery — the single implementation both admin
 * services (roles + groups) drive for "which access rules name this
 * principal" and "rewrite every reference atomically":
 *
 *   - `findRoleRefsInText` / `rewriteRoleTokensInText`: the config-region
 *     parse that decides what IS a principal reference. One source of truth,
 *     so the delete/rename warning and the rename rewrite can never disagree.
 *   - `KbReferenceScanner`: candidate collection (every KB file with an
 *     access-frontmatter extension — `.md` and `.tool`, the resolver's own
 *     set), the advisory reference scan (cached — roster mutations must not
 *     rerun a full-KB read sweep, invalidated by file-changed events and a
 *     TTL backstop), and the fail-closed reference rewrite (returns each
 *     file's ORIGINAL text too, so rollback snapshots reuse the read the
 *     rewrite already did instead of a second full-KB pass).
 *
 * Tokens here are the ENTRY-GRAMMAR canonical tokens: a bare name (group
 * first, then role) or an explicit `role/<name>`. Callers translate: a ROLE's
 * references are its bare token plus its `role/` token; a GROUP's are its
 * bare token only.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import type { FileTreeEntry, IWorkspaceService } from '@bevel-software/platform-shared';
import {
  accessMdDeclaresBodyRules,
  hasAccessFrontmatterExtension,
  isAccessMdPath,
  parseAccessEntry,
  stripComment,
} from '../access-model/access-grammar.js';

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
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') return { start: 1, end: i };
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
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') return { start: i + 1, end: lines.length };
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

/** A known access verb key AT THE RULE MAPPING'S ROOT (indent 0 — the only
 *  level the resolver parses verbs from; see `parseAccessFile` /
 *  `parseOwnAccessEntries`, which read `Object.entries(root)`, and the splice
 *  writer's `findVerbBlock`, which requires `indent === 0` for the key). An
 *  INDENTED `read:` inside some nested config mapping is NOT an access rule
 *  and must never be scanned or rewritten. */
const VERB_KEY_RE = /^(read|write|download|owner)(:\s*)(.*)$/;
/** A block-list item: `  - <token>` (token may carry a leading `deny `). */
const LIST_ITEM_RE = /^(\s*-\s+)(.*)$/;

/**
 * Walk the CONFIG-REGION lines of `text`, invoking `onRoleRef` for every line
 * that PARSES as a genuine role entry — both the block-list form (`- <token>`
 * under a root-level `read:`/`write:`/… key) and the inline scalar form
 * (`owner: <token>`). `verb` is the access verb the reference sits under; for
 * a block list it is the nearest enclosing verb key (lines before any verb
 * key, or under an unknown key, are skipped). This is the SINGLE source of
 * truth for "what is a role reference" — both the delete-warning scan and the
 * rename rewrite drive off it, so they cannot disagree. The callback may
 * mutate `lines[i]` (the rewrite does; the scan does not). User entries,
 * other keys, nested mappings' verb-looking keys, comments and substrings
 * never fire it.
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
  let currentVerb: string | null = null;
  /** A role-entry value → its parsed role entry, else null (user/empty/other). */
  const roleEntry = (rawValue: string): { role: string; deny: boolean } | null => {
    const parsed = parseAccessEntry(rawValue);
    return parsed.ok && parsed.entry.kind === 'role'
      ? { role: parsed.entry.role, deny: parsed.entry.deny }
      : null;
  };
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
    // A verb key at the rule mapping's root resets the block context. Its
    // inline value (scalar form, `owner: Sales`) is itself a candidate
    // reference under that same verb.
    const kvM = line.match(VERB_KEY_RE);
    if (kvM) {
      currentVerb = kvM[1];
      const inlineValue = kvM[3];
      if (inlineValue.trim() !== '') {
        const entry = roleEntry(inlineValue);
        if (entry) onRoleRef({ i, verb: currentVerb, entry, indent: `${kvM[1]}${kvM[2]}`, prefix: '', suffix });
      }
      continue;
    }
    // Block-list item — belongs to the nearest enclosing verb key. A list item
    // with no verb in scope is not a resolvable access rule; skip it.
    const listM = line.match(LIST_ITEM_RE);
    if (listM && currentVerb !== null) {
      const entry = roleEntry(listM[2]);
      if (entry) onRoleRef({ i, verb: currentVerb, entry, indent: '', prefix: listM[1], suffix });
      continue;
    }
    // Any other non-empty line ends the current block: a non-verb key, an
    // INDENTED verb-looking key (a nested mapping's — not a rule the resolver
    // parses), or stray prose in config.
    if (!listM) currentVerb = null;
  }
}

/**
 * Every genuine role/group reference in `text`'s rule regions, as
 * {role, verb} where `role` is the canonical ENTRY TOKEN (bare name or
 * `role/<name>`). `isAccessMd` marks an `access.md` file, whose BODY is a
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
   * from the workspace file tree (which already skips `.git` and honours
   * `.bevelignore`), filtered under the KB dir and returned bare
   * repo-relative. (`roles.yaml` matches no scanned extension, so it's
   * excluded; callers commit it separately.) Under save=share the working
   * tree matches the committed set, so this is the same candidate list
   * git-tracking would give.
   */
  async collectCandidateFiles(workspaceId: string): Promise<string[]> {
    const tree = await this.workspaceService.listFiles(workspaceId);
    const prefix = `${this.kbDirName}/`;
    const out: string[] = [];
    const visit = (node: FileTreeEntry): void => {
      if (node.type === 'file') {
        if (node.relativePath.startsWith(prefix) && hasAccessFrontmatterExtension(node.relativePath)) {
          out.push(node.relativePath.slice(prefix.length));
        }
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    return out;
  }

  /**
   * Sound scan of EVERY candidate file (folder `access.md` + `.md`/`.tool`
   * node frontmatter) for genuine principal references, indexed by canonical
   * entry TOKEN. Shares the
   * candidate set and the config-region parse with the rename rewrite, so the
   * delete warning and the rewrite see the SAME references. A file we cannot
   * read is skipped (this is an advisory read, not the atomic write path).
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
      const candidates = await this.collectCandidateFiles(workspaceId);
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
        for (const ref of findRoleRefsInText(text, true, isAccessMdPath(repoRel))) {
          const list = byToken.get(ref.role);
          if (list) list.push({ path: repoRel, verb: ref.verb });
          else byToken.set(ref.role, [{ path: repoRel, verb: ref.verb }]);
        }
      });
      // Cache only when no invalidation landed mid-scan; the caller still gets
      // this snapshot (at worst one write stale — same as the pre-scan world),
      // but a stale snapshot must never STICK for a TTL. The next call re-scans.
      if (flight.gen === startedUnder) {
        this.cache.set(workspaceId, { loadedAt: Date.now(), byToken });
      }
      return byToken;
    } finally {
      flight.scans--;
      if (flight.scans === 0) this.inFlight.delete(workspaceId);
    }
  }

  /**
   * Find every genuine reference to `oldToken` and rewrite it to
   * `newDisplayName`. FAIL-CLOSED: a candidate we cannot read might reference
   * the old token, and skipping it would commit a partial rewrite (a
   * half-renamed principal still pointed at by stragglers = silent access
   * drop) — so any read failure aborts via `makeError` with nothing written.
   * Returns the writes WITH each file's original text (rollback snapshots).
   */
  async rewriteReferences(
    workspaceId: string,
    oldToken: string,
    newDisplayName: string,
    makeError: (message: string, cause?: string) => Error,
  ): Promise<ReferenceRewrite[]> {
    const repoDir = await this.repoDir(workspaceId);
    const writes: ReferenceRewrite[] = [];
    const candidates = await this.collectCandidateFiles(workspaceId);
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
        throw makeError(
          `Cannot read ${t.repoRel} while rewriting references; rename aborted with no changes`,
          t.cause,
        );
      }
    }
    candidates.forEach((repoRel, i) => {
      const entry = texts[i];
      if (!entry.ok) return; // unreachable — the loop above threw
      const rewritten = rewriteRoleTokensInText(entry.text, oldToken, newDisplayName, true, isAccessMdPath(repoRel));
      if (rewritten !== entry.text) {
        writes.push({ repoRelativePath: repoRel, content: rewritten, original: entry.text });
      }
    });
    return writes;
  }

  private async repoDir(workspaceId: string): Promise<string> {
    const wsDir = await this.workspaceService.getWorkspacePath(workspaceId);
    return path.join(wsDir, this.kbDirName);
  }
}

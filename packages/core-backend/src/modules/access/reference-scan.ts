/**
 * SHARED grant-reference machinery — the single implementation both admin
 * services (roles + groups) drive for "which access rules name this
 * principal" and "rewrite every reference atomically":
 *
 *   - `findRoleRefsInText` / `rewriteRoleTokensInText`: the config-region
 *     parse that decides what IS a principal reference. One source of truth,
 *     so the delete/rename warning and the rename rewrite can never disagree.
 *   - `KbReferenceScanner`: candidate collection (every KB `.md`), the
 *     advisory reference scan (cached — roster mutations must not rerun a
 *     full-KB read sweep), and the fail-closed reference rewrite (returns
 *     each file's ORIGINAL text too, so rollback snapshots reuse the read the
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
import { accessMdDeclaresBodyRules, isAccessMdPath, parseAccessEntry } from './access-control.service.js';

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

/** A known access verb key: heads a block list or holds a scalar role value. */
const VERB_KEY_RE = /^(\s*)(read|write|download|owner)(:\s*)(.*)$/;
/** A block-list item: `  - <token>` (token may carry a leading `deny `). */
const LIST_ITEM_RE = /^(\s*-\s+)(.*)$/;

/**
 * Walk the CONFIG-REGION lines of `text`, invoking `onRoleRef` for every line
 * that PARSES as a genuine role entry — both the block-list form (`- <token>`
 * under a `read:`/`write:`/… key) and the inline scalar form (`owner: <token>`).
 * `verb` is the access verb the reference sits under; for a block list it is the
 * nearest enclosing verb key (lines before any verb key, or under an unknown
 * key, are skipped). This is the SINGLE source of truth for "what is a role
 * reference" — both the delete-warning scan and the rename rewrite drive off it,
 * so they cannot disagree. The callback may mutate `lines[i]` (the rewrite does;
 * the scan does not). User entries, other keys, comments and substrings never
 * fire it.
 */
function walkRoleRefs(
  lines: string[],
  start: number,
  end: number,
  onRoleRef: (ctx: { i: number; verb: string; entry: { role: string; deny: boolean }; indent: string; prefix: string }) => void,
): void {
  let currentVerb: string | null = null;
  /** A role-entry value → its parsed role entry, else null (user/empty/other). */
  const roleEntry = (rawValue: string): { role: string; deny: boolean } | null => {
    const parsed = parseAccessEntry(rawValue.replace(/\s+$/, ''));
    return parsed.ok && parsed.entry.kind === 'role'
      ? { role: parsed.entry.role, deny: parsed.entry.deny }
      : null;
  };
  for (let i = start; i < end; i++) {
    const line = lines[i];
    // A verb key resets the block context. Its inline value (scalar form,
    // `owner: Sales`) is itself a candidate reference under that same verb.
    const kvM = line.match(VERB_KEY_RE);
    if (kvM) {
      currentVerb = kvM[2];
      const inlineValue = kvM[4];
      if (inlineValue.trim() !== '') {
        const entry = roleEntry(inlineValue);
        if (entry) onRoleRef({ i, verb: currentVerb, entry, indent: `${kvM[1]}${kvM[2]}${kvM[3]}`, prefix: '' });
      }
      continue;
    }
    // Block-list item — belongs to the nearest enclosing verb key. A list item
    // with no verb in scope is not a resolvable access rule; skip it.
    const listM = line.match(LIST_ITEM_RE);
    if (listM && currentVerb !== null) {
      const entry = roleEntry(listM[2]);
      if (entry) onRoleRef({ i, verb: currentVerb, entry, indent: '', prefix: listM[1] });
      continue;
    }
    // A non-empty, non-list, non-kv line ends the current block (e.g. a new
    // top-level key whose value isn't a verb, or stray prose in config).
    if (line.trim() !== '' && !listM) currentVerb = null;
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
    walkRoleRefs(lines, start, end, ({ i, entry, indent, prefix }) => {
      if (entry.role !== oldToken) return;
      lines[i] = `${indent}${prefix}${entry.deny ? 'deny ' : ''}${newDisplayName}`;
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
 *  reference-changing writes call `invalidate` explicitly. */
const SCAN_TTL_MS = 30_000;

/**
 * Candidate collection + cached scan + fail-closed rewrite over one KB.
 * Constructed per admin service; the cache means roster MUTATIONS never rerun
 * the full-KB reference sweep (only the roster GET pays it, at most once per
 * TTL), and `invalidate` drops it whenever a write could have moved
 * references (rename/delete rewrites, or any external change signal).
 */
export class KbReferenceScanner {
  private readonly cache = new Map<
    string,
    { loadedAt: number; byToken: Map<string, ReferenceHit[]> }
  >();

  constructor(
    private readonly workspaceService: IWorkspaceService,
    private readonly kbDirName: string,
  ) {}

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  /**
   * Repo-relative paths of every file that could carry a principal reference:
   * all `access.md` files plus every `.md` node (its own frontmatter). Sourced
   * from the workspace file tree (which already skips `.git` and honours
   * `.bevelignore`), filtered to `.md` under the KB dir and returned bare
   * repo-relative. (`roles.yaml` isn't `.md`, so it's excluded; callers commit
   * it separately.) Under save=share the working tree matches the committed
   * set, so this is the same candidate list git-tracking would give.
   */
  async collectCandidateFiles(workspaceId: string): Promise<string[]> {
    const tree = await this.workspaceService.listFiles(workspaceId);
    const prefix = `${this.kbDirName}/`;
    const out: string[] = [];
    const visit = (node: FileTreeEntry): void => {
      if (node.type === 'file') {
        if (node.relativePath.startsWith(prefix) && node.relativePath.endsWith('.md')) {
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
   * Sound scan of EVERY `.md` (folder `access.md` + node frontmatter) for
   * genuine principal references, indexed by canonical entry TOKEN. Shares the
   * candidate set and the config-region parse with the rename rewrite, so the
   * delete warning and the rewrite see the SAME references. A file we cannot
   * read is skipped (this is an advisory read, not the atomic write path).
   * Cached per workspace (see class doc); reads are batched with Promise.all
   * rather than serial per-file awaits.
   */
  async scan(workspaceId: string): Promise<Map<string, ReferenceHit[]>> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.loadedAt < SCAN_TTL_MS) return hit.byToken;

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
    this.cache.set(workspaceId, { loadedAt: Date.now(), byToken });
    return byToken;
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

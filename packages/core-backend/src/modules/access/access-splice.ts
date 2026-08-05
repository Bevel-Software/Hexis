/**
 * Surgical text-splice editor for `access.md` frontmatter and node-frontmatter
 * access verbs.
 *
 * WHY a splice and not parse→model→emit: the resolver's parser
 * (`parseYamlSubset` / `extractFrontmatter` / `stripComment`) deliberately
 * throws away comments, blank lines, key order, AND the markdown body below the
 * closing `---`. Re-serialising from the parsed model would silently DELETE the
 * prose bodies the real `access.md` files carry (the repo-root one is a whole
 * README) — and a `parse(emit(x))` round-trip test would PASS anyway because
 * parse ignores the body. So every mutation here edits the RAW text: we locate
 * the verb's block, splice exactly one list line in or out, and leave every
 * other byte — comments, ordering, blank lines, the body — untouched.
 *
 *   ---
 *   write:                 (verb key line, indent 0)
 *     - Admin              (list item, indent 2)  <- splice point
 *     - Felix <f@x.eu>     (list item)
 *   # a comment            (preserved verbatim)
 *   owner: []              (inline-empty list)
 *   ---
 *   # Body prose           (preserved verbatim)
 *
 * The same engine serves node-frontmatter, which additionally accepts a scalar
 * form (`owner: Felix <f@x.eu>`). Adding a second principal to a scalar verb
 * normalises it to the block-list form.
 */

import {
  type Verb,
  type ParsedEntry,
  parseAccessEntry,
  canonicalEmail,
  canonicalRoleName,
  accessMdDeclaresBodyRules,
} from './access-control.service.js';

/**
 * Which rule block a mutation edits.
 *
 *  - `'node'` (default): the file's YAML frontmatter — node files, and every
 *    call that predates the two-format `access.md` story.
 *  - `'folder'`: the block that governs the CONTAINING FOLDER of an
 *    `access.md` — the body when the file is in the new (body-governed)
 *    format, the frontmatter otherwise. Callers mutating folder rules pass
 *    this so a grant can never land in a new-format file's frontmatter
 *    (which governs the FILE itself, not the folder).
 */
export type SpliceTarget = 'node' | 'folder';

/** A principal to grant/revoke, in the resolver's canonical terms. */
export type Principal =
  | { kind: 'user'; email: string; displayName: string }
  | { kind: 'role'; role: string };

/** Result of a splice — the new full file text and whether anything changed. */
export interface SpliceResult {
  text: string;
  changed: boolean;
}

/** Thrown when the input can't be spliced safely (malformed frontmatter, etc.). */
export class AccessSpliceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessSpliceError';
  }
}

/** Control chars (NUL..US) — newlines, tabs, etc. Never allowed in a principal. */
// eslint-disable-next-line no-control-regex -- intentional control-char injection guard
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Render a principal as the canonical access-entry line value the parser reads
 * back (`Name <email>` or a bare role display name). The caller is responsible
 * for having validated the principal first (see `validatePrincipal`).
 *
 * `deny` prefixes the entry with `deny ` so the resolver reads it as a denial
 * (the `deny-here` per-item override) — same line shape, opposite verdict.
 */
export function renderEntry(p: Principal, deny = false): string {
  const body = p.kind === 'user' ? `${p.displayName} <${p.email}>` : p.role;
  return deny ? `deny ${body}` : body;
}

/**
 * Validate a principal before it is spliced into a file. Rejects anything that
 * could break frontmatter or smuggle in extra YAML — newlines, control chars,
 * and emails / names that don't match the resolver's own regexes. This is the
 * injection guard: a principal that survives this is safe to render verbatim
 * into a `  - ` list line.
 *
 * Returns the canonical principal (lowercased email / canonical role) on
 * success, or throws `AccessSpliceError`.
 */
export function validatePrincipal(p: Principal): Principal {
  if (p.kind === 'user') {
    const displayName = p.displayName.trim();
    const email = canonicalEmail(p.email);
    if (!displayName) throw new AccessSpliceError('person grant needs a display name');
    // `#` is rejected because `uncomment()` truncates a whitespace-preceded `#`
    // on read-back, so a name containing it would not round-trip through blockEntries.
    if (
      CONTROL_CHARS.test(displayName) ||
      displayName.includes('<') ||
      displayName.includes('>') ||
      displayName.includes('#')
    ) {
      throw new AccessSpliceError(`invalid display name: ${JSON.stringify(p.displayName)}`);
    }
    // Reuse the resolver's own email shape so a granted entry always parses back.
    if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(email)) {
      throw new AccessSpliceError(`invalid email: ${JSON.stringify(p.email)}`);
    }
    // The rendered `Name <email>` line must round-trip through parseAccessEntry.
    const round = parseAccessEntry(`${displayName} <${email}>`);
    if (!round.ok || round.entry.kind !== 'user' || round.entry.deny) {
      throw new AccessSpliceError(`person grant does not round-trip: ${JSON.stringify(p)}`);
    }
    return { kind: 'user', email, displayName };
  }
  const role = p.role.trim();
  const canonical = canonicalRoleName(role);
  if (!canonical) throw new AccessSpliceError('group grant needs a name');
  if (
    CONTROL_CHARS.test(role) ||
    role.includes('<') ||
    role.includes('>') ||
    role.includes(':') ||
    role.includes('#')
  ) {
    throw new AccessSpliceError(`invalid group name: ${JSON.stringify(p.role)}`);
  }
  // `deny` is never a grantee — it's the denial prefix. `everyone` IS grantable
  // (the built-in public role); the access route restricts it to the read verb.
  if (canonical === 'deny') {
    throw new AccessSpliceError(`'${role}' is a reserved name and cannot be granted as a group`);
  }
  const round = parseAccessEntry(role);
  if (!round.ok || round.entry.kind !== 'role' || round.entry.deny) {
    throw new AccessSpliceError(`group grant does not round-trip: ${JSON.stringify(p)}`);
  }
  return { kind: 'role', role };
}

/** True when a parsed entry names the given principal (ignoring deny prefix). */
function entryMatches(entry: ParsedEntry, p: Principal): boolean {
  if (p.kind === 'user') return entry.kind === 'user' && entry.email === canonicalEmail(p.email);
  return entry.kind === 'role' && entry.role === canonicalRoleName(p.role);
}

// ---------------------------------------------------------------------------
// Raw-text frontmatter model — line-addressed, body preserved
// ---------------------------------------------------------------------------

interface Frontmatter {
  /** Lines before and including the opening `---`. */
  pre: string[];
  /** The frontmatter body lines (between the `---` fences), edited in place. */
  fm: string[];
  /** The closing `---` and everything after it (the markdown body), verbatim. */
  post: string[];
  /** The newline the file uses (`\n` or `\r\n`), preserved on re-join. */
  eol: string;
}

/**
 * Split a file into [pre, frontmatter-lines, post] without losing a byte.
 * `hasFrontmatter` is false when the file has no `---` fence yet — callers that
 * grant into a fresh file synthesise one.
 */
function splitFrontmatter(text: string): Frontmatter & { hasFrontmatter: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // Opening fence must be the very first line.
  if (lines[0]?.trim() !== '---') {
    return { pre: [], fm: [], post: lines, eol, hasFrontmatter: false };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return {
        pre: lines.slice(0, 1), // the opening ---
        fm: lines.slice(1, i),
        post: lines.slice(i), // closing --- onward (body preserved)
        eol,
        hasFrontmatter: true,
      };
    }
  }
  throw new AccessSpliceError('unterminated frontmatter — no closing `---`');
}

function joinFrontmatter(f: Frontmatter): string {
  return [...f.pre, ...f.fm, ...f.post].join(f.eol);
}

/**
 * The line region a mutation edits, per {@link SpliceTarget}. `lines` aliases
 * the region's array (edited in place, like `f.fm` always was); `join()`
 * reassembles the whole file around it.
 */
function pickRegion(
  text: string,
  f: Frontmatter & { hasFrontmatter: boolean },
  target: SpliceTarget,
): { lines: string[]; join(): string } {
  if (target === 'folder' && f.hasFrontmatter && accessMdDeclaresBodyRules(text)) {
    // New format: post = [closing '---', ...body]. Edit the body lines.
    const closing = f.post[0];
    const body = f.post.slice(1);
    return {
      lines: body,
      join: () => [...f.pre, ...f.fm, closing, ...body].join(f.eol),
    };
  }
  return { lines: f.fm, join: () => joinFrontmatter(f) };
}

/** Leading-space count of a line. */
function indentOf(line: string): number {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

/** Strip a trailing `# comment` the way the resolver's tokeniser does. */
function uncomment(line: string): string {
  let inWs = true;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '#' && (inWs || (i > 0 && /\s/.test(line[i - 1])))) return line.slice(0, i);
    if (!/\s/.test(ch)) inWs = false;
  }
  return line;
}

interface VerbBlock {
  /** Index in `fm` of the `verb:` key line, or -1 when the key is absent. */
  keyLine: number;
  /** The key line's indent (for a top-level access.md key this is 0). */
  keyIndent: number;
  /** Indices in `fm` of the `- item` lines belonging to this verb, in order. */
  itemLines: number[];
  /** Indent the list items use (or keyIndent+2 when the verb is empty). */
  itemIndent: number;
  /** The verb declared inline as `verb: []` (empty flow list). */
  inlineEmpty: boolean;
  /** The verb declared inline as a scalar (`owner: Name <email>`). */
  inlineScalarValue: string | null;
}

/**
 * Locate a verb's block within the frontmatter lines. Walks the raw lines (not
 * the parsed model) so we can address them for splicing. Recognises the three
 * shapes the resolver accepts: a block list, an inline `verb: []`, and (node
 * frontmatter only) an inline scalar `verb: value`.
 */
function findVerbBlock(fm: string[], verb: Verb): VerbBlock {
  const block: VerbBlock = {
    keyLine: -1,
    keyIndent: 0,
    itemLines: [],
    itemIndent: -1,
    inlineEmpty: false,
    inlineScalarValue: null,
  };
  for (let i = 0; i < fm.length; i++) {
    const content = uncomment(fm[i]);
    if (!content.trim()) continue;
    const indent = indentOf(content);
    const body = content.slice(indent);
    // A list item belonging to the current verb block.
    if (
      (body.startsWith('- ') || body === '-') &&
      block.keyLine !== -1 &&
      indent > block.keyIndent
    ) {
      block.itemLines.push(i);
      if (block.itemIndent === -1) block.itemIndent = indent;
      continue;
    }
    const colon = body.indexOf(':');
    if (colon < 0) continue; // not a key line; ignore (the parser would too)
    const key = body.slice(0, colon).trim();
    const value = body.slice(colon + 1).trim();
    if (block.keyLine !== -1) {
      // We already found our verb; a new key at <= our indent ends the block.
      if (indent <= block.keyIndent) break;
      continue;
    }
    if (key === verb && indent === 0) {
      block.keyLine = i;
      block.keyIndent = indent;
      if (value === '[]') block.inlineEmpty = true;
      else if (value !== '') block.inlineScalarValue = value;
    }
  }
  if (block.itemIndent === -1) block.itemIndent = block.keyIndent + 2;
  return block;
}

/**
 * Parse the items currently under a verb block into ParsedEntry form, for
 * matching. Handles list items and the inline-scalar form.
 */
function blockEntries(fm: string[], block: VerbBlock): { entry: ParsedEntry; line: number }[] {
  const out: { entry: ParsedEntry; line: number }[] = [];
  if (block.inlineScalarValue !== null) {
    const r = parseAccessEntry(block.inlineScalarValue);
    if (r.ok) out.push({ entry: r.entry, line: block.keyLine });
    return out;
  }
  for (const li of block.itemLines) {
    const content = uncomment(fm[li]).trim();
    const value = content === '-' ? '' : content.slice(2).trim();
    if (!value) continue;
    const r = parseAccessEntry(value);
    if (r.ok) out.push({ entry: r.entry, line: li });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public splice operations
// ---------------------------------------------------------------------------

/**
 * Add `principal` under `verb`. Idempotent: if an equivalent entry already
 * exists with the SAME deny-ness (a grant when granting, a deny when denying),
 * returns `changed: false`. Creates the verb key (and the frontmatter fence,
 * for a fresh file) as needed. Preserves everything else byte-for-byte.
 *
 * `allowScalar` controls whether a fresh single-entry verb may be written in
 * the node-frontmatter scalar form (`owner: Name <email>`). access.md always
 * uses the block-list form; node frontmatter prefers scalar for a lone entry.
 *
 * `deny` writes the entry as a `deny <principal>` denial instead of a grant
 * (the `deny-here` per-item override). The block/scalar/empty-list handling is
 * identical — only the rendered line and the idempotency check differ — so the
 * deny path reuses this engine rather than a parallel `spliceDeny`. NOTE: the
 * resolver lets a same-scope grant override a same-scope deny of the same
 * principal, so a caller adding a deny where a grant already exists must strip
 * that grant first (see `AccessMutationService`); this function only writes the
 * one entry it's asked to.
 */
export function spliceGrant(
  text: string,
  verb: Verb,
  rawPrincipal: Principal,
  opts: { allowScalar?: boolean; deny?: boolean; target?: SpliceTarget } = {},
): SpliceResult {
  const principal = validatePrincipal(rawPrincipal);
  const deny = opts.deny ?? false;
  const f = splitFrontmatter(text);

  if (!f.hasFrontmatter) {
    // Fresh file — synthesise a minimal frontmatter block, keep any body lines
    // the caller passed (usually none for a new access.md).
    const itemLine = opts.allowScalar
      ? `${verb}: ${renderEntry(principal, deny)}`
      : `${verb}:${f.eol}  - ${renderEntry(principal, deny)}`;
    const fenced = ['---', itemLine, '---'].join(f.eol);
    const bodyText = f.post.length ? f.post.join(f.eol) : '';
    const text2 = bodyText ? `${fenced}${f.eol}${bodyText}` : `${fenced}${f.eol}`;
    return { text: text2, changed: true };
  }

  const region = pickRegion(text, f, opts.target ?? 'node');
  const block = findVerbBlock(region.lines, verb);
  const existing = blockEntries(region.lines, block);

  // Idempotency: an entry for this principal with the same deny-ness is already
  // present (a grant when granting, a deny when denying).
  if (existing.some((e) => entryMatches(e.entry, principal) && e.entry.deny === deny)) {
    return { text, changed: false };
  }

  const itemValue = renderEntry(principal, deny);

  if (block.keyLine === -1) {
    // Verb key absent — append a new block at the end of the region.
    const lines = opts.allowScalar ? [`${verb}: ${itemValue}`] : [`${verb}:`, `  - ${itemValue}`];
    region.lines.push(...lines);
    return { text: region.join(), changed: true };
  }

  if (block.inlineScalarValue !== null) {
    // Scalar form — promote to a block list with both the old and new entry.
    const old = block.inlineScalarValue;
    region.lines.splice(block.keyLine, 1, `${verb}:`, `  - ${old}`, `  - ${itemValue}`);
    return { text: region.join(), changed: true };
  }

  // Block-list (possibly inline `[]`). Insert after the last existing item, or
  // right after the key line when the list is currently empty.
  const indent = ' '.repeat(block.itemIndent);
  const newLine = `${indent}- ${itemValue}`;
  if (block.inlineEmpty) {
    // `verb: []` -> `verb:` + one item.
    region.lines[block.keyLine] = `${' '.repeat(block.keyIndent)}${verb}:`;
    region.lines.splice(block.keyLine + 1, 0, newLine);
    return { text: region.join(), changed: true };
  }
  const insertAt =
    block.itemLines.length > 0 ? block.itemLines[block.itemLines.length - 1] + 1 : block.keyLine + 1;
  region.lines.splice(insertAt, 0, newLine);
  return { text: region.join(), changed: true };
}

/**
 * Remove every entry naming `principal` under `verb` (grant or deny). Idempotent:
 * returns `changed: false` when the principal isn't present. If removing the
 * last item empties the verb, the `verb:` key is collapsed to `verb: []` so the
 * file still parses cleanly (the resolver reads `[]` as an empty list).
 * Preserves everything else.
 */
export function spliceRevoke(
  text: string,
  verb: Verb,
  rawPrincipal: Principal,
  opts: { target?: SpliceTarget } = {},
): SpliceResult {
  const principal = validatePrincipal(rawPrincipal);
  const f = splitFrontmatter(text);
  if (!f.hasFrontmatter) return { text, changed: false };

  const region = pickRegion(text, f, opts.target ?? 'node');
  const block = findVerbBlock(region.lines, verb);
  if (block.keyLine === -1) return { text, changed: false };

  if (block.inlineScalarValue !== null) {
    const r = parseAccessEntry(block.inlineScalarValue);
    if (r.ok && entryMatches(r.entry, principal)) {
      // Lone scalar entry removed -> collapse to empty list.
      region.lines[block.keyLine] = `${' '.repeat(block.keyIndent)}${verb}: []`;
      return { text: region.join(), changed: true };
    }
    return { text, changed: false };
  }

  const entries = blockEntries(region.lines, block);
  const victims = entries.filter((e) => entryMatches(e.entry, principal)).map((e) => e.line);
  if (victims.length === 0) return { text, changed: false };

  // Delete from the bottom up so earlier indices stay valid.
  const remaining = block.itemLines.filter((l) => !victims.includes(l));
  for (const line of [...victims].sort((a, b) => b - a)) region.lines.splice(line, 1);

  if (remaining.length === 0) {
    // Verb block is now empty — collapse `verb:` to `verb: []`. The key line
    // index is unchanged because we only removed lines that came after it.
    region.lines[block.keyLine] = `${' '.repeat(block.keyIndent)}${verb}: []`;
  }
  return { text: region.join(), changed: true };
}


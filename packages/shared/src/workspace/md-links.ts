/**
 * The markdown link grammar a move rewrites with: where the links in a page
 * are, what each one points at, and how to point it somewhere else without
 * changing anything else about it.
 *
 * Pure and dependency-free, so the backend's move and the web app can share
 * it. The resolver half is the web app's (`resolveKbHref` in the frontend's
 * `routing/kb-routes.ts`) restated here; a parity test there holds the two to
 * one answer on a shared fixture set.
 *
 * What it deliberately is NOT: a markdown parser. It finds link
 * DESTINATIONS — inline links, images, reference definitions, and the inline
 * links in a node's frontmatter (the `nodeType` link) — as character spans, so
 * a rewrite splices the new destination into the old one's place and every
 * other byte of the file stays as it was. Code — fenced blocks, indented
 * blocks and inline code — is skipped: a path written there is an example,
 * not a link.
 */

import { extractFrontmatter } from './frontmatter.js';

/**
 * An id-link destination: a node's frontmatter id (`project-hexis`), optionally
 * with a heading anchor. The web app's `NODE_ID_LINK_RE`, restated: an id-link
 * points at a node wherever it lives, so a move never changes one.
 */
export const MD_ID_LINK_RE = /^[a-z0-9][a-z0-9_-]*(#[^/]+)?$/;

/** The app route a copied link names a file by: `/workspace/<branch>/<path>`. */
const WORKSPACE_ROUTE_PREFIX = '/workspace/';

/** One link destination found in a page. */
export interface MdLinkSpan {
  /** `link` and `image` are inline (`[x](d)`, `![x](d)`); `definition` is `[x]: d`. */
  kind: 'link' | 'image' | 'definition';
  /** Offsets of the destination as written, angle brackets excluded. */
  start: number;
  end: number;
  /** The destination as written (`text.slice(start, end)`). */
  destination: string;
  /** Written as `<dest>`. */
  angle: boolean;
  /** Inside the `---` frontmatter block. */
  inFrontmatter: boolean;
}

/**
 * Every link destination in a markdown page, in document order. Code is
 * skipped: fenced blocks (``` and ~~~, in lists and quotes too) and inline code
 * spans. A footnote (`[^1]: …`) is not a reference definition.
 */
export function scanMarkdownLinks(text: string): MdLinkSpan[] {
  const out: MdLinkSpan[] = [];
  let bodyStart = 0;
  const fm = extractFrontmatter(text);
  if (fm) {
    bodyStart = text.length - fm.body.length;
    const fmStart = text.indexOf('\n') + 1;
    const fmEnd = fmStart + fm.frontmatter.length;
    // Line by line: a frontmatter value is one line, and a link never spans
    // two. Only a value that IS one link counts — what the web app's
    // frontmatter panel renders as a link (`nodeType` the usual one); a link
    // written inside a prose value shows as text there, so it is left alone.
    let lineStart = fmStart;
    while (lineStart < fmEnd) {
      const nl = text.indexOf('\n', lineStart);
      const lineEnd = nl === -1 || nl > fmEnd ? fmEnd : nl;
      const value = FRONTMATTER_LINK_VALUE_RE.exec(text.slice(lineStart, lineEnd).replace(/\r$/, ''));
      // Only the link itself: a trailing YAML comment is not part of the value.
      if (value) {
        const linkStart = lineStart + value[1].length;
        scanInline(text, linkStart, linkStart + value[3].length, true, out);
      }
      lineStart = lineEnd + 1;
    }
  }
  scanBody(text, bodyStart, {
    prose: (from, to) => scanInline(text, from, to, false, out),
    definition: (span) => out.push(span),
  });
  return out;
}

/**
 * `text` with everything that cannot start a live HTML tag blanked to spaces
 * — fenced and indented code blocks, inline code spans, the frontmatter, and
 * an escaped `\<`, which is a literal `<` — every kept character at its
 * offset. It locates tag spans and nothing else: inside a raw tag a backslash
 * is not an escape, so every other escape is kept as the two characters it
 * is, and the attribute values are read from the original text.
 */
function maskMarkdownCode(text: string): string {
  const chars: string[] = Array.from({ length: text.length }, (_, i) => (text[i] === '\n' ? '\n' : ' '));
  const keep = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const c = text[i];
      if (c === '\\') {
        if (i + 1 < to && text[i + 1] === '<') {
          i += 2;
          continue;
        }
        chars[i] = c;
        i += 1;
        continue;
      }
      if (c === '`') {
        let n = 1;
        while (i + n < to && text[i + n] === '`') n += 1;
        const close = findBacktickRun(text, i + n, to, n);
        if (close < 0) {
          for (let k = i; k < i + n; k += 1) chars[k] = text[k];
          i += n;
        } else {
          i = close + n;
        }
        continue;
      }
      chars[i] = c;
      i += 1;
    }
  };
  const fm = extractFrontmatter(text);
  scanBody(text, fm ? text.length - fm.body.length : 0, {
    prose: keep,
    definition: (span) => keep(span.start, span.end),
  });
  return chars.join('');
}

/**
 * The `href`/`src` values of the raw HTML tags a markdown page carries —
 * what the app renders as a link or a picture that the markdown grammar does
 * not rewrite. Only an unescaped `<tag …>` outside code counts: a tag in a
 * fence, a code span or behind a `\<` is an example, and a bare `href=` in
 * prose is prose.
 */
export function scanMarkdownHtmlLinks(text: string): string[] {
  const out: string[] = [];
  // A tag ends at the first `>` outside a quoted attribute value.
  const tag = /<[a-zA-Z][a-zA-Z0-9-]*(?:\s+(?:"[^"]*"|'[^']*'|[^<>"'])*)?>/g;
  const masked = maskMarkdownCode(text);
  for (let m = tag.exec(masked); m !== null; m = tag.exec(masked)) {
    // The span located on the mask, the attributes read from the page itself.
    out.push(...scanHtmlLinks(text.slice(m.index, m.index + m[0].length)));
  }
  return out;
}

/** Where `scanBody` hands what it finds: prose runs (code left out) and reference definitions. */
interface BodySink {
  prose: (from: number, to: number) => void;
  definition: (span: MdLinkSpan) => void;
}

/**
 * A frontmatter line whose whole value is one markdown link, quoted or not
 * (the panel's `FRONTMATTER_LINK_RE`, on the value YAML hands it — which is
 * why a trailing ` # comment`, stripped by YAML, may follow). An unquoted
 * one is matched too: YAML reads it as a flow sequence, so the panel shows no
 * link, but the graph tooling reads `nodeType` lines with a line regex, not
 * YAML, and still follows it. Group 1 is everything before the link; group 3
 * is the link.
 */
const FRONTMATTER_LINK_VALUE_RE =
  /^([ \t]*[^\s:#][^:]*:[ \t]+(["']?))(\[[^\]]+\]\(<?[^)>]+>?\))\2(?:[ \t]+#.*)?[ \t]*$/;

/**
 * An opening code fence: its character and length. Group 1 is what precedes
 * the fence on the line — quote and list markers and the fence's own indent —
 * which may be at most three columns past its container.
 */
const FENCE_OPEN_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/;

/** The fence's own indent: the columns after the last quote or list marker. */
function fenceIndent(prefix: string, listIndent: number | null): number {
  const quoted = prefix.lastIndexOf('>');
  if (quoted >= 0) return indentOf(prefix.slice(quoted + 1).replace(/^[ \t]/, ''));
  const item = LIST_ITEM_RE.exec(prefix);
  if (item) return 0;
  return indentOf(prefix) - (listIndent ?? 0);
}

/** A list item's marker, with the spaces after it. */
const LIST_ITEM_RE = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;

/** The column a line's text starts at, tabs stopping every 4 columns. */
function indentOf(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === ' ') col += 1;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

function scanBody(text: string, from: number, sink: BodySink): void {
  let fence: { char: string; len: number } | null = null;
  // An indented code block: four columns past where the enclosing list item's
  // text starts (column 0 outside a list), opened where a paragraph cannot be
  // continued — after a blank line, a heading, a fence, or at the top.
  let indentedCode = false;
  /** The column the current list item's text starts at, or null outside a list. */
  let listIndent: number | null = null;
  let mayOpenCode = true;
  let prevBlank = true;
  // The run of prose lines since the last blank line or fence: inline
  // constructs (a link split over two lines) live within one such run.
  let chunkStart = -1;
  let chunkEnd = -1;
  const flush = () => {
    if (chunkStart >= 0) sink.prose(chunkStart, chunkEnd);
    chunkStart = -1;
  };
  let lineStart = from;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
    const blank = line.trim() === '';
    const indent = indentOf(line);
    if (fence) {
      const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line)![0];
      const run = line.slice(prefix.length).match(/^(`+|~+)[ \t]*$/);
      // A closing fence, like an opening one, sits at most three columns in.
      if (run && run[1][0] === fence.char && run[1].length >= fence.len && fenceIndent(prefix, listIndent) <= 3) {
        fence = null;
        mayOpenCode = true;
      }
    } else if (blank) {
      flush();
      mayOpenCode = true;
    } else if (indentedCode && indent >= (listIndent ?? 0) + 4) {
      // Still inside the indented code block.
    } else {
      indentedCode = false;
      // A line back at the margin after a blank line has left the list.
      if (listIndent !== null && prevBlank && indent < listIndent) listIndent = null;
      const item: RegExpExecArray | null = indent < (listIndent ?? 0) + 4 ? LIST_ITEM_RE.exec(line) : null;
      const fenceOpen = line.match(FENCE_OPEN_RE);
      // Four columns in, a fence line is code or a paragraph's continuation.
      const open = fenceOpen && fenceIndent(fenceOpen[1], listIndent) <= 3 ? fenceOpen : null;
      if (!item && mayOpenCode && indent >= (listIndent ?? 0) + 4) {
        flush();
        indentedCode = true;
      } else if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
        // A backtick fence's info string may hold no backtick (that is inline code).
        flush();
        fence = { char: open[2][0], len: open[2].length };
      } else {
        if (item) {
          const gap: number = item[3].length;
          listIndent = item[1].length + item[2].length + (gap === 0 || gap > 4 ? 1 : gap);
        }
        const def = matchDefinition(line, lineStart);
        if (def) {
          flush();
          sink.definition(def);
          mayOpenCode = false;
        } else {
          if (chunkStart < 0) chunkStart = lineStart;
          chunkEnd = lineEnd;
          // A heading ends its block; a paragraph line can be continued.
          mayOpenCode = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line);
          if (mayOpenCode) flush();
        }
      }
    }
    prevBlank = blank;
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  flush();
}

/**
 * `[label]: destination "title"` on one line, in a blockquote too; never a
 * footnote (`[^1]: …`).
 */
const DEFINITION_RE = /^((?:[ \t]{0,3}>[ \t]?)* {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*)(<[^<>\n]*>|[^\s<][^\s]*)(?=[ \t]|$)/;

function matchDefinition(line: string, lineStart: number): MdLinkSpan | null {
  const m = DEFINITION_RE.exec(line);
  if (!m) return null;
  const angle = m[2].startsWith('<');
  const start = lineStart + m[1].length + (angle ? 1 : 0);
  const destination = angle ? m[2].slice(1, -1) : m[2];
  if (destination === '') return null;
  return { kind: 'definition', start, end: start + destination.length, destination, angle, inFrontmatter: false };
}

/**
 * The inline links and images in `text[from, to)`. Brackets are matched as a
 * stack, so a link wrapping an image (`[![a](x.png)](y.md)`) yields both;
 * backslash escapes and code spans are stepped over.
 */
function scanInline(text: string, from: number, to: number, inFrontmatter: boolean, out: MdLinkSpan[]): void {
  const openers: { image: boolean }[] = [];
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (i + n < to && text[i + n] === '`') n += 1;
      const close = findBacktickRun(text, i + n, to, n);
      i = close < 0 ? i + n : close + n;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      openers.push({ image: true });
      i += 2;
      continue;
    }
    if (c === '[') {
      openers.push({ image: false });
      i += 1;
      continue;
    }
    if (c === ']') {
      const opener = openers.pop();
      if (opener && text[i + 1] === '(') {
        const dest = parseInlineDestination(text, i + 2, to);
        if (dest) {
          if (dest.end > dest.start) {
            out.push({
              kind: opener.image ? 'image' : 'link',
              start: dest.start,
              end: dest.end,
              destination: text.slice(dest.start, dest.end),
              angle: dest.angle,
              inFrontmatter,
            });
          }
          i = dest.close + 1;
          continue;
        }
      }
    }
    i += 1;
  }
}

/** Where a run of exactly `n` backticks starts in `text[from, to)`, or -1. */
function findBacktickRun(text: string, from: number, to: number, n: number): number {
  let i = from;
  while (i < to) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    let m = 1;
    while (i + m < to && text[i + m] === '`') m += 1;
    if (m === n) return i;
    i += m;
  }
  return -1;
}

/** Skip spaces and tabs, and at most one line break. */
function skipSpace(text: string, p: number, to: number): number {
  let newline = false;
  while (p < to) {
    const c = text[p];
    if (c === ' ' || c === '\t' || c === '\r') p += 1;
    else if (c === '\n' && !newline) {
      newline = true;
      p += 1;
    } else break;
  }
  return p;
}

/**
 * The destination of an inline link whose `(` ends just before `p`, with the
 * offset of its closing `)`; null when what follows is not a link destination
 * (then the brackets were just text).
 */
function parseInlineDestination(
  text: string,
  p: number,
  to: number,
): { start: number; end: number; angle: boolean; close: number } | null {
  p = skipSpace(text, p, to);
  let start: number;
  let end: number;
  let angle = false;
  if (text[p] === '<') {
    angle = true;
    start = p + 1;
    let q = start;
    while (q < to && text[q] !== '>') {
      if (text[q] === '\n' || text[q] === '<') return null;
      q += text[q] === '\\' ? 2 : 1;
    }
    if (q >= to) return null;
    end = q;
    p = q + 1;
  } else {
    start = p;
    let depth = 0;
    while (p < to) {
      const c = text[p];
      if (c === '\\' && p + 1 < to) {
        p += 2;
        continue;
      }
      if (c.charCodeAt(0) <= 0x20) break;
      if (c === '(') depth += 1;
      else if (c === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      p += 1;
    }
    if (depth !== 0) return null;
    end = p;
  }
  const afterDest = p;
  p = skipSpace(text, p, to);
  if (text[p] === ')') return { start, end, angle, close: p };
  // A title must be separated from the destination by whitespace.
  if (p === afterDest) return null;
  const opener = text[p];
  const closer = opener === '"' ? '"' : opener === "'" ? "'" : opener === '(' ? ')' : null;
  if (closer === null) return null;
  p += 1;
  while (p < to && text[p] !== closer) p += text[p] === '\\' ? 2 : 1;
  if (p >= to) return null;
  p = skipSpace(text, p + 1, to);
  return text[p] === ')' ? { start, end, angle, close: p } : null;
}

/**
 * The `href`/`src` values in an HTML page. A move never rewrites an HTML page
 * (most of its links are built in scripts nobody can see), so these are only
 * read, to report the page.
 */
export function scanHtmlLinks(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** How a link names its target, which a rewrite keeps. */
export type MdLinkForm = 'relative' | 'root' | 'workspace';

/** A link destination that names a file or folder in the workspace. */
export interface ResolvedMdLink {
  form: MdLinkForm;
  /** Workspace-relative (`knowledge-base/…`), decoded. */
  path: string;
  /** `#anchor` as written, or ''. */
  hash: string;
  /** The branch a `/workspace/<branch>/…` link names; null otherwise. */
  branch: string | null;
}

export interface ResolveMdLinkOptions {
  /** The workspace-relative file the link sits in. */
  basePath: string;
  /** The clone folder (`knowledge-base`), for the mangled-path repair. */
  kbDirName: string | null;
  /** An image source gets no mangled-path repair (see the web app's resolver). */
  image?: boolean;
}

/** An href as a browser reads it: outer controls and spaces off, inner tabs and line breaks out. */
export function normalizeMdHref(href: string): string {
  const inner = href.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = inner.length;
  while (start < end && inner.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && inner.charCodeAt(end - 1) <= 0x20) end -= 1;
  return inner.slice(start, end);
}

/** Leaves the workspace: a scheme, or protocol-relative. */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The markdown backslash escapes of ASCII punctuation, undone — what a renderer hands the resolver. */
function unescapeMarkdown(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** A path whose later segment is the clone folder, cut back to start there. */
function stripJunkBeforeKbDir(path: string, kbDirName: string | null): string {
  if (!kbDirName) return path;
  const segs = path.split('/');
  const idx = segs.indexOf(kbDirName);
  return idx > 0 ? segs.slice(idx).join('/') : path;
}

/** `relative` against the file `basePath`, as the web app resolves it. */
export function resolveMdRelativePath(basePath: string, relative: string): string {
  const baseDir = relative.startsWith('/')
    ? ''
    : basePath.includes('/')
      ? basePath.slice(0, basePath.lastIndexOf('/'))
      : '';
  const parts = baseDir ? baseDir.split('/') : [];
  for (const segment of relative.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

/**
 * What a destination written in `basePath` points at, or null when it names
 * no workspace path a move could affect: an external URL, an id-link, a
 * same-page `#anchor`, or a bare `/workspace/<branch>`.
 */
export function resolveMdLink(destination: string, opts: ResolveMdLinkOptions): ResolvedMdLink | null {
  const href = normalizeMdHref(unescapeMarkdown(destination));
  if (!href || isExternal(href) || MD_ID_LINK_RE.test(href)) return null;
  const hashIdx = href.indexOf('#');
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
  const location = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  if (!location) return null;
  const repair = (p: string) => (opts.image ? p : stripJunkBeforeKbDir(p, opts.kbDirName));
  if (location.startsWith(WORKSPACE_ROUTE_PREFIX)) {
    const rest = location.slice(WORKSPACE_ROUTE_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    return {
      form: 'workspace',
      branch: safeDecode(rest.slice(0, slash)),
      path: repair(safeDecode(rest.slice(slash + 1))),
      hash,
    };
  }
  return {
    form: location.startsWith('/') ? 'root' : 'relative',
    branch: null,
    path: repair(resolveMdRelativePath(opts.basePath, safeDecode(location))),
    hash,
  };
}

// ── Rewriting ───────────────────────────────────────────────────────────────

/** `target` relative to the folder `dir` (both workspace-relative). */
function relativeFrom(dir: string, target: string): string {
  const from = dir ? dir.split('/') : [];
  const to = target.split('/');
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i += 1;
  const rel = [...Array<string>(from.length - i).fill('..'), ...to.slice(i)].join('/');
  return rel === '' ? '.' : rel;
}

/** Characters that would end or break a destination written without angle brackets. */
function escapeBare(segment: string): string {
  return segment.replace(/[\s<>()\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function encodePath(path: string, how: { encoded: boolean; angle: boolean; inFrontmatter: boolean }): string {
  let out: string;
  if (how.encoded) {
    out = path
      .split('/')
      .map((s) => encodeURIComponent(s).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29')))
      .join('/');
  } else if (how.angle) {
    out = path.replace(/[<>\n]/g, (c) => encodeURIComponent(c));
  } else {
    // Only what would break the link: a balanced bare path stays as it is.
    out = /[\s<>\\]/.test(path) || !balanced(path) ? escapeBare(path) : path;
  }
  // A frontmatter link sits inside a YAML double-quoted string.
  return how.inFrontmatter ? out.replace(/"/g, '%22') : out;
}

function balanced(path: string): boolean {
  let depth = 0;
  for (const c of path) {
    if (c === '(') depth += 1;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** The parent folder of a workspace-relative file path. */
function dirOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/**
 * The destination `span` must carry once its file sits at `newBase` and its
 * target at `newTarget`, in the form it was written in: relative stays
 * relative (`./` and a trailing `/` kept), root-anchored stays root-anchored,
 * an app URL keeps its branch segment; encoding, anchor — and, because only
 * the destination is spliced, the title — stay as they were.
 */
export function retargetMdDestination(
  span: Pick<MdLinkSpan, 'destination' | 'angle' | 'inFrontmatter'>,
  resolved: ResolvedMdLink,
  newBase: string,
  newTarget: string,
): string {
  const href = normalizeMdHref(unescapeMarkdown(span.destination));
  const hashIdx = href.indexOf('#');
  const location = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const how = { encoded: /%[0-9a-f]{2}/i.test(location), angle: span.angle, inFrontmatter: span.inFrontmatter };
  const trailingSlash = location.length > 1 && location.endsWith('/') ? '/' : '';
  let next: string;
  if (resolved.form === 'workspace') {
    const rest = location.slice(WORKSPACE_ROUTE_PREFIX.length);
    const branchSegment = rest.slice(0, rest.indexOf('/'));
    next = `${WORKSPACE_ROUTE_PREFIX}${branchSegment}/${encodePath(newTarget, how)}`;
  } else if (resolved.form === 'root') {
    next = `/${encodePath(newTarget, how)}`;
  } else {
    let rel = relativeFrom(dirOf(newBase), newTarget);
    if (location.startsWith('./') && !rel.startsWith('../') && rel !== '.') rel = `./${rel}`;
    next = encodePath(rel, how);
  }
  return `${next}${trailingSlash && !next.endsWith('/') ? '/' : ''}${resolved.hash}`;
}

/** One destination a rewrite changed. */
export interface MdLinkEdit {
  from: string;
  to: string;
}

export interface RewriteMdLinksOptions {
  /** Where the file is now (workspace-relative). */
  oldPath: string;
  /** Where the file will be after the move (`oldPath` when it does not move). */
  newPath: string;
  /** A workspace path's place after the move, or null when it does not move. */
  mapPath: (path: string) => string | null;
  kbDirName: string | null;
  /** The branch the move happens on: a link (not an image) to another branch's app URL is left alone. */
  branch: string;
}

/**
 * Rewrite the links in one markdown page so that, once it sits at `newPath`
 * and every moved path is at its new place, each points at the same target it
 * did before. A link that already does is left alone, as is every byte that is
 * not a changed destination.
 */
export function rewriteMdLinks(text: string, opts: RewriteMdLinksOptions): { text: string; edits: MdLinkEdit[] } {
  const edits: (MdLinkEdit & { start: number; end: number })[] = [];
  for (const span of scanMarkdownLinks(text)) {
    const image = span.kind === 'image';
    const before = resolveMdLink(span.destination, { basePath: opts.oldPath, kbDirName: opts.kbDirName, image });
    // A link naming another branch opens that branch, which this move does
    // not touch. An image does not: the web app serves every image from the
    // branch the page is read on, whatever branch its URL names.
    if (!before || (!image && before.branch !== null && before.branch !== opts.branch)) continue;
    const target = opts.mapPath(before.path) ?? before.path;
    const after = resolveMdLink(span.destination, { basePath: opts.newPath, kbDirName: opts.kbDirName, image });
    if (after && after.path === target) continue;
    const to = retargetMdDestination(span, before, opts.newPath, target);
    if (to === span.destination) continue;
    edits.push({ start: span.start, end: span.end, from: span.destination, to });
  }
  if (edits.length === 0) return { text, edits: [] };
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.start) + e.to;
    at = e.end;
  }
  out += text.slice(at);
  return { text: out, edits: edits.map(({ from, to }) => ({ from, to })) };
}

/**
 * The destinations in an HTML page that point at a moved path, or (for a page
 * that moves itself) whose relative target the move would break. Reported,
 * never rewritten.
 */
export function htmlLinksAffectedByMove(
  text: string,
  opts: RewriteMdLinksOptions,
  /** The destinations to judge: an HTML page's by default, a markdown page's from {@link scanMarkdownHtmlLinks}. */
  destinations: string[] = scanHtmlLinks(text),
): string[] {
  const out: string[] = [];
  for (const destination of destinations) {
    const before = resolveMdLink(destination, { basePath: opts.oldPath, kbDirName: opts.kbDirName });
    if (!before || (before.branch !== null && before.branch !== opts.branch)) continue;
    const target = opts.mapPath(before.path) ?? before.path;
    const after = resolveMdLink(destination, { basePath: opts.newPath, kbDirName: opts.kbDirName });
    if (!after || after.path !== target) out.push(destination);
  }
  return out;
}

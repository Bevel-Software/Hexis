import AdmZip from 'adm-zip';
import { decodeXmlEntities, xmlAttrValue, zipEntryOversize } from './ooxml-text.js';

/**
 * Minimal ODF (OpenDocument) text helpers shared by the odt/odp/ods
 * extractors. Same DELIBERATELY hand-rolled approach as `ooxml-text.ts`: an
 * ODF package's `content.xml` is well-formed XML (LibreOffice/OpenOffice wrote
 * it), and the extractors only need paragraph character content plus three
 * whitespace elements — a linear regex scan does that correctly without a new
 * XML-parser dependency.
 */

/**
 * The text of one ODF paragraph (`<text:p>` / `<text:h>` content). Character
 * data between tags is entity-decoded and concatenated with NO separator —
 * formatting runs (`<text:span>`) split words exactly like OOXML runs do, so
 * ignoring the span tags joins them back. Three ODF whitespace elements are
 * REAL characters and are rendered as such:
 *
 *  - `<text:tab/>`        → a tab
 *  - `<text:line-break/>` → a newline
 *  - `<text:s text:c="N"/>` → N spaces (no `text:c` attribute = 1)
 */
export function odfParagraphText(paragraphXml: string): string {
  let out = '';
  let last = 0;
  const tagRe = /<[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(paragraphXml)) !== null) {
    out += decodeXmlEntities(paragraphXml.slice(last, m.index));
    last = tagRe.lastIndex;
    const name = /^<\/?([^\s/>]+)/.exec(m[0])?.[1];
    if (name === 'text:tab') out += '\t';
    else if (name === 'text:line-break') out += '\n';
    else if (name === 'text:s') {
      const c = xmlAttrValue(m[0], 'text:c');
      const count = c !== undefined ? parseInt(c, 10) : 1;
      // A count is bounded defensively — a corrupt attribute must not balloon the extraction.
      out += ' '.repeat(Number.isFinite(count) ? Math.min(Math.max(count, 0), 1000) : 1);
    }
  }
  return out + decodeXmlEntities(paragraphXml.slice(last));
}

/** One element found by {@link odfElementBlocks}. */
export interface OdfElementBlock {
  /** The qualified name as written, e.g. `text:p` — which of `names` matched. */
  name: string;
  /** The attribute region verbatim (leading space included), '' when there is none. */
  attrs: string;
  /** The body between `>` and the matching close tag; undefined when self-closing. */
  body: string | undefined;
}

/**
 * Index of the `>` that ends the tag whose attribute region starts at `from`,
 * or -1 when the tag never terminates. Quote-aware, so a `>` or `/>` INSIDE a
 * quoted attribute value is part of the value and never the delimiter.
 *
 * On failure, every `<` passed OUTSIDE quotes is recorded in `dead`: a tag
 * starting there would be scanned from the same quote state over the same
 * tail, so it too can only fail. That memo is what keeps the whole pass
 * linear — it is the argument `email-text.ts`'s scanner rests on.
 */
function scanOdfTagEnd(xml: string, from: number, dead: Set<number>): number {
  let quote: '"' | "'" | null = null;
  const passedUnquoted: number[] = [];
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
    else if (c === '<') passedUnquoted.push(i);
  }
  for (const p of passedUnquoted) dead.add(p);
  return -1;
}

/**
 * The `<name …>…</name>` and self-closing `<name …/>` elements named by
 * `names`, in document order, treated as NON-NESTING (the first close tag
 * wins) — the four ODF shapes the extractors need: paragraphs, headings, draw
 * pages, table rows and cells.
 *
 * A SINGLE-PASS scanner, not a regex, for the reason `email-text.ts` gave up
 * its tag regexes. The pattern this replaces —
 * `<text:p(?=[\s/>])${TAG_ATTRS}(?:\/>|>([\s\S]*?)<\/text:p>)` — re-scanned
 * the rest of the document from EVERY opener whose match failed, and
 * `content.xml` is user-supplied bytes up to `MAX_DOC_PART_BYTES` (50 MB). A
 * crafted file of unmatched `<text:p>` openers therefore cost
 * O(openers x bytes): measured at 464 KB it took 2.3 s and quadrupled with
 * every doubling of the input — hours of pinned CPU at the size cap, from a
 * .odt/.odp/.ods that compresses to a few kilobytes.
 *
 * The scan is quote-aware exactly like the regex it replaces, and bounds both
 * failure modes:
 *
 *  - an attribute scan that runs off the end marks the openers it passed
 *    unquoted as dead (see `scanOdfTagEnd`), so no position is rescanned from
 *    more than the three possible quote states;
 *  - a close tag is looked for only when one EXISTS at or after the search
 *    position — `lastIndexOf` per name, computed once — so a missing close tag
 *    costs one scan of the document in total, not one per opener.
 */
export function odfElementBlocks(xml: string, names: readonly string[]): OdfElementBlock[] {
  // Longest first, so a name that PREFIXES another can never shadow it.
  const wanted = [...names].sort((a, b) => b.length - a.length);
  const lastClose = new Map<string, number>();
  const lastCloseIndex = (name: string): number => {
    let known = lastClose.get(name);
    if (known === undefined) {
      known = xml.lastIndexOf(`</${name}>`);
      lastClose.set(name, known);
    }
    return known;
  };
  const dead = new Set<number>();
  const out: OdfElementBlock[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (dead.has(lt)) {
      i = lt + 1;
      continue;
    }
    // The delimiter check is the regex's `(?=[\s/>])` lookahead: it keeps
    // `<text:page-number>` from counting as a `<text:p>`.
    const name = wanted.find(
      (n) => xml.startsWith(n, lt + 1) && /[\s/>]/.test(xml[lt + 1 + n.length] ?? ''),
    );
    if (name === undefined) {
      i = lt + 1;
      continue;
    }
    const attrsStart = lt + 1 + name.length;
    const gt = scanOdfTagEnd(xml, attrsStart, dead);
    if (gt === -1) {
      i = lt + 1; // unterminated tag: not an element
      continue;
    }
    // `<x a="/"/>` is self-closing, `<x a="/">` is not: the character before
    // the delimiter is only ever a `/` of the tag's own when it sits outside
    // every quote (a closing quote is `"` or `'`, never `/`).
    if (gt > attrsStart && xml[gt - 1] === '/') {
      out.push({ name, attrs: xml.slice(attrsStart, gt - 1), body: undefined });
      i = gt + 1;
      continue;
    }
    const bodyStart = gt + 1;
    if (bodyStart > lastCloseIndex(name)) {
      i = lt + 1; // no `</name>` left in the document — this opener cannot match
      continue;
    }
    const close = `</${name}>`;
    const closeAt = xml.indexOf(close, bodyStart);
    if (closeAt === -1) {
      i = lt + 1; // unreachable given the guard above; kept total
      continue;
    }
    out.push({ name, attrs: xml.slice(attrsStart, gt), body: xml.slice(bodyStart, closeAt) });
    i = closeAt + close.length;
  }
  return out;
}

/**
 * The `<text:p>` / `<text:h>` paragraph bodies of an XML fragment, in DOCUMENT
 * order (headings interleaved with paragraphs, as written). Self-closing
 * elements (`<text:p/>`, an empty paragraph) yield ''. `<text:page-number>` and
 * friends do not count as paragraphs; the first close tag wins, which is
 * correct because ODF paragraphs cannot nest.
 */
export function odfParagraphBlocks(xml: string): string[] {
  return odfElementBlocks(xml, ['text:p', 'text:h']).map((e) => e.body ?? '');
}

/** Non-empty paragraph texts of an ODF fragment — what odp slides/notes render. */
export function odfParagraphLines(xml: string): string[] {
  const out: string[] = [];
  for (const p of odfParagraphBlocks(xml)) {
    const text = odfParagraphText(p);
    if (text.trim() !== '') out.push(text);
  }
  return out;
}

/**
 * The ODF namespace URIs whose bound prefixes the extractors' regexes name
 * literally (`text:p`, `table:table`, `draw:page`, `presentation:notes`,
 * `office:text`…). Namespace-well-formed XML may bind ANY prefix to these
 * URIs; `normalizeOdfPrefixes` maps whatever the document chose back onto the
 * conventional ones so the scans stay correct.
 */
const ODF_CONVENTIONAL_PREFIX: Record<string, string> = {
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0': 'presentation',
};

/**
 * The most `xmlns:*` aliases one content.xml may bind to the five ODF URIs.
 * Real producers declare each namespace ONCE; dozens of aliases only ever
 * appear in crafted input, so past this bound the document is refused (a
 * thrown Error, which `readOdfContentXml` turns into the typed parse failure).
 */
export const MAX_ODF_NS_ALIASES = 64;

/**
 * Rewrite non-conventional namespace prefixes to the conventional ODF ones.
 *
 * Reads the ROOT element's `xmlns:*` declarations (where every real-world ODF
 * producer declares them — nested redeclarations are out of scope for the
 * hand-rolled scanner) and, for each prefix bound to one of the five ODF URIs
 * above under a different name, deterministically rewrites that prefix
 * wherever it starts a tag name (`<p:`, `</p:`) or an attribute name
 * (`␣p:name=`). ONE combined pass over the document — a single alternation
 * regex built from every alias's escaped name — so N declared aliases cost one
 * scan, never N full-document rewrites (a crafted content.xml declaring many
 * aliases must not become quadratic CPU). The single pass also makes
 * simultaneous renames (documents that SWAP two conventional prefixes) safe
 * for free: replaced text is never rescanned.
 *
 * Throws when the root binds more than {@link MAX_ODF_NS_ALIASES} aliases to
 * the ODF URIs — see there.
 */
export function normalizeOdfPrefixes(xml: string): string {
  const root = /<[A-Za-z_][^\s/>]*((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(xml);
  if (!root) return xml;
  const declRe = /xmlns:([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  // alias → canonical prefix; the FIRST declaration wins on a duplicate alias
  // (namespace-well-formed XML cannot redeclare a prefix on one element).
  const canonicalByAlias = new Map<string, string>();
  let declared = 0;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(root[1])) !== null) {
    const to = ODF_CONVENTIONAL_PREFIX[m[2] ?? m[3]];
    if (to === undefined) continue;
    if (++declared > MAX_ODF_NS_ALIASES) {
      throw new Error(
        `content.xml binds more than ${MAX_ODF_NS_ALIASES} namespace aliases to the ODF namespaces`,
      );
    }
    if (to !== m[1] && !canonicalByAlias.has(m[1])) canonicalByAlias.set(m[1], to);
  }
  if (canonicalByAlias.size === 0) return xml;
  // Longest-first so an alias that PREFIXES another (`t` vs `t2`) can never be
  // shadowed in the alternation; every alias is regex-escaped.
  const alternation = [...canonicalByAlias.keys()]
    .sort((a, b) => b.length - a.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // A prefix use is always preceded by `<`, `</`, or attribute-separating
  // whitespace — never by part of another name.
  const useRe = new RegExp(`([<\\s/])(${alternation}):`, 'g');
  return xml.replace(useRe, (_whole, before: string, alias: string) => `${before}${canonicalByAlias.get(alias)}:`);
}

/**
 * `content.xml` of an ODF package — namespace-prefix-normalized (see
 * `normalizeOdfPrefixes`) — or a typed could-not-parse failure message
 * (`kind` names the extension for the message, e.g. '.odt').
 *
 * Bounded: the entry's DECLARED uncompressed size is checked against
 * `MAX_DOC_PART_BYTES` (50 MB) before anything inflates, so a zip bomb is a
 * typed refusal, never an allocation.
 */
export function readOdfContentXml(
  bytes: Buffer,
  kind: '.odt' | '.odp' | '.ods',
): { ok: true; xml: string } | { ok: false; message: string } {
  try {
    const zip = new AdmZip(bytes);
    const entry = zip.getEntry('content.xml');
    if (!entry) {
      return { ok: false, message: `could not be parsed as a ${kind} (no content.xml inside the archive)` };
    }
    const oversize = zipEntryOversize(entry);
    if (oversize) return { ok: false, message: `could not be extracted as a ${kind} (${oversize})` };
    return { ok: true, xml: normalizeOdfPrefixes(entry.getData().toString('utf8')) };
  } catch (err) {
    return { ok: false, message: `could not be parsed as a ${kind} (${(err as Error).message})` };
  }
}

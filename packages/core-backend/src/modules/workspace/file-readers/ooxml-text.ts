/**
 * Minimal OOXML text helpers shared by the docx and pptx extractors.
 *
 * DELIBERATELY hand-rolled: the extractors only need "the character content of
 * `<w:t>`/`<a:t>` runs, grouped by paragraph" — a full XML parser dependency
 * would be a heavyweight addition for what a single linear scan does correctly
 * on WELL-FORMED OOXML (which a zip that Word/PowerPoint produced always is;
 * a malformed one fails parsing upstream at the zip layer or simply yields
 * fewer runs, never a crash).
 */
import type AdmZip from 'adm-zip';

/**
 * Decompression bounds for the document extractors (OOXML, ODF and — as a
 * plain byte cap — PDF). A zip's central directory declares each entry's
 * UNCOMPRESSED size, so a zip bomb (a few KB that inflate to gigabytes) is
 * detectable BEFORE any inflation happens; 50 MB of XML is far beyond any
 * real office document part (a huge deck's slide parts run to single-digit
 * MB) while staying well inside what a server can afford to decode.
 * `MAX_DOC_TOTAL_BYTES` additionally bounds the SUM of the parts a multi-part
 * extraction reads (pptx slides/notes, xlsx sheet parts) at 200 MB.
 */
export const MAX_DOC_PART_BYTES = 50 * 1024 * 1024; // 50 MB uncompressed, per part
export const MAX_DOC_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB uncompressed, per document

/**
 * The typed-failure fragment for a zip entry whose DECLARED uncompressed size
 * exceeds {@link MAX_DOC_PART_BYTES}, or null when the entry is within bounds.
 * Checked against the central-directory header BEFORE `getData()` inflates
 * anything, so an oversized (or bomb) entry costs nothing.
 */
export function zipEntryOversize(entry: AdmZip.IZipEntry): string | null {
  const size = entry.header.size;
  return size > MAX_DOC_PART_BYTES
    ? `${entry.entryName} is ${size} bytes uncompressed — over the ${MAX_DOC_PART_BYTES}-byte (50 MB) extraction limit`
    : null;
}

// (The quote-aware `TAG_ATTRS` regex fragment used to live here. Every reader
// that built a tag pattern from it — the email strip, the ODF paragraph, page,
// row and cell walks — now uses a single-pass scanner instead: lazily expanding
// that fragment re-scanned the rest of the document from every opener that
// failed to match, which turned a crafted upload into minutes of pinned CPU.
// See `htmlToEmailText` and `xmlElementBlocks`.)

/**
 * Regex FRAGMENT matching one XML NCName — the legal shape of a namespace
 * prefix. `\w` would be wrong here: XML names admit most of Unicode (letters,
 * combining marks, …), and a producer is free to bind a namespace to a
 * non-ASCII prefix — an ASCII-only prefix match would silently drop such
 * elements. Astral characters ride along as surrogate pairs so the fragment
 * works without the `u` flag.
 */
const NC_START =
  'A-Za-z_' +
  '\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D' +
  '\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD';
const NC_EXTRA = '0-9.\u00B7\u0300-\u036F\u203F-\u2040-'; // dash LAST: literal in the class, never a range
export const XML_NCNAME =
  `(?:[${NC_START}]|[\uD800-\uDB7F][\uDC00-\uDFFF])` +
  `(?:[${NC_START}${NC_EXTRA}]|[\uD800-\uDB7F][\uDC00-\uDFFF])*`;

/**
 * One tag's attributes as `name → raw value` tokens, in document order. A
 * real left-to-right tokenizer, not a regex probe: quoted values (either
 * quote style, whitespace around `=` tolerated) are skipped over WHOLE, so a
 * `target='…'`-looking sequence INSIDE another attribute's value can never
 * be mistaken for an attribute of its own. Values are RAW (entities not
 * decoded); a malformed tail (unterminated quote) simply ends the scan.
 */
export function xmlAttrTokens(tagXml: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  let i = 0;
  // Skip '<' (with an optional '/' or '?') and the tag name itself.
  if (tagXml[i] === '<') {
    i++;
    if (tagXml[i] === '/' || tagXml[i] === '?') i++;
  }
  while (i < tagXml.length && !/[\s/>]/.test(tagXml[i])) i++;
  while (i < tagXml.length) {
    while (i < tagXml.length && /[\s/]/.test(tagXml[i])) i++;
    if (i >= tagXml.length || tagXml[i] === '>') return out;
    const nameStart = i;
    while (i < tagXml.length && !/[\s=/>]/.test(tagXml[i])) i++;
    const name = tagXml.slice(nameStart, i);
    while (i < tagXml.length && /\s/.test(tagXml[i])) i++;
    if (tagXml[i] !== '=') continue; // no value (not legal XML) — skip the token
    i++;
    while (i < tagXml.length && /\s/.test(tagXml[i])) i++;
    const quote = tagXml[i];
    if (quote !== '"' && quote !== "'") return out; // unquoted/malformed — stop
    const valueStart = ++i;
    const end = tagXml.indexOf(quote, i);
    if (end === -1) return out; // unterminated quote — stop
    if (name !== '') out.push({ name, value: tagXml.slice(valueStart, end) });
    i = end + 1;
  }
  return out;
}

/**
 * The value of attribute `name` inside one tag's text, or undefined. Exact
 * (prefix-included) name match over the {@link xmlAttrTokens} scan — see there
 * for the quoting guarantees. The value is returned RAW (entities not
 * decoded); callers decode where display matters.
 */
export function xmlAttrValue(tagXml: string, name: string): string | undefined {
  for (const attr of xmlAttrTokens(tagXml)) {
    if (attr.name === name) return attr.value;
  }
  return undefined;
}

/**
 * Like {@link xmlAttrValue}, but matching the attribute's LOCAL name — the
 * part after any namespace prefix. For parsers that scan by local element
 * name (OPC `.rels` parts, whose producer is free to prefix the relationship
 * namespace) and must accept `r:Target` wherever `Target` is meant.
 */
export function xmlAttrValueByLocalName(tagXml: string, localName: string): string | undefined {
  for (const attr of xmlAttrTokens(tagXml)) {
    // `xmlns="…"` / `xmlns:Foo="…"` are namespace DECLARATIONS, not attributes
    // — under local-name matching, `xmlns:Target` would otherwise read as a
    // `Target` attribute and hand back a namespace URI.
    if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue;
    if (attr.name.slice(attr.name.lastIndexOf(':') + 1) === localName) return attr.value;
  }
  return undefined;
}

/**
 * Decode the five XML named entities plus numeric (`&#65;` / `&#x41;`)
 * references. Decimal references admit ONLY decimal digits and hex digits only
 * after `#x` — a malformed `&#12A;` must stay literal text, not be consumed
 * with `parseInt` silently stopping at the `A` and emitting U+000C.
 */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g, (whole, body: string) => {
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

/** One element found by {@link xmlElementBlocks}. */
export interface XmlElementBlock {
  /** The qualified name as written, e.g. `w:p` — which of `names` matched. */
  name: string;
  /** The attribute region verbatim (leading space included), '' when there is none. */
  attrs: string;
  /** The body between `>` and the matching close tag; undefined when self-closing. */
  body: string | undefined;
}

/**
 * Hoisted to module scope because {@link nameEndsAt} consults it once per `<`
 * in the part: a literal inside the loop allocates a fresh RegExp on every
 * evaluation, which on a real `word/document.xml` is tens of thousands of
 * throwaway objects per extraction.
 */
const NAME_SPACE = /\s/;

/**
 * Has the element name that began at `lt + 1` ENDED at `at`? What the regex's
 * `(?:\s[^>]*)?>` alternation decided, plus the self-closing shape.
 *
 * A `/` ends the name ONLY when it is the `/` of a `/>`. XML admits exactly
 * three continuations after a name — whitespace, `>`, or `/>` — so `<w:p/x>`
 * names no element the scan wants. Accepting a bare `/` read it as a `w:p`
 * OPENER instead, and everything up to the next `</w:p>` was extracted as
 * that paragraph's text; the same shape on `<w:t/x>` emitted the run body of
 * a tag that was never a run.
 */
function nameEndsAt(xml: string, at: number): boolean {
  const c = xml[at];
  if (c === undefined) return false; // the name runs to end-of-part: no tag
  if (c === '>') return true;
  if (c === '/') return xml[at + 1] === '>';
  return NAME_SPACE.test(c);
}

/**
 * How many `<` positions the tag-end memo may hold before {@link
 * xmlElementBlocks} gives the part up.
 *
 * The memo is what keeps the walk linear, but it costs an entry per `<` that
 * a tag scan passed OUTSIDE quotes — and a `<` inside a tag's attribute
 * region only ever occurs in MALFORMED XML (a real attribute value spells it
 * `&lt;`, and the one WELL-FORMED place a bare `<` may sit — a comment, a
 * CDATA section, a processing instruction — is skipped whole before any of
 * this, see {@link markupSectionEnd}), so on every document a producer wrote
 * the map stays EMPTY. A
 * crafted part does not: 50 MB of repeated `<w:p ` openers is 10.5 M entries,
 * measured at ~97 bytes apiece — a gigabyte of map to describe fifty
 * megabytes of input, in a server process or, through the browser twin, in
 * the user's tab.
 *
 * Past this bound the walk ABORTS and returns the elements found so far.
 * Evicting instead, or simply not memoizing further, would hand the quadratic
 * back — the very thing the memo exists to prevent — so the choice is between
 * stopping and rescanning, and a part this malformed has no text left worth
 * the CPU. 100 000 entries is ~8 MB of map and four orders of magnitude past
 * anything a real document reaches.
 */
const MAX_TAG_MEMO = 100_000;

/** {@link scanTagEnd}'s "the memo is full" answer — distinct from -1, "no `>`". */
const MEMO_EXHAUSTED = -2;

/**
 * Index of the `>` that ends the tag whose attribute region starts at `from`,
 * or -1 when the tag never terminates. Quote-aware, so a `>` or `/>` INSIDE a
 * quoted attribute value is part of the value and never the delimiter.
 *
 * Every `<` passed OUTSIDE quotes is memoized in `known` with THIS scan's
 * answer, whether that answer is a `>` or -1. Such a `<` was reached in the
 * no-quote state, and an element name holds no quote, `<` or `>` — so a tag
 * starting there resumes the identical character walk in the identical state
 * and can only reach the identical end. That memo is what keeps the whole
 * pass linear; it is the argument `email-text.ts`'s scanner rests on.
 *
 * Memoizing the SUCCESSES matters as much as the failures: a wall of openers
 * whose attribute scans all run to one far-away `>` — a close tag sitting
 * past the wall — terminates every scan successfully, so a failure-only memo
 * records nothing and the walk is quadratic all over again.
 *
 * Returns {@link MEMO_EXHAUSTED} rather than growing the memo past {@link
 * MAX_TAG_MEMO} entries — the caller stops there. The budget counts the
 * positions this scan is still holding as well as the ones already recorded,
 * so a single scan over a 50 MB wall cannot buffer ten million offsets before
 * the first `known.set`.
 */
function scanTagEnd(xml: string, from: number, known: Map<number, number>): number {
  let quote: '"' | "'" | null = null;
  const passedUnquoted: number[] = [];
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') {
      for (const p of passedUnquoted) known.set(p, i);
      return i;
    } else if (c === '<') {
      if (known.size + passedUnquoted.length >= MAX_TAG_MEMO) return MEMO_EXHAUSTED;
      passedUnquoted.push(i);
    }
  }
  for (const p of passedUnquoted) known.set(p, -1);
  return -1;
}

/**
 * The `<name …>…</name>` and self-closing `<name …/>` elements named by
 * `names`, in document order, treated as NON-NESTING (the first close tag
 * wins) — correct for `w:p`/`a:p` paragraphs, `w:t`/`a:t` runs, and `w:tr`
 * /`w:tc` in non-nested tables (a NESTED table's inner rows/cells terminate
 * the outer element early, which degrades cell grouping but never loses run
 * text), and for the ODF shapes `odf-text.ts` scans with it.
 *
 * A SINGLE-PASS scanner, not a regex, for the reason `email-text.ts` and the
 * ODF walks gave up theirs. The patterns this replaces —
 * `<w:p(?:\s[^>]*)?>([\s\S]*?)</w:p>` and its `a:p`, `w:tr`, `w:tc`, `w:t`
 * and `a:t` twins — re-scanned the rest of the part from EVERY opener whose
 * match failed, and `word/document.xml` / `ppt/slides/slideN.xml` are
 * user-supplied bytes up to `MAX_DOC_PART_BYTES` (50 MB). A crafted file of
 * unmatched `<w:p>` openers therefore cost O(openers x bytes): measured, a
 * 391 KB wall of them took 19.4 s and QUADRUPLED with every doubling of the
 * input — days of pinned CPU at the size cap, from a .docx/.pptx that zips
 * down to a few kilobytes.
 *
 * The scan bounds every way an opener can fail to become an element:
 *
 *  - an attribute scan memoizes its answer for every opener it passed
 *    unquoted (see `scanTagEnd`), so no position is rescanned from more than
 *    the possible quote states — whether that scan ended at a `>` or ran off
 *    the end;
 *  - a close tag is looked for only when one EXISTS at or after the search
 *    position — `lastIndexOf` per name, computed once — so a missing close tag
 *    costs one scan of the fragment in total, not one per opener.
 *
 * The memo itself is bounded — see {@link MAX_TAG_MEMO}: a part malformed
 * enough to fill it is ABANDONED with whatever elements were found, because
 * the only alternatives (evict, or stop memoizing) reinstate the quadratic.
 */
/**
 * The `<!-- … -->`, `<![CDATA[ … ]]>` and `<? … ?>` spans, whose insides are
 * TEXT to this scanner and never markup — paired with the opener they start
 * with.
 */
const MARKUP_SECTIONS: ReadonlyArray<readonly [open: string, close: string]> = [
  ['<!--', '-->'],
  ['<![CDATA[', ']]>'],
  ['<?', '?>'],
];

/**
 * Index just past the comment, CDATA section or processing instruction
 * starting at `lt`; -1 when it never closes; 0 when `lt` starts none of them.
 *
 * These are the one place a WELL-FORMED part may spell a bare `<` outside a
 * tag, and reading their insides as markup was wrong twice over: a commented
 * `<w:t>x</w:t>` was extracted as if it were live document text, and — because
 * every `<` in there was charged to the tag memo — a document carrying a large
 * enough comment could exhaust {@link MAX_TAG_MEMO} and abandon every
 * paragraph after it. A single `indexOf` per section, and the caller only ever
 * moves forward past it, so skipping costs one pass over the section.
 */
function markupSectionEnd(xml: string, lt: number): number {
  for (const [open, close] of MARKUP_SECTIONS) {
    if (!xml.startsWith(open, lt)) continue;
    const at = xml.indexOf(close, lt + open.length);
    return at === -1 ? -1 : at + close.length;
  }
  return 0;
}

/**
 * Every comment/CDATA/PI span in the fragment, in document order, as
 * `[start, endExclusive)` — an unterminated one running to the end.
 *
 * Built ONCE per walk, in one pass, because the obvious alternative is a trap:
 * asking "is there a section before this close tag?" with an `indexOf` per
 * element scans to the END OF THE PART and back for every paragraph of a
 * document that contains no sections at all — which is nearly every real
 * document — and that made ordinary extraction quadratic. Here each opener's
 * `indexOf` resumes past the last span it found, so the scans are disjoint and
 * the whole index costs one pass; a part with no sections leaves it empty and
 * every later lookup is a no-op.
 */
function sectionSpans(xml: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const next = MARKUP_SECTIONS.map(([open]) => xml.indexOf(open));
  for (;;) {
    let k = -1;
    for (let j = 0; j < next.length; j++) {
      if (next[j] !== -1 && (k === -1 || next[j] < next[k])) k = j;
    }
    if (k === -1) return spans;
    const end = markupSectionEnd(xml, next[k]);
    const stop = end === -1 ? xml.length : end;
    spans.push([next[k], stop]);
    // A section opener found INSIDE the span just taken (a `<!--` within a
    // CDATA, say) is not one — re-find each from past the span.
    for (let j = 0; j < next.length; j++) {
      if (next[j] !== -1 && next[j] < stop) next[j] = xml.indexOf(MARKUP_SECTIONS[j][0], stop);
    }
  }
}

/** Does a section cover `at`? Binary search over the sorted, disjoint spans. */
function sectionCovering(spans: ReadonlyArray<[number, number]>, at: number): [number, number] | undefined {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at < spans[mid][0]) hi = mid - 1;
    else if (at >= spans[mid][1]) lo = mid + 1;
    else return spans[mid];
  }
  return undefined;
}

/**
 * The `</name>` that really ends an element whose body starts at `from` — the
 * first one that does NOT sit inside a comment, CDATA section or processing
 * instruction — or -1 when the element has no such close.
 *
 * Skipping sections only at the OPENER end was half a rule: `<w:p>a<!-- </w:p>
 * -->b</w:p>` still ended at the commented close tag, truncating a paragraph
 * whose xml is perfectly well-formed and swallowing the rest as if it were
 * outside the element.
 *
 * Linear per call: each turn of the loop jumps past a whole section that
 * shadowed a close tag, so the `indexOf` scans never overlap. With no sections
 * in the part this is one `indexOf` and one lookup against an empty index —
 * exactly what the plain search cost before sections were understood at all.
 */
function closeOutsideSections(
  xml: string,
  close: string,
  from: number,
  spans: ReadonlyArray<[number, number]>,
): number {
  let at = from;
  for (;;) {
    const closeAt = xml.indexOf(close, at);
    if (closeAt === -1) return -1;
    const shadow = spans.length === 0 ? undefined : sectionCovering(spans, closeAt);
    if (shadow === undefined) return closeAt;
    at = shadow[1];
  }
}

export function xmlElementBlocks(xml: string, names: readonly string[]): XmlElementBlock[] {
  // Longest first, so a name that PREFIXES another can never shadow it.
  const wanted = [...names].sort((a, b) => b.length - a.length);
  // Names whose close tags are all shadowed by sections. Openers are met in
  // document order, so a name that has no usable close from HERE has none from
  // any later opener either — without this, each one would re-walk the tail.
  const noUsableClose = new Set<string>();
  // One pass, reused by every close search below — see `sectionSpans`.
  const spans = sectionSpans(xml);
  const lastClose = new Map<string, number>();
  const lastCloseIndex = (name: string): number => {
    let known = lastClose.get(name);
    if (known === undefined) {
      known = xml.lastIndexOf(`</${name}>`);
      lastClose.set(name, known);
    }
    return known;
  };
  // `<` position → index of the `>` that ends the tag starting there, or -1
  // for "never terminates". Stays EMPTY on a well-formed part, where every
  // tag is scanned once and immediately consumed; it only fills under the
  // crafted shapes that used to make this walk quadratic. See `scanTagEnd`.
  const known = new Map<number, number>();
  const out: XmlElementBlock[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    // Comments, CDATA and processing instructions are skipped WHOLE: their
    // insides are text, not elements (see `markupSectionEnd`). An unclosed one
    // runs to the end of the part, and nothing inside it is an element either.
    const section = markupSectionEnd(xml, lt);
    if (section !== 0) {
      if (section === -1) break;
      i = section;
      continue;
    }
    // The name check is what the regex's `(?:\s[^>]*)?>` alternation did: it
    // keeps `<w:pPr>` from counting as a `<w:p>`, and admits `/` only as the
    // `/` of a self-closing `/>` (see `nameEndsAt`). A plain loop rather than
    // `find`, so matching costs no closure per tag.
    let name: string | undefined;
    for (const candidate of wanted) {
      if (xml.startsWith(candidate, lt + 1) && nameEndsAt(xml, lt + 1 + candidate.length)) {
        name = candidate;
        break;
      }
    }
    if (name === undefined) {
      i = lt + 1;
      continue;
    }
    const attrsStart = lt + 1 + name.length;
    // Only positions a PREVIOUS scan passed over need the memo: `lt` marches
    // forward, so the loop never asks about the same `<` twice and this scan's
    // own answer is never looked up again. The `known.size` guard keeps the
    // well-formed path to no hash lookup at all.
    const memo = known.size > 0 ? known.get(lt) : undefined;
    const gt = memo !== undefined ? memo : scanTagEnd(xml, attrsStart, known);
    if (gt === MEMO_EXHAUSTED) break; // the part is past saving — see MAX_TAG_MEMO
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
    if (bodyStart > lastCloseIndex(name) || noUsableClose.has(name)) {
      i = lt + 1; // no `</name>` left in the fragment — this opener cannot match
      continue;
    }
    const close = `</${name}>`;
    const closeAt = closeOutsideSections(xml, close, bodyStart, spans);
    if (closeAt === -1) {
      // A close tag exists (the guard above says so) but every one of them is
      // inside a comment, CDATA section or PI — so none of them ends anything.
      noUsableClose.add(name);
      i = lt + 1;
      continue;
    }
    out.push({ name, attrs: xml.slice(attrsStart, gt), body: xml.slice(bodyStart, closeAt) });
    i = closeAt + close.length;
  }
  return out;
}

/**
 * The text of one OOXML paragraph: every `<w:t>`/`<a:t>` run's character
 * content, concatenated with NO separator — Word/PowerPoint split runs
 * mid-word on formatting boundaries, so any separator would break words apart.
 * `tag` is the run tag ('w:t' for docx, 'a:t' for pptx). A self-closing
 * `<w:t/>` is an empty run and contributes nothing, exactly as it did when
 * the pattern simply failed to match it.
 */
export function paragraphRunText(paragraphXml: string, tag: 'w:t' | 'a:t'): string {
  let out = '';
  for (const run of xmlElementBlocks(paragraphXml, [tag])) {
    if (run.body !== undefined) out += decodeXmlEntities(run.body);
  }
  return out;
}

/**
 * Split an XML fragment into its `<{tag}>…</{tag}>` blocks, in document order.
 * A self-closing `<{tag}/>` yields '' — an EMPTY block, which is what an empty
 * `<w:p/>` paragraph or `<w:tc/>` cell means. See {@link xmlElementBlocks} for
 * the non-nesting and quoting guarantees.
 */
export function xmlBlocks(xml: string, tag: string): string[] {
  return xmlElementBlocks(xml, [tag]).map((e) => e.body ?? '');
}

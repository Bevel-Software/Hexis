/**
 * XML text helpers shared by the docx, pptx and ODF extractors.
 *
 * The scanning here is `htmlparser2` in XML mode. It used to be hand-rolled,
 * on the reasoning that the extractors only need "the character content of
 * `<w:t>`/`<a:t>` runs, grouped by paragraph" and a parser dependency was
 * heavyweight for a single linear scan. That reasoning had one flaw: the input
 * is UPLOADED, so the scan has to be right about all of XML's lexical rules
 * and not merely the ones a well-formed document exercises. It was not — a `>`
 * inside a quoted attribute value, a `/` that ends a name only as part of
 * `/>`, a `</w:p>` written inside a comment or a CDATA section, a namespace
 * prefix outside ASCII — and the machinery each fix needed (a tag-end memo, a
 * section index, caps on both) grew defects of its own, twice worse than what
 * it was fixing. A parser knows those rules already.
 */
import { Parser } from 'htmlparser2';
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
 * Is `code` a character XML actually admits (the `Char` production)?
 *
 * Being inside Unicode's range is not enough: XML forbids NUL and the other
 * C0 controls, the surrogate halves, and U+FFFE/U+FFFF. `&#0;` and `&#xD800;`
 * used to decode anyway, putting a character into extracted text that no XML
 * document can contain — and, for a lone surrogate, one that cannot even be
 * encoded. Such a reference stays literal instead.
 */
function isXmlChar(code: number): boolean {
  if (!Number.isFinite(code)) return false;
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
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
        return isXmlChar(code) ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

/** One element found by {@link xmlElementBlocks}. */
/** One element found by {@link xmlElementBlocks}. */
export interface XmlElementBlock {
  /** The qualified name as written, e.g. `w:p` — which of `names` matched. */
  name: string;
  /** The element's attributes. Values are RAW (entities not decoded). */
  attributes: Record<string, string>;
  /** The body between `>` and the matching close tag; undefined when self-closing. */
  body: string | undefined;
  /** Index of the element's opening `<` in the scanned string. */
  start: number;
  /** One past the element's final `>` (as far as the parse got, for a block cut short by the depth cap). */
  end: number;
}

/**
 * How deep the element stack may go before a part is given up on.
 *
 * Real office XML nests a few dozen levels. A crafted part can nest as deep as
 * it has bytes, and the parser's own cost climbs faster than linearly once the
 * stack is enormous: measured on unclosed `<a:p>` openers, 40 k deep took
 * 136 ms and 80 k took 2.7 s. A 50 MB part could spell millions. So the depth
 * is bounded far above any real document and far below where that curve bites.
 *
 * On reaching it the parse stops and what was found is returned — including
 * the element still open, whose body is taken as far as the parse got, so a
 * paragraph holding real text before the crafted tail still yields that text.
 */
export const MAX_ELEMENT_DEPTH = 1_000;

/**
 * Thrown to stop the parse at {@link MAX_ELEMENT_DEPTH}; never escapes an
 * extractor (also shared by `email-text.ts`'s HTML strip).
 */
export const TOO_DEEP = Symbol('too deep');

/** Thrown to stop the scan when a `visit` callback returns true; never escapes. */
const STOP_SCAN = Symbol('stop scan');

/** The match currently being collected by {@link xmlElementBlocks}. */
interface OpenMatch {
  name: string;
  attributes: Record<string, string>;
  depth: number;
  /** Index of the open tag's `<`. */
  start: number;
  /** Index of the `>` that ends the open tag — the body starts one past it. */
  tagEnd: number;
}

/**
 * The `<name …>…</name>` and self-closing `<name …/>` elements named by
 * `names`, in document order, at ANY depth — but never descending into a
 * match, since a match nested inside another is part of that one's body
 * rather than a block of its own.
 *
 * Parsing is `htmlparser2` in XML mode, which is the point of this function.
 * What stood here before was a hand-rolled scanner, and the lexical rules it
 * had to know kept turning out to be one rule short: a `>` inside a quoted
 * attribute value, a `/` that only ends a name as part of `/>`, a `</w:p>`
 * written inside a comment or a CDATA section, a namespace prefix outside
 * ASCII. Each gap was a real defect, several were reachable from an uploaded
 * file, and the fixes needed their own bookkeeping — a tag-end memo, a section
 * index, caps on both — which then had defects of their own. All of that is
 * the parser's job here, and it is code with far more mileage than ours.
 *
 * Bodies are RAW slices of `xml` (entities not decoded), because the callers
 * re-scan them for nested elements and decode only the text they keep.
 */
/** The part of a qualified XML name after its namespace prefix. */
export function localName(qualified: string): string {
  return qualified.slice(qualified.lastIndexOf(':') + 1);
}

/**
 * The value of the attribute whose LOCAL name is `want`, or undefined.
 * Namespace DECLARATIONS are not attributes and never answer for one.
 */
export function attrByLocalName(
  attributes: Record<string, string>,
  want: string,
): string | undefined {
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
    if (localName(key) === want) return value;
  }
  return undefined;
}

/**
 * {@link xmlElementBlocks}, matching each element's LOCAL name instead of the
 * qualified one — `p` finds `<w:p>`, `<a:p>` and an unprefixed `<p>` alike.
 *
 * Prefixes are a document's own choice: XML binds them to namespace URIs, and
 * a producer may bind any prefix it likes or default the namespace and use
 * none. Naming `a:p` or `text:p` literally therefore read only the documents
 * whose authors happened to pick the usual prefix — a valid deck using `d:p`
 * for DrawingML extracted as EMPTY, and an ODT that defaulted the text
 * namespace found no paragraphs at all. Matching the local name reads both,
 * and replaces the prefix-rewriting pass the ODF readers used to run over
 * every document to paper over the same problem.
 */
export function localElementBlocks(xml: string, localNames: readonly string[]): XmlElementBlock[] {
  const wanted = new Set(localNames);
  return xmlElementBlocks(xml, wanted, (name) => wanted.has(localName(name)));
}

/**
 * {@link localElementBlocks} as a WALK: `visit` receives each element as its
 * close tag is reached, and returning true STOPS the scan — the input past
 * that element is never parsed and no block is materialized beyond it. For
 * callers with a cap (the ods row walk): collecting every block into an array
 * before consulting the cap let an accepted document allocate its whole
 * expansion first.
 */
export function walkLocalElementBlocks(
  xml: string,
  localNames: readonly string[],
  visit: (block: XmlElementBlock) => boolean | void,
): void {
  const wanted = new Set(localNames);
  xmlElementBlocks(xml, wanted, (name) => wanted.has(localName(name)), visit);
}

/**
 * `xml` with every element named by `localNames` (matched on its LOCAL name)
 * removed WHOLE — open tag through matching close tag — by the parsed block
 * boundaries. The structural counterpart to string replacement, which deleted
 * every occurrence of a block's serialized BODY: a slide whose visible text
 * happened to serialize identically to its notes lost that text too.
 */
export function removeLocalElements(xml: string, localNames: readonly string[]): string {
  const blocks = localElementBlocks(xml, localNames);
  if (blocks.length === 0) return xml;
  let out = '';
  let at = 0;
  // Blocks arrive in document order and never overlap (the scan does not
  // descend into a match); the max() is belt and braces.
  for (const { start, end } of blocks) {
    out += xml.slice(at, Math.max(at, start));
    at = Math.max(at, end);
  }
  return out + xml.slice(at);
}

export function xmlElementBlocks(
  xml: string,
  names: Iterable<string>,
  /** Overrides name matching — {@link localElementBlocks} matches local names with it. */
  matches?: (name: string) => boolean,
  /**
   * Streaming hook — see {@link walkLocalElementBlocks}. When given, each
   * block is handed to it INSTEAD of being accumulated (the return value is
   * then an empty array), and returning true stops the scan.
   */
  visit?: (block: XmlElementBlock) => boolean | void,
): XmlElementBlock[] {
  const wanted = new Set(names);
  const isWanted = matches ?? ((name: string): boolean => wanted.has(name));
  const out: XmlElementBlock[] = [];
  /** Hand a completed block over; true means the visitor asked to stop. */
  const emit = (block: XmlElementBlock): boolean => {
    if (visit !== undefined) return visit(block) === true;
    out.push(block);
    return false;
  };
  let depth = 0;
  let open: OpenMatch | null = null;
  const parser: Parser = new Parser(
    {
      onopentag(name, attributes) {
        depth++;
        if (open === null && isWanted(name)) {
          open = { name, attributes, depth, start: parser.startIndex, tagEnd: parser.endIndex };
        }
        if (depth > MAX_ELEMENT_DEPTH) throw TOO_DEEP;
      },
      onclosetag(name) {
        if (open !== null && depth === open.depth && name === open.name) {
          // A self-closing `<w:p/>` reports its close on the SAME token as its
          // open tag; anything else — including the close the parser implies
          // for an element left open at end of input — ends further on.
          const selfClosing = parser.endIndex === open.tagEnd;
          const stop = emit({
            name,
            attributes: open.attributes,
            body: selfClosing ? undefined : xml.slice(open.tagEnd + 1, parser.startIndex),
            start: open.start,
            end: parser.endIndex + 1,
          });
          open = null;
          if (stop) throw STOP_SCAN;
        }
        depth--;
      },
    },
    { xmlMode: true, decodeEntities: false },
  );
  try {
    parser.write(xml);
    parser.end();
  } catch (err) {
    if (err !== TOO_DEEP && err !== STOP_SCAN) throw err;
    // On the depth bound, the element still open keeps the body it had
    // reached — the text before the crafted tail is real and there is no
    // reason to discard it. (Read through an alias: the assignments happen
    // inside the parser's callbacks, which control-flow analysis cannot see
    // from here.) A STOP is the visitor's own choice mid-document, so nothing
    // is pending by construction (the throw follows a completed block).
    const pending = open as OpenMatch | null;
    if (err === TOO_DEEP && pending !== null) {
      emit({
        name: pending.name,
        attributes: pending.attributes,
        body: xml.slice(pending.tagEnd + 1, parser.startIndex),
        start: pending.start,
        end: parser.startIndex,
      });
    }
    parser.reset(); // drop the stack this part built before giving up on it
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
export function paragraphRunText(paragraphXml: string, localTag: string): string {
  let out = '';
  let inRun = 0;
  let inCdata = false;
  let depth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        depth++;
        if (localName(name) === localTag) inRun++;
        if (depth > MAX_ELEMENT_DEPTH) throw TOO_DEEP;
      },
      // TEXT, never the raw body: a run's body is markup as well as characters
      // when the part is malformed enough to nest runs, and slicing it wholesale
      // put `<w:t xml:space="preserve">` into the document's extracted text.
      //
      // Entities decode through the module's STRICT decoder, not the parser's:
      // the parser turns a numeric reference outside XML's `Char` production
      // (`&#0;`, a lone surrogate) into replacement/control characters, where
      // `decodeXmlEntities` keeps such a reference literal. CDATA text is
      // already literal and must not decode at all.
      ontext(text) {
        if (inRun > 0) out += inCdata ? text : decodeXmlEntities(text);
      },
      oncdatastart() {
        inCdata = true;
      },
      oncdataend() {
        inCdata = false;
      },
      onclosetag(name) {
        if (localName(name) === localTag && inRun > 0) inRun--;
        depth--;
      },
    },
    { xmlMode: true, decodeEntities: false },
  );
  try {
    parser.write(paragraphXml);
    parser.end();
  } catch (err) {
    if (err !== TOO_DEEP) throw err;
    parser.reset();
  }
  return out;
}

/**
 * Split an XML fragment into its `<{tag}>…</{tag}>` blocks, in document order.
 * A self-closing `<{tag}/>` yields '' — an EMPTY block, which is what an empty
 * `<w:p/>` paragraph or `<w:tc/>` cell means. See {@link xmlElementBlocks} for
 * the non-nesting and quoting guarantees.
 */
/** {@link xmlBlocks} by LOCAL name — see {@link localElementBlocks} for why. */
export function localBlocks(xml: string, local: string): string[] {
  return localElementBlocks(xml, [local]).map((e) => e.body ?? '');
}

export function xmlBlocks(xml: string, tag: string): string[] {
  return xmlElementBlocks(xml, [tag]).map((e) => e.body ?? '');
}

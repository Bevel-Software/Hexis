/**
 * Minimal OOXML text helpers shared by the docx and pptx extractors.
 *
 * DELIBERATELY hand-rolled: the extractors only need "the character content of
 * `<w:t>`/`<a:t>` runs, grouped by paragraph" — a full XML parser dependency
 * would be a heavyweight addition for what a linear regex scan does correctly
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
// See `htmlToEmailText` and `odfElementBlocks`.)

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

/**
 * The text of one OOXML paragraph: every `<w:t>`/`<a:t>` run's character
 * content, concatenated with NO separator — Word/PowerPoint split runs
 * mid-word on formatting boundaries, so any separator would break words apart.
 * `tag` is the run tag ('w:t' for docx, 'a:t' for pptx).
 */
export function paragraphRunText(paragraphXml: string, tag: 'w:t' | 'a:t'): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraphXml)) !== null) out += decodeXmlEntities(m[1]);
  return out;
}

/**
 * Split an XML fragment into its `<{tag}>…</{tag}>` blocks (non-greedy, no
 * nesting — correct for `w:p`/`a:p` paragraphs and `w:tr`/`w:tc` in
 * non-nested tables; a NESTED table's inner rows/cells terminate the outer
 * match early, which degrades cell grouping but never loses run text).
 */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

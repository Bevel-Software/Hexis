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

/**
 * The value of attribute `name` inside one tag's text, or undefined. Accepts
 * single- OR double-quoted values and whitespace around the `=` — all legal
 * XML that a producer other than Word/LibreOffice may emit. The value is
 * returned RAW (entities not decoded); callers decode where display matters.
 */
export function xmlAttrValue(tagXml: string, name: string): string | undefined {
  const re = new RegExp(`(?<![\\w:.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(tagXml);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** Decode the five XML named entities plus numeric (`&#65;` / `&#x41;`) references. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (whole, body: string) => {
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
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
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

import AdmZip from 'adm-zip';
import { decodeXmlEntities } from './ooxml-text.js';

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
      const c = /text:c="(\d+)"/.exec(m[0]);
      const count = c ? parseInt(c[1], 10) : 1;
      // A count is bounded defensively — a corrupt attribute must not balloon the extraction.
      out += ' '.repeat(Math.min(Math.max(count, 0), 1000));
    }
  }
  return out + decodeXmlEntities(paragraphXml.slice(last));
}

/**
 * The `<text:p>` / `<text:h>` paragraph bodies of an XML fragment, in DOCUMENT
 * order (headings interleaved with paragraphs, as written). Self-closing
 * elements (`<text:p/>`, an empty paragraph) yield ''. The lookahead keeps
 * `<text:page-number>` and friends from counting as paragraphs; non-greedy
 * close is correct because ODF paragraphs cannot nest.
 */
export function odfParagraphBlocks(xml: string): string[] {
  const re = /<text:(p|h)(?=[\s/>])(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/text:\1>)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[2] ?? '');
  return out;
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
 * `content.xml` of an ODF package, or a typed could-not-parse failure message
 * (`kind` names the extension for the message, e.g. '.odt').
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
    return { ok: true, xml: entry.getData().toString('utf8') };
  } catch (err) {
    return { ok: false, message: `could not be parsed as a ${kind} (${(err as Error).message})` };
  }
}

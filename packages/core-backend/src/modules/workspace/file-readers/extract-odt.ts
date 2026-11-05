import type { ExtractResult } from './doc-extract.types.js';
import { localBlocks, removeLocalElements } from './ooxml-text.js';
import { odfParagraphBlocks, odfParagraphText, readOdfContentXml } from './odf-text.js';

/**
 * Extract the BODY text of a `.odt` (OpenDocument Text) document.
 *
 * An odt is a zip whose main part is `content.xml`; the body lives under
 * `<office:text>`. Headers/footers are skipped like docx — in ODF they live in
 * `styles.xml`, which is never opened, so reading `content.xml` alone IS the
 * body-only extraction.
 *
 * Paragraphs (`<text:p>`) and headings (`<text:h>`, heading text as its own
 * line) become lines in document order; `<text:span>` runs inside concatenate
 * with NO separator, and the ODF whitespace elements (`<text:tab/>`,
 * `<text:line-break/>`, `<text:s text:c="N"/>`) render as real characters —
 * see `odfParagraphText`.
 */
export function extractOdt(bytes: Buffer): ExtractResult {
  const content = readOdfContentXml(bytes, '.odt');
  if (!content.ok) return content;

  // Table cells contain their own <text:p>, so the flat paragraph scan renders
  // table text too (one line per cell paragraph, like the raw document order).
  // The text BODY, read by the parser and matched on its LOCAL name: a
  // comment mentioning `</office:text>` used to terminate the body early and
  // drop every paragraph after it, and an ODT binding the office namespace to
  // another prefix had no body at all.
  const body = localBlocks(content.xml, 'text')[0] ?? content.xml;

  // Tracked-change bookkeeping is not body text: `<text:tracked-changes>`
  // stores every DELETION's content as ordinary paragraphs, so the flat scan
  // below would read deleted text back in as document lines. Removed by its
  // parsed element boundaries before the paragraph walk.
  // `<office:annotation>` is a COMMENT on the document, stored as ordinary
  // paragraphs: read flat, a reviewer's note came back as a document line.
  const visible = removeLocalElements(body, ['tracked-changes', 'annotation']);

  const lines = odfParagraphBlocks(visible).map(odfParagraphText);
  const paragraphs = lines.length;
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  return {
    ok: true,
    summary: `${paragraphs} paragraph${paragraphs === 1 ? '' : 's'}; layout, images and formatting omitted`,
    text: lines.join('\n'),
  };
}

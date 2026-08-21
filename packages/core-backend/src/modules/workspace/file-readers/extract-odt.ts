import type { ExtractResult } from './doc-extract.types.js';
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
  const bodyMatch = /<office:text(?:\s[^>]*)?>([\s\S]*?)<\/office:text>/.exec(content.xml);
  const body = bodyMatch ? bodyMatch[1] : content.xml;

  const lines = odfParagraphBlocks(body).map(odfParagraphText);
  const paragraphs = lines.length;
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  return {
    ok: true,
    summary: `${paragraphs} paragraph${paragraphs === 1 ? '' : 's'}; layout, images and formatting omitted`,
    text: lines.join('\n'),
  };
}

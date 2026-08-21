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

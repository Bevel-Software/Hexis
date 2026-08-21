import AdmZip from 'adm-zip';
import type { ExtractResult } from './doc-extract.types.js';
import { localBlocks, localElementBlocks, localName, paragraphRunText, zipEntryOversize } from './ooxml-text.js';

/**
 * Extract the BODY text of a `.docx` (Word) document.
 *
 * A docx is a zip whose main part is `word/document.xml`. v1 extracts the body
 * only — headers/footers are skipped, and the marker summary says so.
 *
 *  - Paragraphs become lines. `<w:t>` runs are concatenated with NO separator
 *    (Word splits runs mid-word on formatting boundaries).
 *  - Tables become lines with cell text tab-separated, one line per row.
 */
export function extractDocx(bytes: Buffer): ExtractResult {
  let xml: string;
  try {
    const zip = new AdmZip(bytes);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) {
      return { ok: false, message: 'could not be parsed as a .docx (no word/document.xml inside the archive)' };
    }
    // Declared-uncompressed-size bound BEFORE inflation — see zipEntryOversize.
    const oversize = zipEntryOversize(entry);
    if (oversize) return { ok: false, message: `could not be extracted as a .docx (${oversize})` };
    xml = entry.getData().toString('utf8');
  } catch (err) {
    return { ok: false, message: `could not be parsed as a .docx (${(err as Error).message})` };
  }

  // The BODY element read by the parser rather than matched by a regex: a
  // comment or CDATA section mentioning `<w:body>` could answer as the
  // document body and hand back its text instead of the real one.
  const body = localBlocks(xml, 'body')[0] ?? xml;

  const lines: string[] = [];
  let paragraphs = 0;
  let tables = 0;
  // Tables and paragraphs in DOCUMENT order, straight from the parser: a match
  // is never descended into, so a table's own paragraphs stay inside it and are
  // rendered once, as its rows. The hand-rolled splitter this replaces counted
  // `<w:tbl>` opens and closes with a regex, which a comment or CDATA section
  // mentioning either could throw off — splitting a paragraph in half and
  // dropping its text.
  for (const block of localElementBlocks(body, ['tbl', 'p'])) {
    if (localName(block.name) === 'tbl') {
      tables++;
      for (const row of localBlocks(block.body ?? '', 'tr')) {
        const cells = localBlocks(row, 'tc').map((cell) => paragraphRunText(cell, 't'));
        lines.push(cells.join('	'));
      }
    } else {
      lines.push(paragraphRunText(block.body ?? '', 't'));
      paragraphs++;
    }
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const parts = [`${paragraphs} paragraph${paragraphs === 1 ? '' : 's'}`];
  if (tables > 0) parts.push(`${tables} table${tables === 1 ? '' : 's'}`);
  return {
    ok: true,
    summary: `${parts.join(' + ')}; body only (headers/footers skipped); layout, images and formatting omitted`,
    text: lines.join('\n'),
  };
}


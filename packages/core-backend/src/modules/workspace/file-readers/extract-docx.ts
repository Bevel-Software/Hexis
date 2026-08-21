import AdmZip from 'adm-zip';
import type { ExtractResult } from './doc-extract.types.js';
import { paragraphRunText, xmlBlocks, zipEntryOversize } from './ooxml-text.js';

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

  const bodyMatch = /<w:body(?:\s[^>]*)?>([\s\S]*?)<\/w:body>/.exec(xml);
  const body = bodyMatch ? bodyMatch[1] : xml;

  const lines: string[] = [];
  let paragraphs = 0;
  let tables = 0;
  for (const block of splitDocxBlocks(body)) {
    if (block.kind === 'table') {
      tables++;
      for (const row of xmlBlocks(block.xml, 'w:tr')) {
        const cells = xmlBlocks(row, 'w:tc').map((cell) => paragraphRunText(cell, 'w:t'));
        lines.push(cells.join('\t'));
      }
    } else {
      for (const p of xmlBlocks(block.xml, 'w:p')) {
        lines.push(paragraphRunText(p, 'w:t'));
        paragraphs++;
      }
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

/**
 * Split the document body into alternating text / table blocks, so table
 * paragraphs are rendered as tab-separated rows exactly once (not again as
 * free paragraphs). The table close is matched with DEPTH counting, so a
 * nested table stays inside its outer block.
 */
function splitDocxBlocks(body: string): Array<{ kind: 'text' | 'table'; xml: string }> {
  const blocks: Array<{ kind: 'text' | 'table'; xml: string }> = [];
  // `(?=[\s>])` keeps `<w:tblPr>` / `<w:tblGrid>` from counting as table opens.
  const openRe = /<w:tbl(?=[\s>])/g;
  const tokenRe = /<w:tbl(?=[\s>])|<\/w:tbl>/g;
  let pos = 0;
  for (;;) {
    openRe.lastIndex = pos;
    const open = openRe.exec(body);
    if (!open) {
      if (pos < body.length) blocks.push({ kind: 'text', xml: body.slice(pos) });
      return blocks;
    }
    if (open.index > pos) blocks.push({ kind: 'text', xml: body.slice(pos, open.index) });
    tokenRe.lastIndex = open.index;
    let depth = 0;
    let end = body.length;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(body)) !== null) {
      depth += token[0] === '</w:tbl>' ? -1 : 1;
      if (depth === 0) {
        end = tokenRe.lastIndex;
        break;
      }
    }
    blocks.push({ kind: 'table', xml: body.slice(open.index, end) });
    pos = end;
  }
}

import type { ExtractResult } from './doc-extract.types.js';
import {
  attrByLocalName,
  decodeXmlEntities,
  localElementBlocks,
  localName,
  walkLocalElementBlocks,
} from './ooxml-text.js';
import {
  odfParagraphBlocks,
  odfParagraphText,
  readOdfContentXml,
} from './odf-text.js';

/**
 * Per-sheet extraction caps — the SAME bounds as the xlsx extractor. ODF is
 * fond of `table:number-columns-repeated="16384"` (or a million empty trailing
 * rows) to pad a sheet to the grid, so repeats are expanded BOUNDED and the
 * extraction says when it truncated (a `[sheet truncated …]` line right under
 * the sheet marker). Trailing EMPTY cells/rows are trimmed before their
 * repeats are applied at all, so grid padding never counts as truncation.
 */
const MAX_ROWS_PER_SHEET = 10_000;
const MAX_COLS_PER_SHEET = 200;

/**
 * Extract a `.ods` (OpenDocument Spreadsheet) workbook: per `<table:table>`
 * (sheet) a `[sheet: Name]` marker (the `table:name` attribute), then the rows
 * as tab-separated cell text. A cell's text is its `<text:p>` content
 * (multiple paragraphs join with a space — a newline would break the row
 * line); covered cells (under a merge) render empty.
 */
export function extractOds(bytes: Buffer): ExtractResult {
  const content = readOdfContentXml(bytes, '.ods');
  if (!content.ok) return content;

  const tables = tableBlocks(content.xml);
  if (tables.length === 0) {
    return { ok: false, message: 'could not be parsed as a .ods (no table:table elements in content.xml)' };
  }

  const lines: string[] = [];
  for (const table of tables) {
    lines.push(`[sheet: ${table.name}]`);
    const { rows, truncated } = expandRows(table.xml);
    if (truncated.length > 0) lines.push(`[sheet truncated to the ${truncated.join(' and ')}]`);
    lines.push(...rows.map((cells) => cells.join('\t')));
  }
  return {
    ok: true,
    summary: `${tables.length} sheet${tables.length === 1 ? '' : 's'}, rows as tab-separated values; formulas, formatting and charts omitted`,
    text: lines.join('\n'),
  };
}

/**
 * The `<table:table>` blocks with their decoded `table:name`, in document
 * order. Non-greedy close — a nested table (legal in ODF text documents, not
 * produced by spreadsheets) would end the outer block early, degrading
 * grouping but never crashing.
 */
function tableBlocks(xml: string): Array<{ name: string; xml: string }> {
  // Read by the parser and matched on the LOCAL name: a comment or CDATA
  // section holding a table-looking fragment used to answer as a real sheet,
  // and a document binding the table namespace to another prefix had none.
  const out: Array<{ name: string; xml: string }> = [];
  for (const table of localElementBlocks(xml, ['table'])) {
    const raw = attrByLocalName(table.attributes, 'name');
    out.push({
      // Control separators become spaces: a name holding an encoded newline
      // or tab (`&#10;`) would corrupt the `[sheet: …]` marker's own line and
      // the TSV structure under it.
      name: raw ? decodeXmlEntities(raw).replace(/[\t\n\r]+/g, ' ') : `Sheet${out.length + 1}`,
      xml: table.body ?? '',
    });
  }
  return out;
}

/**
 * Expand a sheet's rows with BOUNDED repeat handling, INCREMENTALLY — a row's
 * expansion lands in the capped output as it parses, so the caps bound memory
 * as well as output (materializing every row's cells before consulting the
 * cap let an accepted ODS allocate its whole expansion first):
 *
 *  - all-empty rows are buffered as a COUNT (with their
 *    `table:number-rows-repeated` applied) and flushed only when a non-empty
 *    row follows, so a million-row empty tail simply disappears,
 *  - once the row cap is hit, the remaining rows are never parsed at all.
 *
 * `truncated` lists what the caps cut (mirrors the xlsx extractor's note).
 */
function expandRows(tableXml: string): { rows: string[][]; truncated: string[] } {
  // The shared quote-aware scanner as a WALK, not an array: materializing
  // every row block before consulting the cap let a sheet of >10k explicit
  // rows allocate them all first. Each row lands here as it parses, and the
  // visitor's `true` stops the scan at the cap — a self-closing row WITH
  // attributes is still a row, a `/>` inside a quoted attribute value is not
  // a delimiter, and an UNCLOSED row costs one scan of the sheet rather than
  // one per opener (see `xmlElementBlocks`).
  const rows: string[][] = [];
  let pendingEmpty = 0;
  let rowsTruncated = false;
  let colsTruncated = false;
  walkLocalElementBlocks(tableXml, ['table-row'], (row) => {
    const repeat = repeatCount(attrByLocalName(row.attributes, 'number-rows-repeated'));
    const cells = expandCells(row.body ?? '');
    if (cells.cells.length === 0) {
      // Empty rows are interior padding until a non-empty row proves it —
      // trailing ones are dropped with their repeats (grid padding, not data).
      pendingEmpty += repeat;
      return false;
    }
    if (cells.truncated) colsTruncated = true;
    for (; pendingEmpty > 0 && rows.length < MAX_ROWS_PER_SHEET; pendingEmpty--) rows.push([]);
    let i = 0;
    for (; i < repeat && rows.length < MAX_ROWS_PER_SHEET; i++) rows.push(cells.cells);
    if (pendingEmpty > 0 || i < repeat) {
      // The cap cut real content (a sheet that merely FILLS it is not truncated).
      rowsTruncated = true;
      return true;
    }
    return false;
  });
  const truncated: string[] = [];
  if (rowsTruncated) truncated.push(`first ${MAX_ROWS_PER_SHEET} rows`);
  if (colsTruncated) truncated.push(`first ${MAX_COLS_PER_SHEET} columns`);
  return { rows, truncated };
}

/**
 * One row's cell texts: `<table:table-cell>` / `<table:covered-table-cell>`
 * in order, expanded INCREMENTALLY like the rows above — trailing EMPTY cells
 * are buffered as a count (their `table:number-columns-repeated` never
 * expands) and the parse stops at the column cap.
 */
function expandCells(rowXml: string): { cells: string[]; truncated: boolean } {
  // Same walking scanner as the rows above — a row spelling a million
  // explicit cells stops parsing at the column cap too.
  const cells: string[] = [];
  let pendingEmpty = 0;
  let truncated = false;
  walkLocalElementBlocks(rowXml, ['table-cell', 'covered-table-cell'], (cell) => {
    const repeat = repeatCount(attrByLocalName(cell.attributes, 'number-columns-repeated'));
    // Covered cells carry no own text anyway. Element-produced newlines/tabs
    // INSIDE a cell (<text:line-break/>, <text:tab/>) become single spaces:
    // the extraction's contract is one row per line with tab-separated cells,
    // and a literal \n or \t inside a cell's text would silently break both.
    // A COVERED cell is the hidden half of a merge: the visible cell carries
    // the text. Such a cell may still hold stale content, and emitting it put
    // a value in the grid where the sheet shows none.
    const text = localName(cell.name) === 'covered-table-cell'
      ? ''
      : odfParagraphBlocks(cell.body ?? '')
          .map(odfParagraphText)
          .join(' ')
          .replace(/[\t\n\r]+/g, ' ');
    if (text === '') {
      pendingEmpty += repeat;
      return false;
    }
    for (; pendingEmpty > 0 && cells.length < MAX_COLS_PER_SHEET; pendingEmpty--) cells.push('');
    let i = 0;
    for (; i < repeat && cells.length < MAX_COLS_PER_SHEET; i++) cells.push(text);
    if (pendingEmpty > 0 || i < repeat) {
      // The cap cut real content (a row that merely FILLS it is not truncated).
      truncated = true;
      return true;
    }
    return false;
  });
  return { cells, truncated };
}

/** A `…-repeated="N"` attribute value, clamped to a sane positive integer. */
function repeatCount(raw: string | undefined): number {
  // Decoded first: the block scanner hands attribute values RAW, and a repeat
  // legally written with character references (`&#49;&#48;`) must count as
  // 10, not silently fall back to 1.
  const n = raw !== undefined ? parseInt(decodeXmlEntities(raw), 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

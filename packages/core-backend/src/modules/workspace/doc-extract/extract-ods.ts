import type { ExtractResult } from './doc-extract.types.js';
import { decodeXmlEntities } from './ooxml-text.js';
import { odfParagraphBlocks, odfParagraphText, readOdfContentXml } from './odf-text.js';

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
  const re = /<table:table(?=[\s>])((?:\s[^>]*)?)>([\s\S]*?)<\/table:table>/g;
  const out: Array<{ name: string; xml: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = /table:name="([^"]*)"/.exec(m[1])?.[1];
    out.push({ name: name ? decodeXmlEntities(name) : `Sheet${out.length + 1}`, xml: m[2] });
  }
  return out;
}

/** One parsed (not yet repeat-expanded) unit: the content + its repeat count. */
interface Repeated<T> {
  value: T;
  repeat: number;
}

/**
 * Expand a sheet's rows with BOUNDED repeat handling:
 *
 *  1. parse every row into its trailing-trimmed cell texts (columns already
 *     capped, per row),
 *  2. TRIM trailing all-empty rows — before their `table:number-rows-repeated`
 *     is ever applied, so a million-row empty tail simply disappears,
 *  3. expand the remaining row repeats up to the row cap.
 *
 * `truncated` lists what the caps cut (mirrors the xlsx extractor's note).
 */
function expandRows(tableXml: string): { rows: string[][]; truncated: string[] } {
  const rowRe = /<table:table-row(?=[\s/>])((?:\s[^>]*)?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
  const parsed: Repeated<string[]>[] = [];
  let colsTruncated = false;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(tableXml)) !== null) {
    const cells = expandCells(m[2] ?? '');
    if (cells.truncated) colsTruncated = true;
    parsed.push({ value: cells.cells, repeat: repeatCount(m[1], 'table:number-rows-repeated') });
  }
  // Trailing empty rows: dropped with their repeats (grid padding, not data).
  while (parsed.length > 0 && parsed[parsed.length - 1].value.length === 0) parsed.pop();

  const rows: string[][] = [];
  let rowsTruncated = false;
  for (const { value, repeat } of parsed) {
    for (let i = 0; i < repeat; i++) {
      if (rows.length >= MAX_ROWS_PER_SHEET) {
        rowsTruncated = true;
        break;
      }
      rows.push(value);
    }
    if (rowsTruncated) break;
  }
  const truncated: string[] = [];
  if (rowsTruncated) truncated.push(`first ${MAX_ROWS_PER_SHEET} rows`);
  if (colsTruncated) truncated.push(`first ${MAX_COLS_PER_SHEET} columns`);
  return { rows, truncated };
}

/**
 * One row's cell texts: `<table:table-cell>` / `<table:covered-table-cell>`
 * in order, trailing EMPTY cells trimmed before `table:number-columns-repeated`
 * is applied, then repeats expanded up to the column cap.
 */
function expandCells(rowXml: string): { cells: string[]; truncated: boolean } {
  const cellRe = /<table:(table-cell|covered-table-cell)(?=[\s/>])((?:\s[^>]*)?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g;
  const parsed: Repeated<string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(rowXml)) !== null) {
    // Covered cells (m[1] === 'covered-table-cell') carry no own text anyway.
    const text = odfParagraphBlocks(m[3] ?? '').map(odfParagraphText).join(' ');
    parsed.push({ value: text, repeat: repeatCount(m[2], 'table:number-columns-repeated') });
  }
  while (parsed.length > 0 && parsed[parsed.length - 1].value === '') parsed.pop();

  const cells: string[] = [];
  let truncated = false;
  for (const { value, repeat } of parsed) {
    for (let i = 0; i < repeat; i++) {
      if (cells.length >= MAX_COLS_PER_SHEET) {
        truncated = true;
        break;
      }
      cells.push(value);
    }
    if (truncated) break;
  }
  return { cells, truncated };
}

/** A `…-repeated="N"` attribute value, clamped to a sane positive integer. */
function repeatCount(attrs: string, name: string): number {
  const raw = new RegExp(`${name}="(\\d+)"`).exec(attrs)?.[1];
  const n = raw ? parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

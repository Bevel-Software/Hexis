import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import type { ExtractResult } from './doc-extract.types.js';
import { MAX_DOC_TOTAL_BYTES, zipEntryOversize } from './ooxml-text.js';

/**
 * Per-sheet extraction caps. A worksheet's declared range can be enormous
 * (a stray cell at XFD1048576 makes the range 16k x 1M); the caps bound the
 * text an agent gets to something readable, and the extraction SAYS when it
 * truncated (a `[sheet truncated …]` line right under the sheet marker).
 */
const MAX_ROWS_PER_SHEET = 10_000;
const MAX_COLS_PER_SHEET = 200;

/**
 * Extract a `.xlsx` (Excel) workbook via SheetJS: per sheet a `[sheet: Name]`
 * marker, then the rows as tab-separated values (`sheet_to_csv` with a tab
 * field separator — SheetJS renders each cell's FORMATTED value, e.g. dates as
 * dates), with trailing empty rows trimmed.
 */
export function extractXlsx(bytes: Buffer): ExtractResult {
  // A real .xlsx is a zip. Check the signature OURSELVES because SheetJS
  // helpfully falls back to parsing arbitrary bytes as CSV/HTML — which would
  // turn a corrupt upload into confident nonsense instead of an honest error.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return { ok: false, message: 'could not be parsed as a .xlsx (not a zip archive)' };
  }
  // Zip-bomb bound BEFORE SheetJS inflates anything: the central directory
  // declares every entry's uncompressed size, so per-part (50 MB) and
  // aggregate (200 MB) limits cost one directory scan. A zip AdmZip cannot
  // read falls through — SheetJS then reports its own parse failure.
  try {
    const zip = new AdmZip(bytes);
    let total = 0;
    for (const entry of zip.getEntries()) {
      const oversize = zipEntryOversize(entry);
      if (oversize) return { ok: false, message: `could not be extracted as a .xlsx (${oversize})` };
      total += entry.header.size;
      if (total > MAX_DOC_TOTAL_BYTES) {
        return {
          ok: false,
          message: `could not be extracted as a .xlsx (the archive's parts exceed the ${MAX_DOC_TOTAL_BYTES}-byte (200 MB) total extraction limit)`,
        };
      }
    }
  } catch {
    // not AdmZip-readable — let SheetJS produce the typed parse failure below
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: 'buffer' });
  } catch (err) {
    return { ok: false, message: `could not be parsed as a .xlsx (${(err as Error).message})` };
  }

  const lines: string[] = [];
  for (const name of wb.SheetNames) {
    lines.push(`[sheet: ${name}]`);
    const ws = wb.Sheets[name];
    const ref = ws?.['!ref'];
    if (!ws || !ref) continue; // empty sheet — marker only
    const range = XLSX.utils.decode_range(ref);
    const truncated: string[] = [];
    if (range.e.r - range.s.r + 1 > MAX_ROWS_PER_SHEET) {
      range.e.r = range.s.r + MAX_ROWS_PER_SHEET - 1;
      truncated.push(`first ${MAX_ROWS_PER_SHEET} rows`);
    }
    if (range.e.c - range.s.c + 1 > MAX_COLS_PER_SHEET) {
      range.e.c = range.s.c + MAX_COLS_PER_SHEET - 1;
      truncated.push(`first ${MAX_COLS_PER_SHEET} columns`);
    }
    if (truncated.length > 0) {
      lines.push(`[sheet truncated to the ${truncated.join(' and ')}]`);
      ws['!ref'] = XLSX.utils.encode_range(range);
    }
    const rows = XLSX.utils.sheet_to_csv(ws, { FS: '\t' }).split(/\r?\n/);
    while (rows.length > 0 && rows[rows.length - 1].replace(/\t/g, '') === '') rows.pop();
    lines.push(...rows);
  }
  return {
    ok: true,
    summary: `${wb.SheetNames.length} sheet${wb.SheetNames.length === 1 ? '' : 's'}, rows as tab-separated values; formulas, formatting and charts omitted`,
    text: lines.join('\n'),
  };
}

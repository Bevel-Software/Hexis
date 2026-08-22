import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import { DownloadFileButton } from './DownloadFileButton';
import type { FileRendererProps } from './types';

/**
 * Where the grid stops. A KB spreadsheet is read for orientation — what the
 * columns are, roughly what is in them — and a million-row export rendered as
 * a million `<td>`s locks the tab long before it answers either question. The
 * caps keep the DOM bounded; the note under the grid says exactly what was
 * cut, and the Download affordance is the path to the whole sheet.
 */
/**
 * The largest workbook this viewer will parse. SheetJS has no streaming or
 * metadata-only mode: `read` materializes every cell of every sheet, so a dense
 * file freezes the main thread long before the row and column caps below get a
 * chance to bound the VIEW.
 */
const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * The largest DECLARED uncompressed total this viewer will inflate. The
 * transfer cap above cannot rule out a ZIP bomb: an .xlsx is a ZIP, and a
 * file well under 25 MB on the wire can declare gigabytes of XML that
 * `XLSX.read` would materialize in full before any row or column cap runs.
 */
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB

const MAX_ROWS = 1000;
const MAX_COLS = 100;

/**
 * Sum of the uncompressed entry sizes a ZIP archive declares in its central
 * directory — or `null` when the bytes are not a readable ZIP, so a renamed
 * or truncated file falls through to `XLSX.read`'s own parse error instead
 * of a misleading "too large" message. A ZIP64 entry (size field saturated
 * at 0xffffffff) reports Infinity: its real size is over any cap here.
 */
function zipDeclaredSize(buffer: ArrayBuffer): number | null {
  const view = new DataView(buffer);
  // End-of-central-directory record: 22 bytes at the tail, preceded by at
  // most 64 KB of archive comment. Scan back for its signature.
  const stop = Math.max(0, buffer.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= stop; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    // The signature is four ordinary bytes and may appear INSIDE the archive
    // comment. The real record is the one whose declared comment length ends
    // exactly at the file's end — a planted one almost never does, and a
    // fake directory would otherwise be parsed and the size guard skipped.
    if (i + 22 + view.getUint16(i + 20, true) !== buffer.byteLength) continue;
    eocd = i;
    break;
  }
  if (eocd < 0) return null;
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== 0x02014b50) return null;
    const size = view.getUint32(offset + 24, true);
    if (size === 0xffffffff) return Number.POSITIVE_INFINITY;
    total += size;
    // Fixed header + file name + extra field + comment.
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return total;
}

/**
 * Buffer a response body while refusing to hold more than `maxBytes`: the
 * moment the received total crosses the cap the read stops, the connection is
 * cancelled, and `null` comes back. Content-Length alone cannot enforce the
 * cap — it can be absent (chunked) or understate the body. Falls back to
 * `arrayBuffer()` (capped after the fact) where the body is not streamable,
 * e.g. the test DOM's mocked responses.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  const body = res.body;
  if (!body) {
    const buffer = await res.arrayBuffer();
    return buffer.byteLength > maxBytes ? null : buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

interface SheetView {
  name: string;
  rows: string[][];
  /** Real dimensions before the caps — what the truncation note reports. */
  totalRows: number;
  totalCols: number;
}

/**
 * Inline .xlsx viewer. Fetches the binary from `/api/workspace/:id/file/raw`,
 * parses it with SheetJS, and renders each sheet as an HTML table with a
 * tab strip across the top. Multi-sheet workbooks show one tab per sheet.
 *
 * View-only: there is no edit mode for binary office formats. The renderer
 * ignores `onSave` / `onValueChange` / `readOnly`.
 *
 * Cells are rendered as their formatted string value (`raw: false`) so dates
 * and percentages match what the user sees in Excel rather than coming out
 * as raw serial numbers / decimals.
 */
export function XlsxRenderer({ filePath }: FileRendererProps) {
  const { workspaceId } = useWorkspace();
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWorkbook(null);
    setActiveSheet(0);
    setError(null);
    if (!workspaceId) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(
          `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load spreadsheet (HTTP ${res.status})`);
          return;
        }
        // SheetJS parses EVERY cell of every sheet before this component can
        // apply its row and column caps, so those caps bound what is DISPLAYED,
        // never what is parsed. The byte bound is what keeps a dense workbook
        // from freezing the tab, and it has to come before the buffer: the
        // header check is the cheap early exit, the capped read below the
        // enforcement — Content-Length can be absent or understate the body.
        const declared = Number(res.headers?.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_WORKBOOK_BYTES) {
          setError('This spreadsheet is too large to preview. Download it to open in a spreadsheet app.');
          return;
        }
        const buffer = await readBodyCapped(res, MAX_WORKBOOK_BYTES);
        if (cancelled) return;
        if (buffer === null) {
          setError('This spreadsheet is too large to preview. Download it to open in a spreadsheet app.');
          return;
        }
        // The byte bounds above are TRANSFER sizes; a ZIP bomb sails under
        // both. Reject on the uncompressed total the archive itself declares,
        // before `XLSX.read` inflates any of it. (Non-ZIP bytes fall through
        // to the parse error below, where they belong.)
        const declaredInflated = zipDeclaredSize(buffer);
        if (declaredInflated !== null && declaredInflated > MAX_UNCOMPRESSED_BYTES) {
          setError('This spreadsheet is too large to preview. Download it to open in a spreadsheet app.');
          return;
        }
        let parsed: XLSX.WorkBook;
        try {
          parsed = XLSX.read(new Uint8Array(buffer), { type: 'array' });
        } catch (parseErr) {
          console.warn('[XlsxRenderer] parse failed:', parseErr);
          if (!cancelled) setError('This file could not be parsed as a spreadsheet.');
          return;
        }
        if (cancelled) return;
        setWorkbook(parsed);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath]);

  // Convert ONLY the sheet on screen, when it is on screen. `XLSX.read` has
  // already materialized every cell (SheetJS has no partial parse), but
  // stringifying up to MAX_ROWS × MAX_COLS cells per sheet for EVERY sheet up
  // front would multiply that work by the sheet count before the first grid
  // could paint. A tab revisit re-converts — work bounded by the caps.
  const sheet = useMemo<SheetView | null>(() => {
    if (!workbook || workbook.SheetNames.length === 0) return null;
    const name = workbook.SheetNames[Math.min(activeSheet, workbook.SheetNames.length - 1)]!;
    const ws = workbook.Sheets[name];
    const ref = ws?.['!ref'];
    if (!ws || !ref) return { name, rows: [], totalRows: 0, totalCols: 0 };
    // Cap the conversion range BEFORE materializing anything:
    // `sheet_to_json` walks every cell of the range it is given, so a
    // sparse sheet whose declared range is `A1:XFD1048576` (one stray
    // cell at the far corner) would materialize 16k × 1M cells and
    // freeze the tab. The honest "N of M" totals for the truncation
    // note come from the DECLARED `!ref` itself — no full parse needed.
    const range = XLSX.utils.decode_range(ref);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;
    const bounded = {
      s: range.s,
      e: {
        r: Math.min(range.e.r, range.s.r + MAX_ROWS - 1),
        c: Math.min(range.e.c, range.s.c + MAX_COLS - 1),
      },
    };
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      defval: '',
      range: XLSX.utils.encode_range(bounded),
    }) as unknown[][];
    return {
      name,
      totalRows,
      totalCols,
      rows: rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))),
    };
  }, [workbook, activeSheet]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-danger">{error}</p>
        <DownloadFileButton filePath={filePath} />
      </div>
    );
  }

  if (workbook === null) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted text-sm">
        Loading spreadsheet...
      </div>
    );
  }

  if (sheet === null) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted text-sm">
        The workbook has no sheets.
      </div>
    );
  }

  const truncated = sheet.totalRows > MAX_ROWS || sheet.totalCols > MAX_COLS;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 border-b border-line px-1 pb-1 shrink-0">
        {workbook.SheetNames.length > 1 && (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {workbook.SheetNames.map((name, i) => (
              <button
                key={name}
                type="button"
                onClick={() => setActiveSheet(i)}
                className={`px-2 py-1 rounded-xs text-xs font-medium whitespace-nowrap transition-colors ${
                  i === activeSheet
                    ? 'bg-sunken text-ink'
                    : 'text-ink-muted hover:text-ink hover:bg-hover'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        <span className="flex-1" />
        <DownloadFileButton filePath={filePath} />
      </div>
      <div className="flex-1 overflow-auto">
        {sheet.rows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-ink-muted text-sm">
            This sheet is empty.
          </div>
        ) : (
          <table className="border-collapse text-sm">
            <tbody>
              {sheet.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((cell, cIdx) => {
                    const Tag = rIdx === 0 ? 'th' : 'td';
                    return (
                      <Tag
                        key={cIdx}
                        className={`border border-line px-2 py-1 align-top whitespace-pre-wrap ${
                          rIdx === 0
                            ? 'bg-sunken text-ink font-medium text-left'
                            : 'text-ink'
                        }`}
                      >
                        {cell}
                      </Tag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {truncated && (
        <div role="note" className="shrink-0 border-t border-line px-1 pt-1.5 text-detail text-ink-muted">
          Truncated view: showing
          {sheet.totalRows > MAX_ROWS
            ? ` the first ${MAX_ROWS.toLocaleString()} of ${sheet.totalRows.toLocaleString()} rows`
            : ''}
          {sheet.totalRows > MAX_ROWS && sheet.totalCols > MAX_COLS ? ' and' : ''}
          {sheet.totalCols > MAX_COLS
            ? ` the first ${MAX_COLS.toLocaleString()} of ${sheet.totalCols.toLocaleString()} columns`
            : ''}
          . Download the file for the full sheet.
        </div>
      )}
    </div>
  );
}

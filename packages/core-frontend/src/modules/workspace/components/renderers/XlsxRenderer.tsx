import { useEffect, useState } from 'react';
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
const MAX_ROWS = 1000;
const MAX_COLS = 100;

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
  const [sheets, setSheets] = useState<SheetView[] | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSheets(null);
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
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        let workbook: XLSX.WorkBook;
        try {
          workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
        } catch (parseErr) {
          console.warn('[XlsxRenderer] parse failed:', parseErr);
          if (!cancelled) setError('This file could not be parsed as a spreadsheet.');
          return;
        }
        const parsed: SheetView[] = workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          // `sheetRows` would cap the PARSE too, but it caps every sheet the
          // same and hides the real row count — and the honest "N of M rows"
          // note needs M. Parsing in full and slicing keeps the note true.
          const rows = sheet
            ? (XLSX.utils.sheet_to_json(sheet, {
                header: 1,
                raw: false,
                defval: '',
              }) as unknown[][])
            : [];
          const totalCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
          return {
            name,
            totalRows: rows.length,
            totalCols,
            rows: rows
              .slice(0, MAX_ROWS)
              .map((row) =>
                row.slice(0, MAX_COLS).map((cell) => (cell == null ? '' : String(cell))),
              ),
          };
        });
        if (cancelled) return;
        setSheets(parsed);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-danger">{error}</p>
        <DownloadFileButton filePath={filePath} />
      </div>
    );
  }

  if (sheets === null) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted text-sm">
        Loading spreadsheet...
      </div>
    );
  }

  if (sheets.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted text-sm">
        The workbook has no sheets.
      </div>
    );
  }

  const sheet = sheets[Math.min(activeSheet, sheets.length - 1)]!;
  const truncated = sheet.totalRows > MAX_ROWS || sheet.totalCols > MAX_COLS;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 border-b border-line px-1 pb-1 shrink-0">
        {sheets.length > 1 && (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {sheets.map((s, i) => (
              <button
                key={s.name}
                type="button"
                onClick={() => setActiveSheet(i)}
                className={`px-2 py-1 rounded-xs text-xs font-medium whitespace-nowrap transition-colors ${
                  i === activeSheet
                    ? 'bg-sunken text-ink'
                    : 'text-ink-muted hover:text-ink hover:bg-hover'
                }`}
              >
                {s.name}
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

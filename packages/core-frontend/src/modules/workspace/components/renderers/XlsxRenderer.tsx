import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import type { FileRendererProps } from './types';

interface SheetView {
  name: string;
  rows: string[][];
}

/**
 * Inline .xlsx viewer. Fetches the binary from `/api/workspace/:id/file/raw`,
 * parses it with SheetJS, and renders each sheet as an HTML table with a
 * tab strip across the top. Multi-sheet workbooks show one tab per sheet;
 * single-sheet workbooks hide the tab strip.
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
        const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
        const parsed: SheetView[] = workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          const rows = sheet
            ? (XLSX.utils.sheet_to_json(sheet, {
                header: 1,
                raw: false,
                defval: '',
              }) as unknown[][])
            : [];
          return {
            name,
            rows: rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))),
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
      <div className="flex items-center justify-center h-full text-red-600 text-sm">
        {error}
      </div>
    );
  }

  if (sheets === null) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        Loading spreadsheet...
      </div>
    );
  }

  if (sheets.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        The workbook has no sheets.
      </div>
    );
  }

  const sheet = sheets[Math.min(activeSheet, sheets.length - 1)]!;

  return (
    <div className="flex flex-col h-full">
      {sheets.length > 1 && (
        <div className="flex items-center gap-1 border-b border-slate-200 px-1 pb-1 overflow-x-auto shrink-0">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${
                i === activeSheet
                  ? 'bg-slate-100 text-slate-900'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {sheet.rows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-600 text-sm">
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
                        className={`border border-slate-200 px-2 py-1 align-top whitespace-pre-wrap ${
                          rIdx === 0
                            ? 'bg-slate-50 text-slate-900 font-medium text-left'
                            : 'text-slate-700'
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
    </div>
  );
}

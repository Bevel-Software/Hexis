import { useMemo } from 'react';
import type { FileDiffPayload } from '@bevel-software/platform-shared';
import { computeDiff, type DiffLine } from '../../workspace/utils/diff';

const MAX_RENDERED_LINES = 5000;

export function DiffViewer({ payload }: { payload: FileDiffPayload }) {
  const lines = useMemo<DiffLine[]>(() => {
    if (payload.isBinary) return [];
    const baseline = payload.baseline ?? '';
    const current = payload.current ?? '';
    // For added files, baseline is empty so every current line becomes "added".
    // For deleted files, current is empty so every baseline line becomes "removed".
    return computeDiff(baseline, current);
  }, [payload]);

  if (lines.length > MAX_RENDERED_LINES) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-slate-600 px-6 text-center">
        Diff is too large to render ({lines.length.toLocaleString()} lines).
        Accept or reject from the file list.
      </div>
    );
  }

  // Compute line numbers on each side. Unchanged lines advance both counters;
  // "added" advances only current, "removed" advances only baseline.
  let oldLine = 0;
  let newLine = 0;

  return (
    <div className="h-full overflow-auto bg-white font-mono text-[12px] leading-[18px]">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l, i) => {
            let marker = ' ';
            let bg = '';
            let textColor = 'text-slate-900';
            let left: number | '' = '';
            let right: number | '' = '';
            if (l.type === 'same') {
              oldLine++;
              newLine++;
              left = oldLine;
              right = newLine;
            } else if (l.type === 'added') {
              newLine++;
              right = newLine;
              marker = '+';
              bg = 'bg-emerald-100';
              textColor = 'text-emerald-700';
            } else {
              oldLine++;
              left = oldLine;
              marker = '−';
              bg = 'bg-red-100';
              textColor = 'text-red-700';
            }
            return (
              <tr key={i} className={bg}>
                <td className="w-12 text-right pr-2 text-slate-500 select-none border-r border-slate-200">
                  {left}
                </td>
                <td className="w-12 text-right pr-2 text-slate-500 select-none border-r border-slate-200">
                  {right}
                </td>
                <td className={`w-4 text-center ${textColor} select-none`}>{marker}</td>
                <td className={`whitespace-pre-wrap break-words pl-2 pr-3 ${textColor}`}>
                  {l.text || '\u00A0'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

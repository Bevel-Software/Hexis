interface Props {
  diff: string;
  /** Copy shown when `diff` is empty / whitespace-only. */
  emptyMessage?: string;
}

/**
 * Render a unified-diff string with the same colour vocabulary used across
 * every git surface in the app — sky-blue hunk headers, emerald additions,
 * red removals, muted index/file headers. Lives in `git/` because both the
 * file-history panel and the cross-branch comparison panel render diffs.
 */
export function UnifiedDiffView({ diff, emptyMessage = 'No changes.' }: Props) {
  if (!diff.trim()) {
    return (
      <div className="px-3 py-3 text-xs text-slate-600">{emptyMessage}</div>
    );
  }
  const lines = diff.split('\n');
  return (
    <pre className="px-3 py-2 text-xs font-mono leading-5 whitespace-pre">
      {lines.map((line, i) => {
        let cls = 'text-slate-700';
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-slate-600';
        else if (line.startsWith('@@')) cls = 'text-sky-600';
        else if (line.startsWith('+')) cls = 'text-emerald-700 bg-emerald-50';
        else if (line.startsWith('-')) cls = 'text-red-700 bg-red-50';
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-slate-600';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

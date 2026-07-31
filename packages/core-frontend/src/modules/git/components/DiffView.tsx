export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <div className="px-3 py-3 text-xs text-slate-600">
        No file changes in this save.
      </div>
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
        // <pre> expects phrasing content; use a block-displayed <span> so each
        // diff line still takes a full row without violating the HTML content
        // model (div-in-pre triggers hydration warnings in strict mode).
        return (
          <span key={i} className={`block ${cls}`}>
            {line || '\u00A0'}
          </span>
        );
      })}
    </pre>
  );
}

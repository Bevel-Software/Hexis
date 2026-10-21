import type { DiffLine } from '../utils/diff';

/**
 * Removed and added lines as `<del>` / `<ins>`, not coloured `<div>`s: what is
 * on screen is a claim about what changed, and the elements that MEAN that are
 * the ones a screen reader announces as such. The colours come from `.lib-sug`
 * — the one rule every view that marks a change uses, so a change request's
 * marks and a skill's inline suggestion never drift apart.
 */
export function MarkedLines({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="lib-sug whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
      {lines.map((l, i) =>
        l.kind === 'removed' ? (
          <del key={i} className="block">
            {l.text || ' '}
          </del>
        ) : l.kind === 'added' ? (
          <ins key={i} className="block">
            {l.text || ' '}
          </ins>
        ) : (
          <div key={i}>{l.text || ' '}</div>
        ),
      )}
    </pre>
  );
}

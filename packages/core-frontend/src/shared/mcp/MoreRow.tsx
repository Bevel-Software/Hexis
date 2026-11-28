import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * A closed row: something only some readers need, waiting until asked for.
 * Another way in, a second place a key goes, what to do when it fails. The
 * reader has one thing in front of them, and the rest is one click away.
 * The arrow is the same one every row that opens carries.
 */
export function MoreRow({
  summary,
  group,
  children,
}: {
  summary: string;
  /**
   * Rows that share a group close each other: opening one shuts the rest, so
   * the reader never faces two things to copy at once.
   */
  group?: string;
  children: ReactNode;
}) {
  return (
    <details name={group} className="group/more text-detail text-ink-muted">
      <summary className="flex cursor-pointer list-none items-center gap-1 transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} aria-hidden className="flex-none transition-transform group-open/more:rotate-90" />
        {summary}
      </summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  );
}

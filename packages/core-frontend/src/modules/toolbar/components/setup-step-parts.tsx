import type { ReactNode } from 'react';

/**
 * The small pieces the Claude setup steps are written in, shared by the two
 * homes those steps now have: the registration steps in Deployment settings,
 * and the personal tutorial on External agent access.
 */

/**
 * A link out of the app, marked as one.
 *
 * The marker is a GLYPH, not the lucide icon the buttons use: an inline SVG
 * is an atomic box, and a line may break after it, which left the comma in
 * "Admin settings → Claude Code, scroll to…" stranded at the start of the
 * next line. Text has no break opportunity there.
 */
export function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline text-ink-muted hover:text-ink"
    >
      {children}
      <span aria-hidden="true" className="opacity-60">
        ↗
      </span>
    </a>
  );
}

export function Prose({ children }: { children: ReactNode }) {
  return <p className="text-meta text-ink-muted leading-snug">{children}</p>;
}

/**
 * The lock. One shape, three places: the sidebar's count box, the `Locked`
 * badge on a group's page, and the all-groups index rows.
 *
 * Inline rather than an icon-library import because it is drawn ~20px wide in
 * a fixed slot and has to inherit `currentColor` from the row it sits in —
 * a dependency for two paths is a dependency for nothing.
 *
 * `aria-hidden` is NOT an oversight: every caller already carries the word in
 * text or in an `aria-label`/`title` ("Finance (locked)", the `Locked` badge).
 * A named glyph beside a named row would say "locked" twice to a screen reader
 * and once to everyone else.
 */
export function LockGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

import { cn } from '../../../lib/utils';
import { SIDEBAR_DOM_ID } from './SidebarFrame';

/**
 * Hide / show the nav — the prototype's `#side-open` (lines 89-91).
 *
 * It lives in the TOP BAR, first in the row and left of the brand — the spot
 * every app puts the control that owns the panel below it. The `Toolbar`
 * mounts it wherever a sidebar exists and wires it to the shared store in
 * `layout/state/sidebar.ts`; the sidebar it controls renders in a different
 * subtree entirely, which `aria-controls` bridges by id.
 *
 * ONE button, at ONE place, for ONE sidebar. It sat in the `library` module
 * while Knowledge's explorer had a separate toggle of its own — same glyph,
 * same spot, different state — and moved here when those became the same
 * control. The prototype's own note is the whole design: "the toggle never
 * moves — same spot, open or closed", so collapsing does not move the thing
 * you just clicked out from under the pointer.
 */
export function SidebarToggle({
  collapsed,
  onToggle,
  className,
}: {
  collapsed: boolean;
  onToggle(): void;
  className?: string;
}) {
  const label = collapsed ? 'Show sidebar' : 'Hide sidebar';
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={SIDEBAR_DOM_ID}
      className={cn(
        // `ink-muted`, not `ink-faint`: at 16px with a 1.3 stroke this is a
        // thin shape on a tinted panel, and the faint step rendered it close
        // enough to the background to read as "no button here at all".
        'flex size-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-hover hover:text-ink',
        className,
      )}
    >
      <PanelGlyph className="size-4" />
    </button>
  );
}

/**
 * A panel with its left rail filled — the sidebar, drawn as itself.
 *
 * Exported because BOTH surfaces show it now: the Library's nav toggle and
 * Knowledge's explorer toggle are the same control in the same spot doing the
 * same thing, and two glyphs for that would be the app saying "you are
 * somewhere else" at the one place that must never move (proto:3696).
 *
 * Inline for the same reason as `LockGlyph`: it inherits `currentColor` from
 * the button's hover state, and one shape is not worth an icon dependency.
 *
 * The rail is a path rather than a second `<rect>` because only its LEFT
 * corners are round — it has to sit flush inside the outer radius on that
 * side and butt square against the divider on the other. Both arcs carry the
 * outer `rx`, so the two shapes share one silhouette at any size.
 */
export function PanelGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" viewBox="0 0 16 16">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.7 2.5H6.1V13.5H4.7A3.2 3.2 0 0 1 1.5 10.3V5.7A3.2 3.2 0 0 1 4.7 2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

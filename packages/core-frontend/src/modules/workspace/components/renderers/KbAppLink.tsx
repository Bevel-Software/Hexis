/**
 * Where an in-app link inside rendered content leads, as the app's file-nav
 * hook answers it (`useFileNav().linkTarget`, `useNodeIdNav().nodeIdTarget`):
 * `href` is the address the click opens, `newTab` whether it opens there in a
 * new tab (another file) or in this one (a section of the file on screen).
 */
export interface KbLinkTarget {
  href: string;
  newTab: boolean;
}

/**
 * An in-app link the caller follows on click (`onOpen`, with the destination
 * as written). With a `target` the anchor carries the address the click goes
 * to, and — when that is a new tab — `target="_blank"` and `rel="noopener"`,
 * so a middle-click, the context menu and a screen reader all agree with the
 * click. A click the reader modified (Ctrl, ⌘, Shift, Alt) on a new-tab link
 * is left to the browser: it does with that link what it does with any
 * new-tab link. Without a `target` (no resolver: the diff, the skill page)
 * the anchor is what it always was, every click taken by `onOpen`.
 */
export function KbAppLink({
  href,
  target,
  onOpen,
  className = 'cursor-pointer',
  children,
  ...props
}: {
  href: string;
  target: KbLinkTarget | null;
  onOpen: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const newTab = target?.newTab === true;
  return (
    <a
      {...props}
      href={target?.href ?? href}
      {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}
      onClick={(e) => {
        if (newTab && (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
        e.preventDefault();
        onOpen();
      }}
      className={className}
    >
      {children}
    </a>
  );
}

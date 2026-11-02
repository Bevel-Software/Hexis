import type { ReactNode } from 'react';

/**
 * One frame for the full-screen states a file page can end in ("File not
 * found", "This file was deleted", a branch that is gone, …).
 *
 * They said the same thing four different ways before — four copies of the
 * centring, four hand-rolled buttons, four type scales. Every sentence they
 * carried is preserved verbatim, including the dirty-branch explanation;
 * only the chrome is shared.
 */
export function ErrorScreen({
  title,
  role,
  children,
}: {
  title: string;
  role?: 'alert';
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-canvas px-6">
      <div role={role} className="max-w-md space-y-3 text-center">
        <h2 className="text-head text-ink">{title}</h2>
        {children}
      </div>
    </div>
  );
}

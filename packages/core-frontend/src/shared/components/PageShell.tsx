import type { ReactNode } from 'react';

const WIDTH_CLASS = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
} as const;

export type PageShellWidth = keyof typeof WIDTH_CLASS;

/**
 * Minimal shared chrome for the shell's standalone routed pages (Secrets,
 * External agent access, Roles & Members): a full-height scrolling canvas
 * with a centered max-width column, a page-title row and a white content
 * card. Deliberately tiny — it mirrors the Tailwind idioms the tools
 * explorer page already uses; it is not a design system.
 *
 * `padded` drops the card's default padding for pages that own their inner
 * layout (e.g. a tab strip flush against the card's top edge).
 */
export function PageShell({
  title,
  actions,
  width = '3xl',
  padded = true,
  children,
}: {
  title: string;
  /** Rendered right-aligned in the title row (e.g. a refresh button). */
  actions?: ReactNode;
  width?: PageShellWidth;
  padded?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto bg-sunken">
      <div className={`${WIDTH_CLASS[width]} mx-auto px-6 py-8`}>
        <header className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
        <section
          className={`bg-white border border-line rounded-lg ${
            padded ? 'p-4' : 'overflow-hidden'
          }`}
        >
          {children}
        </section>
      </div>
    </div>
  );
}

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * One row in a list. Implements the prototype's `.row`, `.srow`,
 * `.strip-row`, `.frow` and `.vrow`, which are the same shape at four
 * densities: a leading marker, a title, optional description, and trailing
 * metadata.
 *
 * Absorbs ~35 sites — 23 full-width `text-left` buttons plus PrFileRow,
 * ReviewFileRow, the FileExplorer rows and FileHistoryPanel.
 *
 * `active` maps to a visual state only. Callers still set `aria-current` or
 * `aria-selected` themselves, because which one is correct depends on
 * whether the row is navigation or selection — and 199 tests query on those.
 */

export type ListRowDensity = 'row' | 'strip' | 'file';

const DENSITY: Record<ListRowDensity, string> = {
  /** A standalone bordered row (the prototype's `.row`). */
  row: 'gap-3 px-3.5 py-3 rounded-lg border border-line bg-surface shadow-card',
  /** A borderless line in a notification strip (`.strip-row`). */
  strip: 'gap-2.5 px-1.5 py-1.5 rounded-md text-ui',
  /** A tight file listing line (`.frow`). */
  file: 'gap-2.5 px-2.5 py-1.5 rounded-sm text-detail',
};

const HOVER: Record<ListRowDensity, string> = {
  row: 'hover:border-line-strong hover:bg-surface-hover',
  strip: 'hover:bg-hover hover:text-ink',
  file: 'hover:bg-hover hover:text-ink',
};

export interface ListRowProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'button' | 'li';
  density?: ListRowDensity;
  /** Status dot, icon or avatar. */
  leading?: ReactNode;
  /**
   * The row's primary text. Deliberately NOT called `title`: that name is the
   * native tooltip attribute, and shadowing it would break the 31 tests that
   * read `title` off these rows. `title` stays available via `...rest`.
   */
  label?: ReactNode;
  description?: ReactNode;
  /** Right-aligned metadata: counts, sizes, timestamps. */
  meta?: ReactNode;
  /** Visual selected state only — set `aria-current`/`aria-selected` yourself. */
  active?: boolean;
}

export function ListRow({
  as: Tag = 'div',
  density = 'row',
  leading,
  label,
  description,
  meta,
  active = false,
  className,
  children,
  ...rest
}: ListRowProps) {
  const isButton = Tag === 'button';
  return (
    <Tag
      {...(isButton ? { type: 'button' as const } : {})}
      className={cn(
        'flex w-full items-center text-left transition-colors',
        'text-ink-muted',
        DENSITY[density],
        isButton && cn('cursor-pointer', HOVER[density]),
        active && 'bg-hover text-ink',
        className,
      )}
      {...rest}
    >
      {leading && <span className="flex flex-none items-center">{leading}</span>}
      {(label || description) && (
        <span className="min-w-0 flex-1">
          {label && <span className="block truncate font-semibold text-ink">{label}</span>}
          {description && (
            <span className="block truncate text-detail text-ink-muted">{description}</span>
          )}
        </span>
      )}
      {children}
      {meta && (
        <span className="ml-auto flex flex-none items-center gap-2.5 text-meta text-ink-faint">
          {meta}
        </span>
      )}
    </Tag>
  );
}

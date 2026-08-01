import type { ReactNode } from 'react';
import { ListRow } from '../../../shared/components';

export interface GroupIndexRowProps {
  label: string;
  /** Inline with the label — the `Owner` chip. */
  badge?: ReactNode;
  description?: string;
  /** Right-aligned counts, e.g. `4 skills · 2 tools`. */
  meta?: string;
  /**
   * After the counts: the amber attention count on a group you are in, or —
   * on an "Ask to join" row — the `Locked` chip, which becomes `Requested`
   * once the caller has a pending access request. A slot rather than a
   * boolean, which is why those three states cost this file nothing.
   */
  trailing?: ReactNode;
  onOpen(): void;
}

/**
 * One row on the all-groups index — a group, or one of the two personal views.
 *
 * The whole row is the target, which is why it is a `<button>` and not a card
 * with a link inside it: every row here means exactly one thing, "go there".
 * Counts live in `meta` as plain text so the row's accessible name reads as the
 * sentence it looks like ("GTM Run by Olga Ivanova 4 skills · 2 tools").
 */
export function GroupIndexRow({
  label,
  badge,
  description,
  meta,
  trailing,
  onOpen,
}: GroupIndexRowProps) {
  return (
    <ListRow
      as="button"
      density="row"
      onClick={onOpen}
      label={
        badge ? (
          <span className="flex items-center gap-2">
            <span className="truncate">{label}</span>
            {badge}
          </span>
        ) : (
          label
        )
      }
      description={description}
      meta={
        meta || trailing ? (
          <>
            {meta && <span className="whitespace-nowrap tabular-nums">{meta}</span>}
            {trailing}
          </>
        ) : undefined
      }
    />
  );
}

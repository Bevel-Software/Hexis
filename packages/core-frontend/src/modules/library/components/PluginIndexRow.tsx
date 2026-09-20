import type { ReactNode } from 'react';
import { ListRow } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { ItemMenuFrame, type ItemAction } from './ItemActionsMenu';
import { NameWithBadges } from './NameWithBadges';

export interface PluginIndexRowProps {
  label: string;
  /**
   * Beside the label — the `Owner` and `Private` chips. Beside it while there
   * is room for both: past that the chips drop below the name rather than go
   * on taking width from it (see `NameWithBadges`), so a row with chips can
   * be two lines tall on a narrow window.
   */
  badge?: ReactNode;
  description?: string;
  /** Right-aligned counts, e.g. `4 skills · 2 tools`. */
  meta?: string;
  /**
   * After the counts: the amber attention count on a plugin you are in, or —
   * on a "Request access" row — the `Locked` chip, which becomes `Requested`
   * once the caller has a pending access request. A slot rather than a
   * boolean, which is why those three states cost this file nothing.
   */
  trailing?: ReactNode;
  /**
   * The row's own menu, BESIDE Open — Share for a plugin the caller can read,
   * Subscribe for one it cannot. Empty (the default) leaves the row exactly as
   * it was: the caller's own space is not a plugin and has neither verb, so it
   * grows no `…` rather than growing one that can only say "Open".
   */
  actions?: ItemAction[];
  onOpen(): void;
}

/**
 * One row on the all-plugins index — a plugin, or one of the two personal views.
 *
 * The whole row is the target, which is why it is a `<button>` and not a card
 * with a link inside it: every row here means exactly one thing, "go there".
 * Counts live in `meta` as plain text so the row's accessible name reads as the
 * sentence it looks like ("GTM Run by Olga Ivanova 4 skills · 2 tools").
 *
 * When the row has `actions`, a `…` rides its right edge — a SIBLING of the row
 * button, since the row is the button (see `ItemMenuFrame`). The row then keeps
 * the trailing room clear for it (`pr-10`) instead of letting the menu paint
 * over the counts and the Locked chip it is right beside. The frame itself is
 * always there: which verbs a row has depends on answers that arrive after the
 * first paint, and a frame that came with them would remount the row under
 * whoever was already using it.
 */
export function PluginIndexRow({
  label,
  badge,
  description,
  meta,
  trailing,
  actions,
  onOpen,
}: PluginIndexRowProps) {
  const row = (
    <ListRow
      as="button"
      density="row"
      onClick={onOpen}
      className={cn(actions && actions.length > 0 && 'pr-10')}
      // The same rule a card's name lives by, and for the same reason: a row
      // narrowed by its counts used to spend all of its shortfall on the
      // plugin's name while `Owner` and `Private` kept every pixel they
      // asked for. Through `NameWithBadges` the chips drop to a second line
      // before the name goes under a readable width — and the name carries
      // its full self in `title` even on a row that has no chips at all,
      // which the bare string it used to be could not.
      label={<NameWithBadges name={label} badges={badge} />}
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

  return (
    <ItemMenuFrame
      label={label}
      actions={actions ?? []}
      // A row is one line tall, so its `…` sits on the mid-line rather than in
      // a corner the way a card's does.
      buttonClassName="top-1/2 right-2 -translate-y-1/2"
    >
      {row}
    </ItemMenuFrame>
  );
}

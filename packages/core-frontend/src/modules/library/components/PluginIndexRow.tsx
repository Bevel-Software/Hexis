import type { ReactNode } from 'react';
import { ListRow } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { ItemMenuFrame, type ItemAction } from './ItemActionsMenu';
import { NameWithBadges } from './NameWithBadges';

export interface PluginIndexRowProps {
  label: string;
  /**
   * The `Owner` and `Private` chips — LEADING the row's trailing group, on
   * the counts' line.
   *
   * They used to sit beside the label, through `NameWithBadges`, and drop
   * under the name when the two stopped fitting. That is the right rule for a
   * card, whose name is the only thing on its row; on an index row it put the
   * pill one line above the counts it belongs with, on the left, hanging off
   * a title block that is two lines tall the moment a plugin has a
   * description. The chips qualify the row, not the name, so they travel with
   * the rest of what the row's right edge says.
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
 * sentence it looks like ("GTM Run by Olga Ivanova Owner 4 skills · 2 tools") —
 * the chips are in that group too, and read in the order they are shown.
 *
 * The row's right edge is ONE line: chips, counts and the `…`, centred against
 * the row however tall the title block is. `ListRow` already spaces and
 * centres its `meta` group (`ml-auto flex flex-none items-center`), so
 * everything that belongs at that edge is passed there — which is why `badge`
 * goes to `meta` and not, as it once did, beside the name.
 *
 * When the row has `actions`, a `…` rides its right edge — a SIBLING of the row
 * button, since the row is the button (see `ItemMenuFrame`). It is positioned
 * on the row's mid-line, so it is already ON that one line; what it is not is
 * IN the flex flow, so the row keeps the trailing room clear for it (`pr-10`)
 * instead of letting the menu paint over the counts and the Locked chip it is
 * right beside. The frame itself is always there: which verbs a row has
 * depends on answers that arrive after the first paint, and a frame that came
 * with them would remount the row under whoever was already using it.
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
      // No badges here any more — they are part of the trailing group below,
      // so the name has the whole title line to truncate into and needs no
      // floor to defend it. `NameWithBadges` stays for what it still does
      // that a bare string cannot: the name carries its full self in `title`,
      // so a plugin whose name does not fit can still be read.
      label={<NameWithBadges name={label} />}
      description={description}
      // One line at the row's right edge, in reading order: what this plugin
      // is to you, then how much is in it, then the state of your access.
      // `ListRow` centres the group against the row, so a two-line title
      // block moves it not at all.
      meta={
        badge || meta || trailing ? (
          <>
            {badge}
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

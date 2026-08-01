import { Badge, Surface } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { StatusDot } from './StatusDot';
import { ToolLogo } from './ToolLogo';
import type { AttentionStatus, GemState } from '../utils/status';

export interface LibraryCardProps {
  kind: 'skill' | 'integration';
  id: string;
  name: string;
  description: string;
  owned: boolean;
  status: AttentionStatus;
  /**
   * The skill's declared `version:` frontmatter, when it has one. Most skills
   * do not, so this slot is empty far more often than it is full — which is
   * why it is a quiet right-aligned note and not a badge.
   */
  version?: string;
  /** Open the item. The whole card is the target. */
  onOpen(): void;
}

const STATUS_INK: Record<GemState, string> = {
  ok: 'text-ok',
  warn: 'text-wait',
  err: 'text-danger',
};

/**
 * One gallery card — the prototype's `.card` (line 158).
 *
 * The whole card is one `<button>` that opens the item, which is why there is
 * no ⓘ affordance any more: it used to exist because the card body was spent
 * on toggling loadout membership, so opening needed its own target. With the
 * loadout gone the card has a single action, and a card with a single action
 * should not have two controls.
 *
 * The two-line clamp on the description is load-bearing, not cosmetic. Skill
 * descriptions run to full paragraphs, so without it a card grows to whatever
 * its longest text needs and the grid stops being a grid. `min-h` sets the
 * floor, the clamp sets the ceiling, and every card lands between them.
 */
export function LibraryCard({
  kind,
  id,
  name,
  description,
  owned,
  status,
  version,
  onOpen,
}: LibraryCardProps) {
  /**
   * What the bottom-left says, and when it says anything at all.
   *
   * A TOOL always states its connection, because that is the only question
   * anyone asks of a tool and the answer changes without warning — `Connected`
   * or `Needs …`, never a third thing.
   *
   * A SKILL is silent unless something is in its way. A skill has no state of
   * its own to report; a green "Ready" on every skill in the grid is a row of
   * noise that says nothing, and it buries the two cards that DO need you.
   */
  const footNote = kind === 'integration' || status.state !== 'ok' ? status : null;

  return (
    <Surface
      as="button"
      type="button"
      data-testid={`library-card-${kind}-${id}`}
      interactive
      padded
      className="flex min-h-28 flex-col gap-1.5 text-left"
      onClick={onOpen}
    >
      <span className="flex items-center gap-2">
        {/* Only tools carry a mark. A skill has no brand to recognise — its
            name IS the thing — and a monogram beside every skill would add a
            column of coloured squares that distinguish nothing. */}
        {kind === 'integration' && <ToolLogo slug={id} name={name} />}
        <span className="truncate text-lede font-semibold text-ink">{name}</span>
        {owned && (
          <Badge tone="outline" size="xs" className="shrink-0 uppercase">
            Owner
          </Badge>
        )}
      </span>

      {description && (
        <span className="line-clamp-2 text-detail text-ink-muted">{description}</span>
      )}

      {/* The foot exists only when it has something to say. An empty strip
          still costs the two lines of description their room, so a healthy
          skill with no version simply ends after its description — which is
          what makes the cards that DO carry a note stand out at a glance. */}
      {(footNote || version) && (
        <span className="mt-auto flex items-center gap-1.5 pt-2 text-meta text-ink-faint">
          {footNote && (
            <span className={cn('flex items-center gap-1.5 font-semibold', STATUS_INK[footNote.state])}>
              <StatusDot state={footNote.state} />
              {footNote.text}
            </span>
          )}
          {/* `ml-auto` on the version, not on the status: the version is the
              thing pinned right, and it has to stay pinned there whether or
              not a status is sharing the row. */}
          {version && <span className="ml-auto shrink-0 tabular-nums">v{version}</span>}
        </span>
      )}
    </Surface>
  );
}

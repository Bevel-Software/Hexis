import { Badge, Surface } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { StatusDot } from './StatusDot';
import type { AttentionStatus, GemState } from '../utils/status';

export interface LibraryCardProps {
  kind: 'skill' | 'integration';
  id: string;
  name: string;
  description: string;
  owned: boolean;
  /** Rendered in the footer ONLY when it needs attention (mock rule). */
  status: AttentionStatus;
  /** Open the item. The whole card is the target. */
  onOpen(): void;
}

const STATUS_INK: Record<GemState, string> = {
  ok: 'text-ok',
  warn: 'text-wait',
  err: 'text-danger',
  off: 'text-ink-faint',
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
  onOpen,
}: LibraryCardProps) {
  const needsAttention = kind === 'integration' && status.state !== 'ok';

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

      <span className="mt-auto flex items-center gap-1.5 pt-2 text-meta text-ink-faint">
        <span className="text-label uppercase">{kind === 'skill' ? 'Skill' : 'Integration'}</span>
        {needsAttention && (
          <span
            className={cn(
              'ml-auto flex items-center gap-1.5 font-semibold',
              STATUS_INK[status.state],
            )}
          >
            <StatusDot state={status.state} />
            {status.text}
          </span>
        )}
      </span>
    </Surface>
  );
}

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
  picked: boolean;
  /** Card-body click: toggle loadout membership. */
  onToggle(): void;
  /** Top-right info button: open the detail dialog. */
  onInfo(): void;
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
 * The card stays a `div[role=button]` rather than a `<button>` because it
 * contains the ⓘ button, and a button inside a button is invalid HTML that
 * browsers resolve by dropping the inner one.
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
  picked,
  onToggle,
  onInfo,
}: LibraryCardProps) {
  const needsAttention = kind === 'integration' && status.state !== 'ok';

  return (
    <Surface
      data-testid={`library-card-${kind}-${id}`}
      interactive
      padded
      role="button"
      tabIndex={0}
      aria-pressed={picked}
      aria-label={`${name} — ${picked ? 'remove from loadout' : 'add to loadout'}`}
      className={cn(
        'relative flex min-h-28 flex-col gap-1.5 text-left',
        picked && 'border-transparent bg-ok-soft hover:bg-ok-soft',
      )}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <button
        type="button"
        aria-label={`Details for ${name}`}
        title="Details"
        className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full border border-line bg-surface text-meta font-semibold text-ink-faint transition-colors hover:border-line-strong hover:text-ink"
        onClick={(e) => {
          e.stopPropagation();
          onInfo();
        }}
      >
        i
      </button>

      <div className="flex items-center gap-2 pr-7">
        <span className="truncate text-lede font-semibold text-ink">{name}</span>
        {owned && (
          <Badge tone="outline" size="xs" className="shrink-0 uppercase">
            Owner
          </Badge>
        )}
      </div>

      {description && <p className="line-clamp-2 text-detail text-ink-muted">{description}</p>}

      <div className="mt-auto flex items-center gap-1.5 pt-2 text-meta text-ink-faint">
        <span className="text-label uppercase">{kind === 'skill' ? 'Skill' : 'Integration'}</span>
        {needsAttention && (
          <span className={cn('ml-auto flex items-center gap-1.5 font-semibold', STATUS_INK[status.state])}>
            <StatusDot state={status.state} />
            {status.text}
          </span>
        )}
      </div>
    </Surface>
  );
}

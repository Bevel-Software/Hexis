import { useState } from 'react';
import { Button, Surface } from '../../../../shared/components';
import { cn } from '../../../../lib/utils';
import { collapseUnchanged, type DiffLine } from '../../utils/diff';

export interface SkillChangeBoxProps {
  /** File the proposal is against, relative to the skill folder. */
  file: string;
  /** Display name of whoever proposed it. */
  author: string;
  /** Already-formatted, e.g. "today" or "2 Aug". */
  when: string;
  /** The caller wrote this one. */
  mine: boolean;
  /** The caller decides this one (owns the skill). */
  canDecide: boolean;
  /** The proposal diffed against the file as it stands NOW; null while loading. */
  diff: DiffLine[] | null;
  /**
   * The change cannot land as it stands — the file moved under it. Discovered
   * when a merge is attempted, which is the only moment git can answer the
   * question honestly.
   */
  blocked?: boolean;
  /** Who the decision is waiting on, for the non-owner's footer. */
  owner?: string;
  busy?: boolean;
  onApprove?(): void;
  onDecline?(): void;
  onWithdraw?(): void;
  /** Owner-side: read the whole change request, not just this file's part. */
  onOpenFull?(): void;
}

/**
 * One proposed change to one file — the prototype's `.changebox` (line 2040).
 *
 * It sits UNDER the file it is about, rather than in a review queue somewhere
 * else, because the question it asks ("should this text become that text?") is
 * unanswerable without the text. The diff is against the file as it stands now,
 * not against what the author started from: what matters to the person deciding
 * is what would change if they said yes.
 *
 * `diff === null` is the blocked case, and it is deliberately NOT approvable.
 * Merging a change written against text that has since moved silently discards
 * whoever landed first, so the box states the situation and names the fix
 * instead of offering a button that would do the wrong thing.
 */
export function SkillChangeBox({
  file,
  author,
  when,
  mine,
  canDecide,
  diff,
  blocked = false,
  owner,
  busy,
  onApprove,
  onDecline,
  onWithdraw,
  onOpenFull,
}: SkillChangeBoxProps) {
  const who = mine ? 'You' : author;
  const first = author.split(' ')[0];

  return (
    <Surface
      tone="surface"
      radius="lg"
      elevation="card"
      className={cn('mt-3 overflow-hidden', blocked && 'border-wait')}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="text-detail text-ink">
          <b className="font-semibold">{who}</b> proposed a change · {when}
        </span>
        <span className="ml-auto truncate font-mono text-meta text-ink-faint">{file}</span>
      </div>

      {diff === null ? (
        <p className="px-3.5 py-4 text-center text-detail text-ink-faint">Loading the change…</p>
      ) : (
        <CollapsedDiffView lines={diff} />
      )}

      <div
        className={cn(
          'flex flex-wrap items-center gap-3 px-3.5 py-2.5',
          blocked ? 'bg-wait-soft' : 'border-t border-line',
        )}
      >
        {blocked ? (
          <>
            <span className="text-detail font-semibold text-wait">
              Blocked — these lines changed after this was written
            </span>
            <span className="w-full text-meta text-ink-muted">
              {mine
                ? 'Redo it against the current text and propose again.'
                : `${first} has to redo it against the current text and propose again. It cannot be approved as it stands.`}
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-detail font-semibold text-wait">
              <span className="size-1.5 rounded-full bg-wait-dot" />
              Pending approval
            </span>
            <span className="text-meta text-ink-faint">
              {canDecide ? 'You decide — you own this.' : `Waiting on ${owner ?? 'the owner'}`}
            </span>
          </>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-2">
          {onOpenFull && (
            <Button variant="quiet" size="tiny" onClick={onOpenFull} disabled={busy}>
              Read the whole change
            </Button>
          )}
          {mine && onWithdraw && (
            <Button variant="quiet" size="tiny" onClick={onWithdraw} disabled={busy}>
              Withdraw
            </Button>
          )}
          {canDecide && onDecline && (
            <Button variant="quiet" size="tiny" onClick={onDecline} disabled={busy}>
              Decline
            </Button>
          )}
          {canDecide && !blocked && onApprove && (
            <Button variant="primary" size="tiny" onClick={onApprove} disabled={busy}>
              {busy ? 'Working…' : 'Approve'}
            </Button>
          )}
        </span>
      </div>
    </Surface>
  );
}

function CollapsedDiffView({ lines }: { lines: DiffLine[] }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded
    ? lines.map((l) => l)
    : collapseUnchanged(lines);

  return (
    <div className="max-h-96 overflow-y-auto px-3.5 py-3">
      <pre className="lib-sug whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
        {rows.map((r, i) =>
          r.kind === 'gap' ? (
            <button
              key={i}
              type="button"
              className="my-1 block w-full rounded-xs bg-sunken py-0.5 text-center text-meta text-ink-faint hover:text-ink"
              onClick={() => setExpanded(true)}
            >
              {r.count} unchanged {r.count === 1 ? 'line' : 'lines'}
            </button>
          ) : r.kind === 'removed' ? (
            <del key={i} className="block">
              {r.text || ' '}
            </del>
          ) : r.kind === 'added' ? (
            <ins key={i} className="block">
              {r.text || ' '}
            </ins>
          ) : (
            <div key={i}>{r.text || ' '}</div>
          ),
        )}
      </pre>
    </div>
  );
}

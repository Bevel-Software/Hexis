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
   * This file already reads the way the proposal wants it to — someone landed
   * the same edit first, or the author reverted it. There is nothing here to
   * decide, though the change request may still touch other files.
   */
  upToDate?: boolean;
  /**
   * The change cannot land as it stands — the file moved under it. Discovered
   * when a merge is attempted, which is the only moment git can answer the
   * question honestly.
   */
  blocked?: boolean;
  /**
   * Why the last apply did not land, in the words the server used. Distinct
   * from `blocked`: a conflict withdraws Approve because retrying cannot help,
   * whereas "waiting on approval from Design" is a state that can change under
   * the reader, so the button stays.
   */
  refusal?: string | null;
  /** Who the decision is waiting on, for the non-owner's footer. */
  owner?: string;
  busy?: boolean;
  /**
   * What the apply is doing right now, so the label names the step instead of
   * a generic wait. Recording approvals and merging are separately slow — the
   * merge alone runs to tens of seconds server-side.
   */
  phase?: 'idle' | 'approving' | 'applying';
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
 * Two independent states, easily confused:
 *
 *  - `diff === null` means the comparison has not ARRIVED yet — one of the two
 *    file reads is still in flight — and the box says "Loading the change…".
 *    It is never a claim about the change itself; an absent diff is never
 *    rendered as an empty or whole-file one.
 *  - `blocked` means the change cannot LAND: the file moved under it, which git
 *    only reveals when a merge is attempted. It withholds Approve (Decline and
 *    Withdraw stay, since both are still valid answers) because merging a
 *    change written against text that has since moved silently discards
 *    whoever landed first. The box names the fix instead of offering a button
 *    that would do the wrong thing.
 */
export function SkillChangeBox({
  file,
  author,
  when,
  mine,
  canDecide,
  diff,
  upToDate = false,
  blocked = false,
  refusal = null,
  owner,
  busy,
  phase = 'idle',
  onApprove,
  onDecline,
  onWithdraw,
  onOpenFull,
}: SkillChangeBoxProps) {
  const who = mine ? 'You' : author;
  const first = author.split(' ')[0];
  // Name the step. "Approving…" and "Applying…" are different waits with
  // different lengths, and a single "Working…" over both makes the slower one
  // look hung.
  const busyLabel =
    phase === 'approving' ? 'Approving…' : phase === 'applying' ? 'Applying…' : 'Working…';

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

      {/* No diff area when there is no difference — an empty pane under a
          "what changed?" heading reads as a rendering failure. */}
      {upToDate ? null : diff === null ? (
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
        {upToDate ? (
          <>
            <span className="text-detail font-semibold text-ok">Already up to date</span>
            <span className="w-full text-meta text-ink-muted">
              This file already reads the way this change proposes. The change request may still
              touch other files.
            </span>
          </>
        ) : blocked ? (
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
            {/* ONE live region across the whole idle↔busy transition, rather
                than one mounted when the apply starts. A live region inserted
                in the same breath as its text is widely not announced at all —
                assistive tech watches regions it was already holding. So this
                element persists and only its TEXT changes, which is the change
                that gets read out. It is also why the busy state is not a
                separate branch: a branch would unmount this one.

                The wait itself is worth announcing because the merge runs on
                the server after the request returns and takes tens of seconds
                — a silent button reads as a click that did nothing. */}
            <span
              role="status"
              aria-live="polite"
              className="flex items-center gap-1.5 text-detail font-semibold text-wait"
            >
              <span className={cn('size-1.5 rounded-full bg-wait-dot', busy && 'animate-pulse')} />
              {busy
                ? phase === 'approving'
                  ? 'Recording your approval…'
                  : 'Applying the change…'
                : 'Pending approval'}
            </span>
            {!busy && (
              <span className="text-meta text-ink-faint">
                {canDecide ? 'You decide — you own this.' : `Waiting on ${owner ?? 'the owner'}`}
              </span>
            )}
            {/* What the server said, verbatim. The gate names the files and the
                people it is still waiting on, and that sentence is the whole
                value — paraphrasing it to "couldn't approve" would strip the
                one part the owner can act on. */}
            {refusal && !busy && (
              <span role="alert" className="w-full text-meta text-danger">
                {refusal}
              </span>
            )}
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
          {/* Both verdicts act on the WHOLE change request, so neither is
              offered against a file with nothing to show: approving would
              merge, and declining would kill, a request whose other files this
              panel is not displaying. "Read the whole change" is the honest
              route to that decision. */}
          {canDecide && !upToDate && onDecline && (
            <Button variant="quiet" size="tiny" onClick={onDecline} disabled={busy}>
              Decline
            </Button>
          )}
          {canDecide && !upToDate && !blocked && onApprove && (
            <Button variant="primary" size="tiny" onClick={onApprove} disabled={busy}>
              {busy ? busyLabel : 'Approve'}
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

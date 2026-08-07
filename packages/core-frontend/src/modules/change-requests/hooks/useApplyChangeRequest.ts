import { useCallback, useEffect, useRef, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { useEventBus } from '../../workflow/state/event-bus.context';
import { fetchPrDetail } from '../../pr/services/pr-detail.api';
import { approvePrFile } from '../../pr/services/pr-approvals.api';
import { mergePullRequest } from '../../pr/services/pr-merge.api';

/**
 * Safety net for the async apply: if neither a `change-request-merged` nor a
 * `change-request-merge-failed` event lands in this window (a dropped SSE
 * connection, a backend restart mid-merge), stop the spinner and say so rather
 * than spin forever. Same budget the change-request viewer's apply button uses.
 */
const APPLY_RESULT_TIMEOUT_MS = 180_000;

/** Polling backstop cadence for a lost outcome event. Same source as above. */
const APPLY_POLL_INTERVAL_MS = 4_000;

export type ApplyPhase = 'idle' | 'approving' | 'applying';

/** Why an apply did not land. `conflicts` is git's answer, not a guess. */
export interface ApplyRefusal {
  reason: string;
  conflicts: boolean;
}

export interface ApplyChangeRequest {
  /** The change request an apply is currently running for, if any. */
  activeCr: number | null;
  phase: ApplyPhase;
  /** Refusals by change-request number, from the attempt that produced them. */
  refusals: Map<number, ApplyRefusal>;
  apply(cr: PullRequestSummary): void;
}

/**
 * Approving a change request, end to end and honestly reported.
 *
 * TWO things this exists to get right, both of which the Library got wrong by
 * calling `mergePullRequest` and awaiting it:
 *
 * 1. **Approving is not merging.** The merge gate requires a recorded per-file
 *    approval from an eligible approver for every markdown file that has
 *    owners — which is precisely the case the skill page is built for, since a
 *    SKILL.md inside a group folder inherits that folder's `access.md`. Going
 *    straight to merge is refused with "Waiting on approval for …". So the
 *    owner's click records the approvals FIRST, then merges. Files the caller
 *    is not eligible for are skipped rather than treated as failures: the gate
 *    is the authority on whether what remains is enough, and it reports what is
 *    still outstanding by name.
 *
 * 2. **The merge is asynchronous.** `POST …/merge` acks 202 and runs the merge
 *    in the background, because gate re-validation plus `gh pr merge` can
 *    outlive the gateway's idle timeout. Every conflict, gate block and git
 *    error therefore arrives over the event bus as
 *    `change-request-merge-failed` — NEVER as a rejection of the call. Awaiting
 *    the POST tells you the server agreed to try, and a success message printed
 *    there is a claim nothing has verified. This waits for the outcome, with a
 *    state poll and a timeout behind the event in case the stream drops.
 */
export function useApplyChangeRequest(opts: {
  onApplied(): void;
  /**
   * Which change request was refused, and why. The number is passed because a
   * caller showing several boxes has to attribute the refusal to one of them,
   * and reading it back out of `refusals` in an effect costs a commit — during
   * which a conflicted change request still offers the button that just failed.
   */
  onFailed?(number: number, refusal: ApplyRefusal): void;
}): ApplyChangeRequest {
  const { onApplied, onFailed } = opts;
  const bus = useEventBus();
  const [activeCr, setActiveCr] = useState<number | null>(null);
  const [phase, setPhase] = useState<ApplyPhase>('idle');
  const [refusals, setRefusals] = useState<Map<number, ApplyRefusal>>(new Map());

  /**
   * The in-flight change-request number, as a ref as well as state. Merging is
   * irreversible, so re-entry has to be refused in the same tick — `phase`
   * alone leaves a one-render window where a double-click issues two merges.
   * It is also what the bus handlers read: they must ignore events for change
   * requests this hook did not start (another tab, another user).
   */
  const runningRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Latest callbacks, so the bus subscription never has to re-register.
   * Assigned in an effect rather than during render: a render React discards
   * (StrictMode, a suspended sibling) must not leave a ref pointing at
   * callbacks from a commit that never happened.
   */
  const onAppliedRef = useRef(onApplied);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onAppliedRef.current = onApplied;
    onFailedRef.current = onFailed;
  });

  const stop = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    timeoutRef.current = null;
    pollRef.current = null;
    runningRef.current = null;
    setActiveCr(null);
    setPhase('idle');
  }, []);

  const fail = useCallback(
    (number: number, refusal: ApplyRefusal) => {
      stop();
      setRefusals((m) => new Map(m).set(number, refusal));
      onFailedRef.current?.(number, refusal);
    },
    [stop],
  );

  const succeed = useCallback(() => {
    stop();
    onAppliedRef.current();
  }, [stop]);

  useEffect(() => {
    if (!bus) return;
    const offMerged = bus.subscribe('change-request-merged', (e) => {
      if (runningRef.current !== e.number) return;
      succeed();
    });
    const offFailed = bus.subscribe('change-request-merge-failed', (e) => {
      if (runningRef.current !== e.number) return;
      fail(e.number, {
        reason: e.reason || "Couldn't apply this change.",
        conflicts: e.conflicts === true,
      });
    });
    return () => {
      offMerged();
      offFailed();
    };
  }, [bus, succeed, fail]);

  // Timers are cleared on unmount only — not on every re-subscribe above, which
  // would disarm the safety net of an apply that is still running.
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const apply = useCallback(
    (cr: PullRequestSummary) => {
      if (runningRef.current !== null) return;
      runningRef.current = cr.number;
      setActiveCr(cr.number);
      setPhase('approving');
      setRefusals((m) => {
        if (!m.has(cr.number)) return m;
        const next = new Map(m);
        next.delete(cr.number);
        return next;
      });

      void (async () => {
        try {
          // Fresh, because approvals pin to the current head: approving against
          // a cached head would record consent to a revision nobody read.
          const detail = await fetchPrDetail(cr.number, { fresh: true });
          if (runningRef.current !== cr.number) return;

          for (const a of detail.approvals) {
            if (a.isApproved) continue;
            // No eligible approvers means the gate ignores the file entirely.
            const gateCares =
              a.eligibleApprovers.roles.length > 0 || a.eligibleApprovers.users.length > 0;
            if (!gateCares) continue;
            // A refusal here is "not your file", which is normal on a change
            // request spanning several owners — let the gate below decide
            // whether what did get approved is enough.
            await approvePrFile(cr.number, a.path).catch(() => undefined);
            if (runningRef.current !== cr.number) return;
          }

          setPhase('applying');
          // 202 ack only — the outcome arrives on the bus subscription above.
          await mergePullRequest(cr.number);
          // The outcome can beat this ack home (SSE is a separate connection);
          // only arm the safety net if this attempt is still the running one,
          // so a timer cannot fire into a later attempt.
          if (runningRef.current !== cr.number) return;
          timeoutRef.current = setTimeout(() => {
            if (runningRef.current !== cr.number) return;
            fail(cr.number, {
              reason: 'Applying is taking longer than expected. Reload to check whether it landed.',
              conflicts: false,
            });
          }, APPLY_RESULT_TIMEOUT_MS);
          // Backstop for a lost event. `merged` is the ONLY state that means
          // the apply landed — `closed` means somebody declined or withdrew it
          // while this was running, and treating "left `open`" as success
          // reported a declined change as applied.
          pollRef.current = setInterval(() => {
            if (runningRef.current !== cr.number) return;
            void fetchPrDetail(cr.number, { fresh: true })
              .then((latest) => {
                if (runningRef.current !== cr.number) return;
                if (latest.state === 'merged') succeed();
                else if (latest.state !== 'open') {
                  fail(cr.number, {
                    reason: 'This change request was closed before it could be applied.',
                    conflicts: false,
                  });
                }
              })
              .catch(() => undefined);
          }, APPLY_POLL_INTERVAL_MS);
        } catch (err) {
          // The POST itself failed (auth, network, a hard gate block returned
          // synchronously) — no background job started, so report it now
          // instead of waiting for an event that will never come.
          if (runningRef.current !== cr.number) return;
          fail(cr.number, {
            reason: err instanceof Error ? err.message : "Couldn't apply this change.",
            conflicts: false,
          });
        }
      })();
    },
    [fail, succeed],
  );

  return { activeCr, phase, refusals, apply };
}

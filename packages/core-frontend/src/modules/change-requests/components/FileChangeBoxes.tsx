import { useCallback, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { Banner, Button } from '../../../shared/components';
import { cancelPullRequest } from '../../pr/services/pr-cancel.api';
import { useOpenChangeRequests } from '../../workspace/hooks/useOpenChangeRequests';
import { PR_STALE_EVENT } from '../../../core/events';
import { useApplyChangeRequest } from '../hooks/useApplyChangeRequest';
import { useCrFileDiffs } from '../hooks/useCrFileDiffs';
import { useDefaultBranchFile } from '../hooks/useFileOnBranch';
import { changeAuthorName, formatWhen } from '../utils/author';
import { ChangeBox } from './ChangeBox';
import { ChangeRequestDialog } from './ChangeRequestDialog';

export interface FileChangeBoxesProps {
  /** Repo-root-relative path of the open file (kbDirName stripped). */
  repoRelativePath: string;
  /** Open requests touching this file. */
  requests: PullRequestSummary[];
  /** The caller may write this file — they decide. */
  canDecide: boolean;
  /** Who the decision waits on, for the non-owner's footer. */
  ownersLabel: string;
  /** The default branch just changed under this file — a request landed. */
  onApplied(): void;
}

/**
 * Every open proposal on one file, as boxes UNDER the file it is about —
 * exactly the skill page's presentation, orchestrated once so any surface
 * showing a document can mount it. The question a box asks ("should this
 * text become that text?") is unanswerable without the text, which is why
 * this is not a banner pointing at a review queue somewhere else.
 *
 * Owns the whole decision loop: per-request diffs against the default
 * branch, Approve (approvals → merge → wait for the outcome event),
 * Decline, the author's Withdraw, and "Read the whole change" opening the
 * shared {@link ChangeRequestDialog}. Resolutions dispatch
 * {@link PR_STALE_EVENT} so the tree dots, the tabs and this very list
 * refetch.
 */
export function FileChangeBoxes({
  repoRelativePath,
  requests,
  canDecide,
  ownersLabel,
  onApplied,
}: FileChangeBoxesProps) {
  const { mineNumbers } = useOpenChangeRequests();
  /** Bumped after every resolution so the branch reads re-run against fresh content. */
  const [revision, setRevision] = useState(0);
  const [busyCr, setBusyCr] = useState<number | null>(null);
  /** Conflicts discovered by a merge attempt — Approve is withdrawn for these. */
  const [blockedCrs, setBlockedCrs] = useState<Set<number>>(new Set());
  const [applied, setApplied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The request opened full-screen in the shared dialog, if any. */
  const [openCr, setOpenCr] = useState<PullRequestSummary | null>(null);

  const rawOnMain = useDefaultBranchFile(repoRelativePath, revision);
  const crDiffs = useCrFileDiffs(requests, repoRelativePath, rawOnMain, revision);

  const resolved = useCallback(() => {
    setApplied(true);
    setRevision((r) => r + 1);
    window.dispatchEvent(new Event(PR_STALE_EVENT));
    onApplied();
  }, [onApplied]);

  const applying = useApplyChangeRequest({
    onApplied: resolved,
    onFailed(number, refusal) {
      if (refusal.conflicts) {
        setBlockedCrs((s) => (s.has(number) ? s : new Set(s).add(number)));
      }
    },
  });

  /** Decline (an owner's no) and Withdraw (the author's) are the same cancel. */
  const cancel = useCallback(async (cr: PullRequestSummary) => {
    setBusyCr(cr.number);
    setActionError(null);
    try {
      await cancelPullRequest(cr.number);
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't resolve this change.");
    } finally {
      setBusyCr(null);
    }
  }, []);

  const boxes = requests.filter((c) => c.touchedNodePaths.includes(repoRelativePath));

  return (
    <>
      {applied && (
        <Banner role="status" tone="ok" aria-live="polite" className="mt-3">
          <div className="flex items-center gap-2">
            <span className="flex-1">Applied — the file now reads with that change.</span>
            <Button variant="quiet" size="sm" title="Dismiss" onClick={() => setApplied(false)}>
              Dismiss
            </Button>
          </div>
        </Banner>
      )}
      {actionError && (
        <Banner role="alert" tone="danger" aria-live="assertive" className="mt-3">
          {actionError}
        </Banner>
      )}

      {boxes.map((cr) => {
        const mine = mineNumbers.has(cr.number);
        // `[]` is the diff hook's "overtaken" answer — the proposal and the
        // file now say the same thing — distinct from `null`, which only
        // means a side has not arrived yet.
        const fileDiff = crDiffs.get(cr.number) ?? null;
        return (
          <ChangeBox
            key={cr.number}
            file={repoRelativePath.slice(repoRelativePath.lastIndexOf('/') + 1)}
            author={changeAuthorName(cr)}
            when={formatWhen(cr.createdAt)}
            mine={mine}
            canDecide={canDecide && !mine}
            diff={fileDiff}
            upToDate={fileDiff !== null && fileDiff.length === 0}
            blocked={blockedCrs.has(cr.number)}
            // A conflict already speaks through `blocked`; repeating it as a
            // refusal line would say the same thing twice in one box.
            refusal={
              applying.refusals.get(cr.number)?.conflicts === false
                ? (applying.refusals.get(cr.number)?.reason ?? null)
                : null
            }
            owner={ownersLabel}
            busy={busyCr === cr.number || applying.activeCr === cr.number}
            phase={applying.activeCr === cr.number ? applying.phase : 'idle'}
            onApprove={() => applying.apply(cr)}
            onDecline={() => void cancel(cr)}
            onWithdraw={() => void cancel(cr)}
            onOpenFull={() => setOpenCr(cr)}
          />
        );
      })}

      {openCr && (
        <ChangeRequestDialog
          cr={openCr}
          onClose={() => setOpenCr(null)}
          onResolved={(kind) => {
            setOpenCr(null);
            if (kind === 'applied') resolved();
            else window.dispatchEvent(new Event(PR_STALE_EVENT));
          }}
        />
      )}
    </>
  );
}

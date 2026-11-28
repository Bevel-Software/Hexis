import { useCallback, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { Banner, Button } from '../../../shared/components';
import { cancelPullRequest, revertPrFile } from '../../pr';
import { useOpenChangeRequests, displayFileName, fileNameTooltip, isBinaryFile } from '../../workspace';
import { PR_STALE_EVENT } from '../../../core/events';
import { refusalLine, useApplyChangeRequest } from '../hooks/useApplyChangeRequest';
import { useCrFileDiffs } from '../hooks/useCrFileDiffs';
import { changeAuthorName, formatWhen } from '../utils/author';
import { conflictResolutionPrompt } from '../utils/conflict';
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
  /**
   * For a viewer who can decide: how many approvers besides them the file
   * still waits on. Feeds "Waiting on you and N others".
   */
  othersPending?: number;
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
 * Owns the whole decision loop: per-request diffs from each request's fork
 * point (see `useCrFileDiffs`), Approve (approvals → merge → wait for the outcome event),
 * Decline (this file only), the author's Withdraw (the whole request), and
 * "Read the whole change" opening the
 * shared {@link ChangeRequestDialog}. Resolutions dispatch
 * {@link PR_STALE_EVENT} so the tree dots, the tabs and this very list
 * refetch.
 */
export function FileChangeBoxes({
  repoRelativePath,
  requests,
  canDecide,
  ownersLabel,
  othersPending,
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

  // Binary files never diff (see the box's `binary` prop) — so never fetch
  // and decode their default-branch bytes either.
  const binary = isBinaryFile(repoRelativePath);
  const crDiffs = useCrFileDiffs(requests, repoRelativePath, revision);

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

  /** Withdraw: the author takes back their whole request. */
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

  /**
   * Decline: an owner's no to THIS file, which is what the box sits under and
   * asks about. Only this file's change leaves the request (the dialog's
   * "Decline this file" and the tree's "Revert file…"); the request's other
   * files stay proposed. Declining its last file closes the request.
   */
  const decline = useCallback(
    async (cr: PullRequestSummary) => {
      setBusyCr(cr.number);
      setActionError(null);
      try {
        await revertPrFile(cr.number, repoRelativePath);
        window.dispatchEvent(new Event(PR_STALE_EVENT));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Couldn't decline this change.");
      } finally {
        setBusyCr(null);
      }
    },
    [repoRelativePath],
  );

  const boxes = requests.filter((c) => c.touchedNodePaths.includes(repoRelativePath));

  return (
    <>
      {applied && (
        <Banner role="status" tone="ok" aria-live="polite" className="mt-3">
          <div className="flex items-center gap-2">
            <span className="flex-1">Published: the file now reads with that change.</span>
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
        const read = crDiffs.get(cr.number) ?? null;
        const fileDiff = read === 'unreadable' ? null : read;
        return (
          <ChangeBox
            key={cr.number}
            file={displayFileName(repoRelativePath)}
            fileTitle={fileNameTooltip(repoRelativePath)}
            author={changeAuthorName(cr)}
            when={formatWhen(cr.createdAt)}
            mine={mine}
            // Approval rights come from the file, not from authorship: an
            // eligible approver decides their own proposal too (the gate
            // accepts it and records it as a self-approval).
            canDecide={canDecide}
            diff={fileDiff}
            binary={binary}
            unreadable={read === 'unreadable'}
            upToDate={fileDiff !== null && fileDiff.length === 0}
            blocked={blockedCrs.has(cr.number)}
            conflictPrompt={conflictResolutionPrompt(cr)}
            refusal={refusalLine(cr, applying.refusals)}
            owner={ownersLabel}
            othersPending={othersPending}
            busy={busyCr === cr.number || applying.activeCr === cr.number}
            phase={applying.activeCr === cr.number ? applying.phase : 'idle'}
            onApprove={() => applying.apply(cr)}
            onDecline={() => void decline(cr)}
            onWithdraw={() => void cancel(cr)}
            onOpenFull={() => setOpenCr(cr)}
          />
        );
      })}

      {openCr && (
        <ChangeRequestDialog
          cr={openCr}
          onClose={() => setOpenCr(null)}
          // Applied: published, the same banner the box's own Approve shows.
          // Closed (its last file declined, or the request deleted): nothing
          // was published, so the lists refresh and no banner says otherwise.
          onResolved={(outcome) => {
            setOpenCr(null);
            if (outcome === 'applied') resolved();
            else window.dispatchEvent(new Event(PR_STALE_EVENT));
          }}
        />
      )}
    </>
  );
}

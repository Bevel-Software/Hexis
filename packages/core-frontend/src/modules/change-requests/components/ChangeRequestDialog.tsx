import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  type FileDiffPayload,
  type PullRequestDetail,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import '../change-requests.css';
import { Banner, Button, Surface } from '../../../shared/components';
import { useModalLayer } from '../../../shared/components/useModalLayer';
import { cn } from '../../../lib/utils';
import { AuthContext } from '../../auth/state/auth.context';
import { fetchPrDetail } from '../../pr/services/pr-detail.api';
import { approvePrFile, revertPrFile, unapprovePrFile } from '../../pr/services/pr-approvals.api';
import { deleteChangeRequest } from '../../pr/services/pr-cancel.api';
import { useApplyChangeRequest } from '../hooks/useApplyChangeRequest';
import { readFileOnBranch } from '../services/change-requests.api';
import { changeAuthorName } from '../utils/author';
import { conflictResolutionPrompt } from '../utils/conflict';
import { ConflictHelp } from './ConflictHelp';
import { useDefaultBranchFile } from '../hooks/useFileOnBranch';
import { diffLines, type DiffLine } from '../utils/diff';
import { isBinaryFile } from '../../workspace/components/renderers';
import { MarkdownDiffViewer } from '../../review/components/MarkdownDiffViewer';
import { CrFileTree, type CrTreeFileState } from './CrFileTree';

/**
 * Extra context for the file list — NOT a filter. The dialog always shows
 * EVERY file the request touches, repo-relative, whatever surface opened it:
 * a decision about the whole request must not hide part of it behind a badge.
 * A scope only ADDS the surface's own files (a skill's SKILL.md and bundle)
 * so the owner can read the untouched parts of the thing under review too.
 */
export interface ChangeRequestScope {
  /** Repo-root-relative folder, no trailing slash (e.g. `Groups/gtm/rfi`). */
  prefix: string;
  /** Files that ALWAYS list, relative to `prefix`, whether touched or not. */
  baseFiles: string[];
}

interface ChangeRequestDialogProps {
  cr: PullRequestSummary;
  scope?: ChangeRequestScope;
  onClose(): void;
  /** Applying is the only verdict this view reaches. Declining a change
   *  request lives on the skill page, beside the request's own row. */
  onResolved(): void;
}

/**
 * The whole change request, as one decision — Juan's change-request view,
 * and THE change-request view for every surface (the skill page opens it
 * over a skill scope; the Knowledge viewer opens it unscoped).
 *
 * The per-file boxes answer "what does this do to the file I am reading?".
 * This answers the different question an owner has to answer before applying
 * anything: what does this change do as a WHOLE? So it reads top-down as an
 * argument — what is being asked, why, how big it is, and only then the
 * files — rather than as two panels to compare word by word.
 *
 * The layout is deliberately fixed to the viewport: the buttons never move and
 * the document scrolls to meet them. A decision surface where the verdict
 * scrolls off screen invites the reader to act before reaching the bottom.
 */
export function ChangeRequestDialog({
  cr,
  scope,
  onClose,
  onResolved,
}: ChangeRequestDialogProps) {
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchContents, setBranchContents] = useState<Record<string, string | null>>({});
  /** Files whose branch copy could not be read — shown as such, never guessed at. */
  const [unreadable, setUnreadable] = useState<Set<string>>(new Set());
  const [blocked, setBlocked] = useState(false);

  const isTop = useModalLayer(true);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isTop()) {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isTop, onClose]);

  useEffect(() => {
    let cancelled = false;
    fetchPrDetail(cr.number)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Couldn't load this change request.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cr.number]);

  // EVERYTHING is repo-relative, scoped or not — the scope's baseFiles are
  // lifted to full paths, and every touched file lists whatever folder it is
  // in. The dialog is a decision about the WHOLE request; a file it touches
  // outside the surface that opened it is part of the decision, not a badge.
  const mainFiles = useMemo(
    () => (scope ? scope.baseFiles.map((f) => `${scope.prefix}/${f}`) : []),
    [scope],
  );
  const changedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const f of detail?.files ?? []) set.add(f.path);
    return set;
  }, [detail]);
  const addedFiles = useMemo(
    () => (detail?.files ?? []).filter((f) => f.status === 'added').map((f) => f.path),
    [detail],
  );
  const allFiles = useMemo(() => {
    const touched = [...changedFiles].filter((f) => !mainFiles.includes(f));
    return [...mainFiles, ...touched];
  }, [mainFiles, changedFiles]);

  /** The scale line: how much this touches, in the KB's own terms. */
  const scale = useMemo(() => {
    const files = detail?.files ?? [];
    return {
      files: files.length,
      plus: files.reduce((n, f) => n + f.additions, 0),
      minus: files.reduce((n, f) => n + f.deletions, 0),
    };
  }, [detail]);

  /**
   * Land on the first changed file, until the reader picks one — DERIVED, so
   * the landing happens on the render the detail arrives rather than one render
   * later. `picked` staying null is what keeps "I haven't chosen yet" distinct
   * from "I chose the first file".
   */
  const [picked, setPicked] = useState<string | null>(null);
  const selected =
    picked ?? allFiles.find((f) => changedFiles.has(f)) ?? allFiles[0] ?? '';
  const setSelected = setPicked;

  /**
   * In-flight guard as a ref, not as a `null` placeholder written into state:
   * writing the placeholder was a synchronous setState inside the effect, which
   * costs a cascading render on every file click. The ref answers "already
   * asked?" without a render, and only the arriving content is state.
   */
  // A binary file (image, pdf, spreadsheet…) has no honest TEXT before and
  // after. Reading its bytes as a string and line-diffing them used to hang
  // the tab — the LCS differ is quadratic, and a binary blob decodes into
  // pathological "lines" — so a binary selection never fetches and never
  // diffs; it states what happened to the file instead.
  const selectedIsBinary = selected !== '' && isBinaryFile(selected);
  // Markdown renders as a DOCUMENT with red/green change blocks — the same
  // `MarkdownDiffViewer` the review flow and version history use — because the
  // person deciding on a knowledge or skill change reads prose, not source.
  // Everything else keeps the marked-source view below.
  const selectedIsMarkdown = /\.md$/i.test(selected);

  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    // `selected` is '' until the detail names any file in an unscoped dialog —
    // nothing to read yet. Binary files are never read at all (above).
    if (selected && !selectedIsBinary && !asked.current.has(selected)) {
      asked.current.add(selected);
      readFileOnBranch(cr.branch, selected)
        .then((content) => setBranchContents((c) => ({ ...c, [selected]: content })))
        // NOT `''`. An unreadable branch copy stored as empty would diff as
        // "every line deleted" — a change request that erases the file.
        .catch(() => setUnreadable((s) => new Set(s).add(selected)));
    }
  }, [selected, selectedIsBinary, cr.branch]);

  const isAdded = addedFiles.includes(selected);
  // Raw-vs-raw: the skills API hands back SKILL.md's PARSED body (frontmatter
  // stripped), and diffing that against a raw branch read renders the
  // frontmatter as a deletion and the whole file as changed.
  const mainRaw = useDefaultBranchFile(
    isAdded || !selected || selectedIsBinary ? null : selected,
  );
  const branchRaw = branchContents[selected] ?? null;

  /**
   * BOTH sides or nothing.
   *
   * The empty string is not a stand-in for "hasn't loaded". Diffing `''`
   * against the branch copy marks every line added and paints the whole file
   * green — a confident claim that this change request rewrites the file,
   * shown right above the Apply button, while the scale line beside it
   * correctly reads `+1 −1`. A file genuinely new on the branch is the ONE
   * case where an empty other side is real, and `isAdded` is how we know.
   */
  const bothSidesIn = branchRaw !== null && (isAdded || mainRaw !== null);
  // Only for the marked-source view: the markdown viewer diffs internally, so
  // computing this for an .md selection would run the same LCS twice.
  const diff: DiffLine[] | null =
    bothSidesIn && !selectedIsMarkdown
      ? diffLines(isAdded ? '' : (mainRaw as string), branchRaw as string)
      : null;
  // Memoised as a VALUE: `MarkdownDiffViewer` keys its diff computation on
  // payload identity, so an object literal built in render would make every
  // dialog state change (an apply phase tick, another file's content
  // arriving) re-run the LCS and frontmatter parse.
  const mdPayload = useMemo<FileDiffPayload | null>(
    () =>
      selectedIsMarkdown && bothSidesIn
        ? {
            path: selected,
            kind: isAdded ? 'added' : 'modified',
            baseline: isAdded ? null : mainRaw,
            current: branchRaw,
            isBinary: false,
          }
        : null,
    [selectedIsMarkdown, bothSidesIn, selected, isAdded, mainRaw, branchRaw],
  );
  const touchesSelected = changedFiles.has(selected);

  /** Per-file approval verdicts, straight from the detail. */
  const approvalByPath = useMemo(
    () => new Map((detail?.approvals ?? []).map((a) => [a.path, a])),
    [detail],
  );

  /**
   * The old CR system's rule, restored: Apply exists only when every file is
   * either already approved or approvable BY THIS VIEWER (they hold write on
   * it, so their click completes the gate). Anything less and Apply was a
   * button that walked into "Waiting on approval for …" — offering a verdict
   * the viewer cannot actually deliver.
   */
  const canApply =
    detail !== null &&
    detail.approvals.length > 0 &&
    detail.approvals.every((a) => a.isApproved || a.viewerCanApprove);

  /** Approve / revert verbs — per file, from the tree. */
  const [verbBusy, setVerbBusy] = useState(false);
  const [verbError, setVerbError] = useState<string | null>(null);
  useEffect(() => {
    setVerbError(null);
  }, [selected]);

  async function toggleApprove(path: string, approved: boolean) {
    if (!detail || verbBusy) return;
    setVerbBusy(true);
    setVerbError(null);
    try {
      const approvals = approved
        ? await unapprovePrFile(cr.number, path)
        : await approvePrFile(cr.number, path);
      setDetail((d) => (d ? { ...d, approvals } : d));
    } catch (err) {
      setVerbError(err instanceof Error ? err.message : "Couldn't record that.");
    } finally {
      setVerbBusy(false);
    }
  }

  async function revertFile(path: string) {
    if (!detail || verbBusy) return;
    setVerbBusy(true);
    setVerbError(null);
    try {
      const result = await revertPrFile(cr.number, path);
      if (result.closed) {
        // That was the last file: the request closed itself and its branch
        // is retired. The dialog's subject is gone — leave through the same
        // door an apply does, so every list behind it refreshes.
        onResolved();
        return;
      }
      // The file is out of the diff; the branch copy we cached for it is
      // stale. Refetch the detail and drop the cached read so a re-selection
      // (via the scope's baseFiles) reads the restored content.
      asked.current.delete(path);
      setBranchContents((c) => {
        const next = { ...c };
        delete next[path];
        return next;
      });
      setPicked(null);
      setDetail(await fetchPrDetail(cr.number));
    } catch (err) {
      setVerbError(err instanceof Error ? err.message : "Couldn't revert this file.");
    } finally {
      setVerbBusy(false);
    }
  }

  // Tolerant read (not useAuth): the dialog renders in tests without the
  // provider, and the email only sharpens the withdraw affordance.
  const viewerEmail = useContext(AuthContext)?.user?.email ?? '';

  /** The tree's per-file state, in the file list's order. */
  const treeFiles: CrTreeFileState[] = useMemo(() => {
    const statusByPath = new Map((detail?.files ?? []).map((f) => [f.path, f.status]));
    return allFiles.map((path) => ({
      path,
      changed: changedFiles.has(path),
      added: addedFiles.includes(path),
      status: statusByPath.get(path),
      approval: approvalByPath.get(path),
    }));
  }, [detail, allFiles, changedFiles, addedFiles, approvalByPath]);

  /** The footer's verdicts: apply plainly, apply by covering, or wait. */
  const allApproved =
    detail !== null && detail.approvals.length > 0 && detail.approvals.every((a) => a.isApproved);

  /** Admin-only: delete the request and its branch, with an armed confirm. */
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  async function deleteRequest() {
    if (deleting) return;
    setDeleting(true);
    setVerbError(null);
    try {
      await deleteChangeRequest(cr.number);
      onResolved();
    } catch (err) {
      setVerbError(err instanceof Error ? err.message : "Couldn't delete this change request.");
      setDeleting(false);
      setDeleteArmed(false);
    }
  }

  /**
   * Apply = record the approvals the gate requires, then merge, then wait for
   * the merge to land. The POST only acks — see `useApplyChangeRequest` for
   * why awaiting it is not an answer.
   */
  const applying = useApplyChangeRequest({
    onApplied: () => onResolved(),
    onFailed: (_number, refusal) => {
      // Git refusing the merge IS the conflict answer — say what happened and
      // what fixes it, instead of leaving a button that will fail again. Any
      // other refusal (an approval the gate is still waiting on, a transient
      // git error) can change under the reader, so it is reported with the
      // button intact.
      if (refusal.conflicts) setBlocked(true);
      else setError(refusal.reason);
    },
  });
  const applyBusy = applying.activeCr === cr.number;
  // Name the step: recording approvals and merging are separately slow, and one
  // label over both makes the longer half look stalled.
  const applyLabel = applying.phase === 'approving' ? 'Approving…' : 'Applying…';

  const author = changeAuthorName(cr);
  const firstName = author.split(' ')[0];
  const why = authorsReason(detail?.body);
  const [whyExpanded, setWhyExpanded] = useState(false);
  /**
   * Whether the one-line view is actually hiding anything — a short reason
   * with a pointless "Read more" beside it would be a button that does
   * nothing visible. Length is a heuristic (true truncation depends on the
   * viewport), erring toward showing the toggle: a newline always overflows a
   * single line, and ~90 characters approximates one row of the quote.
   */
  const whyOverflows = !!why && (why.includes('\n') || why.length > 90);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Change request: ${cr.title}`}
    >
      <div className="absolute inset-0 bg-scrim" onClick={onClose} />

      <Surface
        tone="surface"
        radius="2xl"
        elevation="overlay"
        className="relative mx-auto mt-[4vh] mb-[4vh] flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden"
      >
        <div className="flex items-start gap-4 px-8 pt-7">
          <div className="min-w-0 flex-1">
            <p className="text-label font-semibold uppercase text-ink-faint">Change request</p>
            <h1 className="mt-1 text-title font-medium text-ink">{cr.title}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-detail text-ink-muted">
              <span>{author}</span>
              <span aria-hidden="true" className="text-ink-faint">·</span>
              <span className="font-mono">{cr.branch}</span>
            </p>
          </div>
          <Button variant="quiet" size="sm" onClick={onClose} aria-label="Close change request">
            ✕
          </Button>
        </div>

        {/* Why, in the author's words. Omitted rather than faked when the
            request carries no description — an empty quote block reads as the
            author having said nothing worth reading.

            ONE line by default, because agents write essays: the decision is
            made on the diff below, and every line the description takes is a
            line the file grid (the dialog's one flexible region) loses. Read
            more opens the whole thing (self-scrolling past half the surface,
            so even an essay never pushes the files off screen); Hide folds it
            back to the line. */}
        {why && (
          <blockquote
            className={cn(
              'mx-8 mt-5 shrink-0 border-l-2 border-line-strong pl-4 text-body text-ink',
              whyExpanded && 'max-h-[50vh] overflow-y-auto',
            )}
          >
            {whyExpanded ? (
              <>
                <span className="whitespace-pre-wrap">{why}</span>{' '}
                <button
                  type="button"
                  className="text-detail font-medium text-ink-faint transition-colors hover:text-ink"
                  onClick={() => setWhyExpanded(false)}
                >
                  Hide
                </button>
              </>
            ) : (
              <span className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate">{why}</span>
                {whyOverflows && (
                  <button
                    type="button"
                    className="shrink-0 text-detail font-medium text-ink-faint transition-colors hover:text-ink"
                    onClick={() => setWhyExpanded(true)}
                  >
                    Read more
                  </button>
                )}
              </span>
            )}
          </blockquote>
        )}

        {/* Never state a scale we do not have yet. `detail` can take many
            seconds, and "0 files · +0 −0" is not a loading state — it is a
            claim that this change request does nothing. */}
        <p className="mt-5 px-8 text-detail tabular-nums text-ink-faint">
          {detail === null ? (
            'Measuring the change…'
          ) : (
            <>
              {scale.files} file{scale.files === 1 ? '' : 's'} ·{' '}
              <span className="text-ok">+{scale.plus}</span>{' '}
              <span className="text-danger">−{scale.minus}</span>
            </>
          )}
        </p>

        {error && (
          <Banner tone="danger" role="alert" className="mx-8 mt-4">
            {error}
          </Banner>
        )}

        {blocked && (
          <Banner tone="wait" role="alert" className="mx-8 mt-4">
            <b className="font-semibold">Can't apply</b>: files changed after {firstName} wrote
            this, so there is no honest before and after to apply. It has to be redone against
            the current text.
            <div className="mt-2.5">
              <ConflictHelp prompt={conflictResolutionPrompt(cr)} />
            </div>
          </Banner>
        )}

        {/* A request that no longer changes anything — everything it proposed
            has since landed on (or been removed from) the target, or its only
            change was one the merge never takes (roles.yaml). The file grid
            below would render a blank pill over an eternal "Loading…", which
            reads as a hang; the truth is simpler and gets said instead. */}
        {detail !== null && allFiles.length === 0 ? (
          <div className="mt-4 min-h-0 flex-1 px-8">
            <p className="mx-auto max-w-[52ch] py-10 text-center text-detail text-ink-faint">
              This request doesn't change anything anymore. What it proposed is already part of
              the current text, or has since been removed on its branch — there is nothing left
              to review or apply. {firstName} can withdraw it.
            </p>
          </div>
        ) : (
        <>
        {/* The folder on the left, the file with the change marked in it on the
            right — the same reading as version history. */}
        <div className="mt-4 grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)] gap-7 px-8">
          <Surface
            tone="surface"
            radius="lg"
            elevation="none"
            className="max-h-full self-start overflow-y-auto p-2"
          >
            <CrFileTree
              files={treeFiles}
              selected={selected}
              currentUserEmail={viewerEmail}
              onSelect={(p) => setSelected(p)}
              onToggleApprove={(p, approved) => void toggleApprove(p, approved)}
              onRevert={(p) => void revertFile(p)}
              busy={verbBusy}
            />
          </Surface>

          <div className="flex min-h-0 flex-col">
            <div className="flex items-center gap-3 pb-1">
              <span className="truncate font-mono text-meta text-ink-faint">
                {selected}
                {detail === null
                  ? ''
                  : touchesSelected
                    ? ' · what changes is marked'
                    : ' · not touched by this request'}
              </span>
            </div>
            {verbError && (
              <Banner tone="danger" role="alert" className="mb-2">
                {verbError}
              </Banner>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* The diff only needs the two file contents, so it renders as
                  soon as those arrive rather than waiting on the (slow) detail
                  fetch that tells us which files were touched. */}
              {selectedIsBinary ? (
                <p className="py-6 text-center text-detail text-ink-faint">
                  {isAdded
                    ? 'A new binary file (an image, a document…). There is no text to compare. Apply the request to take it as proposed.'
                    : touchesSelected
                      ? 'A binary file (an image, a document…) changed in this request. There is no text to compare.'
                      : 'A binary file. No text to show, and this request does not touch it.'}
                </p>
              ) : mdPayload !== null && !unreadable.has(selected) ? (
                // An untouched file arrives here too and simply renders as a
                // clean document — identical sides diff to all-same blocks —
                // so the reader gets prose everywhere, marked or not.
                //
                // No link resolvers, deliberately. This dialog shows a diff of
                // the CHANGE REQUEST's branch, while the navigation hooks
                // resolve against the branch that is checked out — so wiring
                // them through would send a reviewer to a different branch's
                // copy of whatever they clicked, and an id-link to a node the
                // change request itself creates would resolve to nothing with
                // only a console warning. Links therefore render as inert
                // anchors; everything else the KB pipeline brings (rendered
                // details blocks, mermaid, sanitised HTML, escaped link
                // destinations) applies here as it does in the document view.
                // Navigating away from a modal mid-review would also lose the
                // review context, so inert is the better default regardless.
                <MarkdownDiffViewer payload={mdPayload} />
              ) : (
              <MarkedFile
                diff={diff}
                raw={
                  !selectedIsMarkdown && detail !== null && !touchesSelected
                    ? (mainRaw ?? branchRaw)
                    : null
                }
                unreadable={unreadable.has(selected)}
              />
              )}
            </div>
          </div>
        </div>
        </>
        )}

        {/* The verdict. Fixed to the bottom of the surface — a decision the
            reader has to scroll to find is one they will make without reading. */}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line bg-sunken px-8 py-4">
          <p className="mr-auto max-w-[52ch] text-meta text-ink-muted">
            {blocked
              ? `Nothing changes for anyone until ${firstName} proposes it again against the current text.`
              : detail === null
                ? ''
                : allFiles.length === 0
                  ? 'Applying would change nothing, so the button stays away.'
                  : canApply
                    ? 'Every agent that connects after this picks it up. There is no staged rollout.'
                    : detail.mergeWarnings[0] ??
                      'Waiting on approval from the files’ owners — applying is theirs to do.'}
          </p>
          {/* Admins carry the moderation verb: delete the request AND its
              branch, armed on the first click. `viewerCanBypassMerge` is the
              server's admin verdict — the DELETE route re-checks it. */}
          {!blocked && detail?.viewerCanBypassMerge && (
            deleteArmed ? (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={deleting}
                  onClick={() => void deleteRequest()}
                >
                  {deleting ? 'Deleting…' : 'Really delete request and branch?'}
                </Button>
                <Button variant="quiet" size="sm" disabled={deleting} onClick={() => setDeleteArmed(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                variant="quiet"
                size="sm"
                className="text-danger"
                onClick={() => setDeleteArmed(true)}
              >
                Delete request
              </Button>
            )
          )}
          {/* Apply exists only when the viewer can actually deliver the
              verdict. All files approved → plain Apply. Some not yet approved
              but every one of them approvable BY THIS VIEWER (write access) →
              the same click, named for what it is: their authority covers the
              missing approvals. Anyone else gets the waiting line above. */}
          {!blocked && canApply && (
            <Button
              variant="primary"
              size="sm"
              disabled={applyBusy}
              onClick={() => applying.apply(cr)}
            >
              {applyBusy ? applyLabel : allApproved ? 'Apply changes' : 'Bypass approval and apply'}
            </Button>
          )}
        </div>
      </Surface>
    </div>
  );
}

/**
 * The author's reason, or nothing.
 *
 * A change request's body is part human and part machine: the backend appends
 * an `## Affected owners` block (and hidden identity markers) to whatever the
 * author wrote, and our propose flow writes no description at all — so the body
 * is USUALLY pure machinery. Rendering it as a pull-quote under the title
 * presents a routing table as the reason someone wants this change. Everything
 * from the first generated heading on is dropped; what survives is quoted only
 * if a human actually wrote it.
 */
function authorsReason(body: string | undefined): string | null {
  if (!body) return null;
  const human = body
    .split(/^##\s+/m)[0]
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return human.length > 0 ? human : null;
}

/**
 * The file with the change marked in it — one document, not two panes. Removed
 * passages stay in place struck through, added ones sit where they will land,
 * so what you read is the file as it would become.
 *
 * Markdown never reaches this view when both sides are in — it renders
 * through `MarkdownDiffViewer` above. This is the presentation for the files
 * that ARE source (yaml, scripts, config), plus the loading and unreadable
 * states for everything.
 */
function MarkedFile({
  diff,
  raw,
  unreadable,
}: {
  diff: DiffLine[] | null;
  raw: string | null;
  unreadable?: boolean;
}) {
  if (unreadable) {
    return (
      <p className="py-6 text-center text-detail text-ink-faint">
        This file's copy on the change request couldn't be read, so there is no honest before and
        after to show.
      </p>
    );
  }
  if (raw !== null) {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
        {raw}
      </pre>
    );
  }
  if (diff === null) {
    return <p className="py-6 text-center text-detail text-ink-faint">Loading…</p>;
  }
  return (
    <pre className="lib-sug whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
      {diff.map((l, i) =>
        l.kind === 'removed' ? (
          <del key={i} className="block">
            {l.text || ' '}
          </del>
        ) : l.kind === 'added' ? (
          <ins key={i} className="block">
            {l.text || ' '}
          </ins>
        ) : (
          <div key={i}>{l.text || ' '}</div>
        ),
      )}
    </pre>
  );
}

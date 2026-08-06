import { useEffect, useMemo, useRef, useState } from 'react';
import { type PullRequestDetail, type PullRequestSummary } from '@bevel-software/platform-shared';
import '../change-requests.css';
import { Badge, Banner, Button, Surface } from '../../../shared/components';
import { useModalLayer } from '../../../shared/components/useModalLayer';
import { cn } from '../../../lib/utils';
import { fetchPrDetail } from '../../pr/services/pr-detail.api';
import { useApplyChangeRequest } from '../hooks/useApplyChangeRequest';
import { readFileOnBranch } from '../services/change-requests.api';
import { changeAuthorName } from '../utils/author';
import { conflictResolutionPrompt } from '../utils/conflict';
import { ConflictHelp } from './ConflictHelp';
import { useDefaultBranchFile } from '../hooks/useFileOnBranch';
import { diffLines, type DiffLine } from '../utils/diff';
import { isBinaryFile } from '../../workspace/components/renderers';

/**
 * The folder the dialog reads the request WITHIN. The skill page scopes to
 * the skill: its folder is the prefix, and `baseFiles` (SKILL.md + bundled
 * files, prefix-relative) always list so an owner can read the untouched
 * parts too. Without a scope — the Knowledge viewer — the whole repo is the
 * frame: the file list is exactly what the request touches, paths shown
 * repo-relative.
 */
export interface ChangeRequestScope {
  /** Repo-root-relative folder, no trailing slash (e.g. `Groups/gtm/rfi`). */
  prefix: string;
  /** Files that always list, relative to `prefix`, whether touched or not. */
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

  // '' prefix = the whole repo: every touched file is "inside", shown by its
  // repo-relative path, and the outside badge never has anything to count.
  const prefix = scope ? `${scope.prefix}/` : '';
  const mainFiles = useMemo(() => scope?.baseFiles ?? [], [scope]);
  const changedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const f of detail?.files ?? []) {
      if (f.path.startsWith(prefix)) set.add(f.path.slice(prefix.length));
    }
    return set;
  }, [detail, prefix]);
  const addedFiles = useMemo(
    () =>
      (detail?.files ?? [])
        .filter((f) => f.status === 'added' && f.path.startsWith(prefix))
        .map((f) => f.path.slice(prefix.length)),
    [detail, prefix],
  );
  const outsideCount = useMemo(
    () => (detail?.files ?? []).filter((f) => !f.path.startsWith(prefix)).length,
    [detail, prefix],
  );
  const allFiles = useMemo(() => {
    const touched = [...changedFiles].filter((f) => !mainFiles.includes(f));
    return [...mainFiles, ...touched];
  }, [mainFiles, changedFiles]);

  /** The scale line: how much this touches, in the KB's own terms. */
  const scale = useMemo(() => {
    const files = (detail?.files ?? []).filter((f) => f.path.startsWith(prefix));
    return {
      files: files.length,
      plus: files.reduce((n, f) => n + f.additions, 0),
      minus: files.reduce((n, f) => n + f.deletions, 0),
    };
  }, [detail, prefix]);

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

  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    // `selected` is '' until the detail names any file in an unscoped dialog —
    // nothing to read yet. Binary files are never read at all (above).
    if (selected && !selectedIsBinary && !asked.current.has(selected)) {
      asked.current.add(selected);
      readFileOnBranch(cr.branch, `${prefix}${selected}`)
        .then((content) => setBranchContents((c) => ({ ...c, [selected]: content })))
        // NOT `''`. An unreadable branch copy stored as empty would diff as
        // "every line deleted" — a change request that erases the file.
        .catch(() => setUnreadable((s) => new Set(s).add(selected)));
    }
  }, [selected, selectedIsBinary, cr.branch, prefix]);

  const isAdded = addedFiles.includes(selected);
  // Raw-vs-raw: the skills API hands back SKILL.md's PARSED body (frontmatter
  // stripped), and diffing that against a raw branch read renders the
  // frontmatter as a deletion and the whole file as changed.
  const mainRaw = useDefaultBranchFile(
    isAdded || !selected || selectedIsBinary ? null : `${prefix}${selected}`,
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
  const diff: DiffLine[] | null = bothSidesIn
    ? diffLines(isAdded ? '' : (mainRaw as string), branchRaw as string)
    : null;
  const touchesSelected = changedFiles.has(selected);

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
        className="relative mx-auto mt-[4vh] mb-[4vh] flex h-[92vh] w-full max-w-5xl flex-col overflow-hidden"
      >
        <div className="flex items-start gap-4 px-8 pt-7">
          <div className="min-w-0 flex-1">
            <p className="text-label font-semibold uppercase text-ink-faint">Change request</p>
            <h1 className="mt-1 text-title font-medium text-ink">{cr.title}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-detail text-ink-muted">
              <span>{author}</span>
              <span aria-hidden="true" className="text-ink-faint">·</span>
              <span className="font-mono">{cr.branch}</span>
              {outsideCount > 0 && (
                <Badge tone="wait" size="xs">
                  +{outsideCount} file{outsideCount === 1 ? '' : 's'} outside this folder
                </Badge>
              )}
            </p>
          </div>
          <Button variant="quiet" size="sm" onClick={onClose} aria-label="Close change request">
            ✕
          </Button>
        </div>

        {/* Why, in the author's words. Omitted rather than faked when the
            request carries no description — an empty quote block reads as the
            author having said nothing worth reading. */}
        {why && (
          <blockquote className="mx-8 mt-5 border-l-2 border-line-strong pl-4 text-body text-ink">
            {why}
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
            <b className="font-semibold">Can't apply</b> — files changed after {firstName} wrote
            this, so there is no honest before and after to apply. It has to be redone against
            the current text.
            <div className="mt-2.5">
              <ConflictHelp prompt={conflictResolutionPrompt(cr)} />
            </div>
          </Banner>
        )}

        {/* The folder on the left, the file with the change marked in it on the
            right — the same reading as version history.

            NO responsive variants here, deliberately: the running app loads
            ZERO `@media` rules (checked in the browser), so an `md:`-prefixed
            class is dead text — the same trap the deleted slate palette was.
            The overlay has a fixed max width anyway, so one split is the whole
            story. */}
        <div className="mt-4 grid min-h-0 flex-1 grid-cols-[13.5rem_minmax(0,1fr)] gap-7 px-8">
          <Surface
            tone="surface"
            radius="lg"
            elevation="none"
            className="self-start overflow-y-auto p-2.5"
          >
            {allFiles.map((rel) => {
              const added = addedFiles.includes(rel);
              const on = selected === rel;
              return (
                <button
                  key={rel}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left font-mono text-meta transition-colors',
                    on ? 'bg-hover font-semibold text-ink' : 'text-ink-muted hover:bg-hover',
                  )}
                  onClick={() => setSelected(rel)}
                >
                  <span className="truncate">{rel}</span>
                  {added ? (
                    <Badge tone="ok" size="xs" className="ml-auto shrink-0">
                      New
                    </Badge>
                  ) : (
                    changedFiles.has(rel) && (
                      <span
                        className="ml-auto size-1.5 shrink-0 rounded-full bg-wait-dot"
                        title="Changed in this request"
                      />
                    )
                  )}
                </button>
              );
            })}
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
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* The diff only needs the two file contents, so it renders as
                  soon as those arrive rather than waiting on the (slow) detail
                  fetch that tells us which files were touched. */}
              {selectedIsBinary ? (
                <p className="py-6 text-center text-detail text-ink-faint">
                  {isAdded
                    ? 'A new binary file (an image, a document…). There is no text to compare — apply the request to take it as proposed.'
                    : touchesSelected
                      ? 'A binary file (an image, a document…) changed in this request. There is no text to compare.'
                      : 'A binary file — no text to show, and this request does not touch it.'}
                </p>
              ) : (
              <MarkedFile
                diff={diff}
                raw={detail !== null && !touchesSelected ? (mainRaw ?? branchRaw) : null}
                unreadable={unreadable.has(selected)}
              />
              )}
            </div>
          </div>
        </div>

        {/* The verdict. Fixed to the bottom of the surface — a decision the
            reader has to scroll to find is one they will make without reading. */}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line bg-sunken px-8 py-4">
          <p className="mr-auto max-w-[52ch] text-meta text-ink-muted">
            {blocked
              ? `Nothing changes for anyone until ${firstName} proposes it again against the current text.`
              : 'Every agent that connects after this picks it up. There is no staged rollout.'}
          </p>
          {!blocked && (
            <Button
              variant="primary"
              size="sm"
              disabled={applyBusy}
              onClick={() => applying.apply(cr)}
            >
              {applyBusy ? applyLabel : 'Apply changes'}
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

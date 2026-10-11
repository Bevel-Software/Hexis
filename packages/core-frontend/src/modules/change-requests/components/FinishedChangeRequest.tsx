import { useMemo, useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import {
  DEFAULT_BRANCH,
  type FileDiffPayload,
  type PullRequestDetail,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import { Banner, Surface, buttonClasses } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { kbFileUrl } from '../../workspace/routing/kb-routes';
import { hasFileViewer, isBinaryFile, rendersAsText } from '../../workspace/components/renderers';
import { MarkdownDiffViewer } from '../../review/components/MarkdownDiffViewer';
import { useAppliedFile } from '../hooks/useAppliedFile';
import { diffLines } from '../utils/diff';
import { finishedStatusLine } from '../utils/finishedStatus';
import { deniedSentence } from '../utils/readFailure';
import { AuthorsReason, ChangeRequestHeader } from './ChangeRequestHeading';
import { BranchFilePreview } from './BranchFilePreview';
import { CrFileTree, type CrTreeFileState } from './CrFileTree';
import { MarkedFile } from './MarkedFile';

interface FinishedChangeRequestProps {
  cr: PullRequestSummary;
  /**
   * The request's detail, no longer open (`state` is `merged` or `closed`);
   * `null` while it loads for a request whose summary already says it is
   * finished, so such a request never shows the review view first.
   */
  detail: PullRequestDetail | null;
  /**
   * Why the detail could not be loaded, when it could not — said in place of
   * the status line, rather than "Loading…" forever.
   */
  error?: string | null;
  /** The file to land on, repo-relative, when the request changed it. */
  initialPath?: string;
  onClose(): void;
  /**
   * Go to a page the request applied. Defaults to navigating there and
   * closing the dialog, as opening a file from the tree does; a host whose
   * close itself navigates (the request's own link) navigates instead.
   */
  onOpenPage?(url: string): void;
}

/**
 * A change request that was applied or closed — a RECORD, not a decision.
 *
 * One status line saying how it ended, in the dialog's neutral notice bar,
 * then (applied only) each file's change as it was applied, read-only, with
 * Open page to the page as it is now. No verb survives: no approve, no undo,
 * no apply, no delete, no bring-up-to-date, no approval marks, no footer.
 *
 * A closed request is its header, its description and the status line, in a
 * dialog that fits them: the server keeps no record of what a closed request
 * proposed (its branch went with it). An applied request whose apply made no
 * commit of its own has no verified "as applied" change to read, and reads
 * the same way rather than borrowing another request's commit.
 */
export function FinishedChangeRequest({
  cr,
  detail,
  error,
  initialPath,
  onClose,
  onOpenPage,
}: FinishedChangeRequestProps) {
  const applied = detail?.state === 'merged';
  const statusLine = useMemo(() => (detail ? finishedStatusLine(detail) : null), [detail]);
  const files = useMemo(() => (detail && applied ? detail.files : []), [applied, detail]);
  const appliedSha = applied ? (detail?.finished?.appliedSha ?? null) : null;
  const showFiles = files.length > 0;
  const targetBranch = cr.base || DEFAULT_BRANCH;

  const [picked, setPicked] = useState<string | null>(initialPath ?? null);
  const selectedFile = files.find((f) => f.path === picked) ?? files[0];
  const selected = selectedFile?.path ?? '';
  const selectedIsBinary = selected !== '' && isBinaryFile(selected);
  const selectedIsMarkdown = /\.md$/i.test(selected) && !rendersAsText(selected);
  const isAdded = selectedFile?.status === 'added';
  const isRemoved = selectedFile?.status === 'removed';
  /** Where the file came from, for a rename or a copy: the path its "before" side reads. */
  const source =
    (selectedFile?.status === 'renamed' || selectedFile?.status === 'copied') &&
    selectedFile.previousPath &&
    selectedFile.previousPath !== selected
      ? { verb: selectedFile.status === 'copied' ? 'Copied' : 'Moved', from: selectedFile.previousPath }
      : null;

  const { read, failureOf, retry } = useAppliedFile(appliedSha, selectedFile, targetBranch, {
    readText: !selectedIsBinary,
  });
  const failure = read?.failure ?? null;
  const sides = read !== null && read.loaded && failure === null ? read : null;

  const scale = useMemo(
    () => ({
      files: files.length,
      plus: files.reduce((n, f) => n + f.additions, 0),
      minus: files.reduce((n, f) => n + f.deletions, 0),
    }),
    [files],
  );

  /** The tree: what happened to each file, and a lock where a read was refused. Nothing else. */
  const treeFiles: CrTreeFileState[] = useMemo(
    () =>
      files.map((f) => {
        const refused = f.path === selected ? failure : failureOf(f.path);
        return {
          path: f.path,
          changed: true,
          added: f.status === 'added',
          status: f.status,
          deniedNote: refused?.kind === 'denied' ? deniedSentence(refused.folder) : undefined,
        };
      }),
    [files, selected, failure, failureOf],
  );

  const mdPayload = useMemo<FileDiffPayload | null>(
    () =>
      selectedIsMarkdown && sides !== null
        ? {
            path: selected,
            kind: isAdded ? 'added' : isRemoved ? 'deleted' : 'modified',
            baseline: sides.before,
            current: sides.after,
            isBinary: false,
          }
        : null,
    [selectedIsMarkdown, sides, selected, isAdded, isRemoved],
  );
  const diff =
    sides !== null && !selectedIsMarkdown && !selectedIsBinary
      ? diffLines(sides.before ?? '', sides.after ?? '')
      : null;

  let pane;
  if (failure !== null && failure.kind === 'denied') {
    // Refused, with or without a commit to read: the sentence and the lock,
    // never the content.
    pane = <MarkedFile diff={null} raw={null} failure={failure} onRetry={() => retry(selected)} />;
  } else if (appliedSha === null && failure === null) {
    // Only once the remaining read settled cleanly: a retryable failure falls
    // through to the sentence with Try again rather than reading as success.
    pane = (
      <p className="py-6 text-center text-detail text-ink-faint">
        Everything this request proposed was already there when it was applied, so it made no
        change of its own to show.
      </p>
    );
  } else if (selectedIsBinary && failure === null && appliedSha !== null) {
    pane = hasFileViewer(selected) ? (
      <BranchFilePreview
        branch={targetBranch}
        repoRelativePath={selected}
        label={isRemoved ? 'Before it was applied' : 'As applied'}
        fileRef={{ ref: appliedSha, side: isRemoved ? 'before' : 'after' }}
      />
    ) : (
      <p className="py-6 text-center text-detail text-ink-faint">
        {isRemoved
          ? 'A binary file (an image, a document…) this request deleted. There is no text to compare.'
          : isAdded
            ? 'A binary file (an image, a document…) this request added. There is no text to compare.'
            : 'A binary file (an image, a document…) this request changed. There is no text to compare.'}
      </p>
    );
  } else if (mdPayload !== null) {
    pane = <MarkdownDiffViewer payload={mdPayload} />;
  } else {
    pane = <MarkedFile diff={diff} raw={null} failure={failure} onRetry={() => retry(selected)} />;
  }

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
        className={cn(
          'relative mx-auto mt-[4vh] mb-[4vh] flex w-full max-w-6xl flex-col overflow-hidden',
          // With no files to read the view is three lines, and at full height
          // the empty surface below them reads as content that failed to load.
          showFiles ? 'h-[92vh]' : 'max-h-[92vh] pb-8',
        )}
      >
        <ChangeRequestHeader cr={cr} onClose={onClose} />

        {/* How it ended, first, in one line. Nothing below it is a verb. */}
        {statusLine === null ? (
          error ? (
            <Banner tone="danger" role="alert" className="mx-8 mt-5">
              {error}
            </Banner>
          ) : (
            <p className="mt-5 px-8 text-detail text-ink-faint">Loading…</p>
          )
        ) : (
          <Banner tone="neutral" role="status" className="mx-8 mt-5">
            {statusLine}
          </Banner>
        )}

        <AuthorsReason body={detail?.body} />

        {showFiles && (
          <>
            <p className="mt-5 px-8 text-detail tabular-nums text-ink-faint">
              {scale.files} file{scale.files === 1 ? '' : 's'} ·{' '}
              <span className="text-ok">+{scale.plus}</span>{' '}
              <span className="text-danger">−{scale.minus}</span>
            </p>

            <div className="mt-4 grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)] gap-7 px-8 pb-8">
              <Surface
                tone="surface"
                radius="lg"
                elevation="none"
                className="max-h-full self-start overflow-y-auto p-2"
              >
                <CrFileTree
                  files={treeFiles}
                  selected={selected}
                  currentUserEmail=""
                  onSelect={setPicked}
                  onRevert={() => undefined}
                  busy={false}
                />
              </Surface>

              <div className="flex min-h-0 flex-col">
                <div className="flex items-center gap-3 pb-1">
                  <span className="truncate font-mono text-meta text-ink-faint">
                    {selected}
                    {appliedSha !== null && !selectedIsBinary ? ' · as applied' : ''}
                  </span>
                  {/* Where the review view had the approval control: the page
                      as it is now. Nothing for a file the request itself
                      deleted, or one this viewer may not read. */}
                  {sides !== null &&
                    !isRemoved &&
                    (sides.pageNow === 'deleted' ? (
                      <span className="ml-auto shrink-0 text-meta text-ink-faint">
                        This page has since been deleted.
                      </span>
                    ) : sides.pageNow !== null ? (
                      <OpenPageLink
                        url={kbFileUrl(targetBranch, sides.pageNow.workspacePath)}
                        onOpenPage={onOpenPage}
                        onClose={onClose}
                      />
                    ) : null)}
                </div>
                {source && (
                  <p className="truncate pb-1 font-mono text-meta text-ink-faint">
                    {source.verb}: {source.from} → {selected}
                  </p>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">{pane}</div>
              </div>
            </div>
          </>
        )}
      </Surface>
    </div>
  );
}

/**
 * "Open page": the page as it is now, on the branch the request was applied
 * to. A real link (it can be opened in a new tab); a plain click navigates
 * in the app and closes the dialog. Outside a router (an isolated render)
 * it is only the link.
 */
interface OpenPageProps {
  url: string;
  onOpenPage?(url: string): void;
  onClose(): void;
}

function OpenPageLink(props: OpenPageProps) {
  return useInRouterContext() ? <RoutedOpenPageLink {...props} /> : <OpenPageAnchor url={props.url} />;
}

const OPEN_PAGE_CLASSES = buttonClasses({ variant: 'outline', size: 'tiny', className: 'ml-auto shrink-0' });

function OpenPageAnchor({ url, onClick }: { url: string; onClick?(e: React.MouseEvent): void }) {
  return (
    <a href={url} className={OPEN_PAGE_CLASSES} onClick={onClick}>
      Open page
    </a>
  );
}

function RoutedOpenPageLink({ url, onOpenPage, onClose }: OpenPageProps) {
  const navigate = useNavigate();
  return (
    <OpenPageAnchor
      url={url}
      onClick={(e) => {
        // A modified click (new tab, new window) is the browser's.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (onOpenPage) {
          onOpenPage(url);
          return;
        }
        navigate(url);
        onClose();
      }}
    />
  );
}

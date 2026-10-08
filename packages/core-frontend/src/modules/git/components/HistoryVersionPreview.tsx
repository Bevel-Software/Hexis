import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { CommitAttribution } from '@bevel-software/platform-shared';
import { Button } from '../../../shared/components';
import { formatRelativeTime } from '../../../lib/utils';
import { useGit } from '../state/git.context';
import { friendlyGitError } from '../services/error-messages';
import { UnifiedDiffView } from './UnifiedDiffView';
import { useFileAccess } from '../../access/hooks/useFileAccess';
import { FilePaneCard } from '../../workspace/components/FilePaneCard';
import {
  CanDownloadContext,
  DownloadFileButton,
} from '../../workspace/components/renderers/DownloadFileButton';
import { RetryReadButton } from '../../workspace/components/renderers/RetryReadButton';
import { READ_PANE } from '../../workspace/components/renderers/readPane';
import {
  RendererWorkspaceContext,
  getFileRenderer,
  getRendererLayout,
  hasFileViewer,
  isBinaryFile,
  type RendererFileRef,
} from '../../workspace/components/renderers';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { displayFileName, fileNameTooltip } from '../../../shared/display-file-name';

/**
 * One past save of a file, shown the way the FILE PAGE shows that file.
 *
 * Version history used to have exactly one special case: a `.md` file got a
 * rendered diff, and everything else got `git show`'s patch as coloured text.
 * For an HTML page that meant its source rather than the page; for a PNG or a
 * PDF it meant the single line "Binary files a/… and b/… differ", which tells
 * a reader nothing at all about the version they selected. Every one of those
 * formats already has a viewer on the file page, and a viewer only needs a
 * workspace, a path and — now — a save; so this mounts the same viewer, bound
 * to the selected save, and the reader looks at the actual document.
 *
 * Read-only throughout: a past version has no save path, no lock and no edit
 * mode. Getting an old version back is a download and an upload (Restore is
 * deliberately out of scope, hx-history-file-preview decision 6), which is why
 * "Download this version" is on every save rather than only where there is no
 * preview.
 *
 * Three bodies, decided per format (see {@link previewKind}), and a header
 * that is the same for all three.
 */

/** A read-only save handler for a pane that has no save. */
const NO_SAVE = (): Promise<void> =>
  Promise.reject(new Error('A past version is read-only.'));

/**
 * The formats whose viewer is fed the file's TEXT rather than its bytes.
 *
 * `HtmlRenderer` and `CsvRenderer` render the `content` prop — they never
 * fetch the file — so binding them to a save means fetching that save's text
 * through the history endpoint the markdown view already uses, rather than
 * through `?ref=` on the bytes route.
 */
const TEXT_FED_EXTENSIONS = new Set(['.html', '.htm', '.csv']);

/**
 * The formats whose pane offers "Source changes".
 *
 * The three text-fed ones plus `.svg`: all four are files a technical reader
 * may well want to read as source, and for all four the line diff the panel
 * has always shown is genuinely informative. It is not offered for a pdf, an
 * image or an Office document, where the patch is one line about bytes.
 */
const SOURCE_TOGGLE_EXTENSIONS = new Set(['.html', '.htm', '.csv', '.svg']);

/** The save's time in full, for the header's tooltip — the commit list's own shape. */
function formatAbsoluteTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function extensionOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
}

/**
 * Tool definitions are excluded from the viewer path on purpose: `.tool`'s
 * renderer is an editing FORM over a JSON file, not a rendering of the file,
 * and its history has always been — and stays — the line diff.
 */
function isToolPath(filePath: string): boolean {
  return extensionOf(filePath) === '.tool';
}

/** How this save is shown. */
type PreviewKind =
  /** The file page's viewer, bound to the save. */
  | 'viewer'
  /** Nothing renders these bytes: a note and the download. */
  | 'no-preview'
  /** Text with no viewer (a `.txt`, a `.json`, a tool): the line diff, as before. */
  | 'source';

/**
 * Which of the three bodies this file gets.
 *
 * Derived from the renderer registry rather than kept as a fourth list of
 * extensions, so a viewer added on the file page reaches Version history the
 * same day. The binary question needs the patch as well as the extension:
 * `isBinaryFile` knows the formats the app handles, and git's own "Binary
 * files … differ" marker covers everything else — a `.bin`, a `.exe`, an
 * unknown container — which is what makes "and any other binary" true rather
 * than a list somebody has to keep up to date.
 */
function previewKind(filePath: string, patch: string): PreviewKind {
  // The save did not touch this path at all — the file is absent, or unchanged,
  // on both sides (a pure rename elsewhere in the commit, say). There is no
  // version here to show, and a viewer bound to a ref with nothing at it would
  // answer with its read error; `source` is what the panel has always shown
  // for this, and `UnifiedDiffView`'s empty state says it in words.
  if (patch.trim() === '') return 'source';
  if (hasFileViewer(filePath) && !isToolPath(filePath)) return 'viewer';
  if (isBinaryFile(filePath) || /^Binary files .* differ$/m.test(patch)) return 'no-preview';
  return 'source';
}

/**
 * What one selected save looks like once the server has answered, TAGGED with
 * the request it is an answer for.
 *
 * The tag is what replaces a reset inside the effect: switching saves does not
 * clear anything, it simply stops the previous save's answer from being
 * recognised. Clearing in the effect body would cost a cascading render on
 * every selection and, for one render, would show the OLD save's document
 * under the NEW save's header — the same pattern, and the same reason, as the
 * change-request pane's `BranchFilePreview`.
 */
interface Answer {
  /** File, save and attempt — everything the load is a function of. */
  key: string;
  loaded: Loaded | null;
  error: string | null;
}

/** Everything one selected save needs, once the server has answered. */
interface Loaded {
  /** `git show` for this save — the "Source changes" body, and the delete signal. */
  patch: string;
  /**
   * The save DELETED the file. git spells this in the patch header the same
   * way for a binary and for text (`deleted file mode 100644`), which makes it
   * the one signal that works for every format without a second read of bytes
   * nobody is going to look at.
   */
  deleted: boolean;
  /** The save's text, for a text-fed viewer only; `null` otherwise. */
  text: string | null;
}

export interface HistoryVersionPreviewProps {
  /** Workspace-relative path, e.g. `knowledge-base/Docs/Q3-report.pdf`. */
  filePath: string;
  /** The save being shown. */
  commit: CommitAttribution;
}

export function HistoryVersionPreview({ filePath, commit }: HistoryVersionPreviewProps) {
  const { fetchFileDiff, fetchFileAtChange, status } = useGit();
  const { workspaceId } = useWorkspace();
  const ext = extensionOf(filePath);

  /**
   * Bumped by the pane's own "Try again". A failed load whose file and save
   * are unchanged has nothing else to re-trigger the effect, and a version
   * pane must never be left blank — so the retry is part of the error state
   * rather than something a reader has to find elsewhere.
   */
  const [attempt, setAttempt] = useState(0);
  const key = `${filePath}::${commit.sha}::${attempt}`;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const { loaded, error } = answer?.key === key ? answer : { loaded: null, error: null };

  /**
   * The save whose SOURCE view is open, rather than a bare boolean: a boolean
   * would need clearing when the selection changes, and this simply stops
   * matching. Selecting another save therefore lands on Preview.
   */
  const [sourceForSha, setSourceForSha] = useState<string | null>(null);
  const showSource = sourceForSha === commit.sha;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The patch is fetched for every format, not only the ones that show
        // it: it is also how "this save deleted the file" and "these bytes are
        // binary" are known, and for a binary git prints one line rather than
        // the content, so it costs nothing worth saving.
        const patch = await fetchFileDiff(filePath, commit.sha);
        if (cancelled) return;
        const deleted = /^deleted file mode /m.test(patch);
        let text: string | null = null;
        if (TEXT_FED_EXTENSIONS.has(extensionOf(filePath))) {
          const sides = await fetchFileAtChange(filePath, commit.sha);
          if (cancelled) return;
          // A deleting save shows the version just BEFORE it — there is
          // nothing at the path after it.
          text = (deleted ? sides.baseline : sides.current) ?? '';
        }
        if (cancelled) return;
        setAnswer({ key, loaded: { patch, deleted, text }, error: null });
      } catch (err) {
        if (!cancelled) setAnswer({ key, loaded: null, error: friendlyGitError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, filePath, commit.sha, fetchFileDiff, fetchFileAtChange]);

  /**
   * The same download verdict the file page resolves for this file, on today's
   * tree — which is the whole access rule for a past save: anyone who may read
   * (and download) the file now may read (and download) any of its saves, and
   * the rules as they were at that save play no part.
   */
  const access = useFileAccess(filePath, status?.branch ?? null);

  /**
   * Which side of the save "this version" is: the save's own, or — for the save
   * that DELETED the file — the one before it, which is the only side with any
   * bytes.
   *
   * `after` before the patch has answered, deliberately, and NOT a `null` the
   * ref waits for. Nothing reads a provisional side (the body renders its
   * loading state until `loaded` is non-null, so no viewer is mounted, and the
   * header's download is `pending` until then), but a `null` ref would mean
   * `rawFileUrl` omitted `ref=` and served TODAY's bytes under a past save's
   * name — silently wrong, which is the one answer this whole pane exists to
   * rule out. A provisional side can only ever be wrong LOUDLY: the after side
   * of a deleting save is a 404.
   */
  const side: 'after' | 'before' = loaded?.deleted ? 'before' : 'after';
  /**
   * What binds every viewer in this pane to the selected save. Memoized so a
   * status poll re-rendering the panel cannot hand the renderers a new object
   * and restart their reads.
   */
  const fileRef = useMemo<RendererFileRef>(
    () => ({ ref: commit.sha, side }),
    [commit.sha, side],
  );
  const rendererContext = useMemo(
    () => ({ workspaceId, fileRef }),
    [workspaceId, fileRef],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const who = commit.authorName || commit.authorEmail || 'unknown';
  const kind = loaded === null ? null : previewKind(filePath, loaded.patch);
  const canToggleSource = kind === 'viewer' && SOURCE_TOGGLE_EXTENSIONS.has(ext);
  /**
   * The save did not touch this path: nothing to preview AND nothing to
   * download. The empty patch is the whole signal — see {@link previewKind} —
   * and the panel's own answer for it has always been the one sentence and no
   * controls, which is what a save with no version of the file can honestly
   * offer. `logForFile` lists commits that touched the path, so this is the
   * save that turns out not to have (a rename elsewhere in the commit).
   */
  const untouched = loaded !== null && loaded.patch.trim() === '';

  const header = (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 shrink-0">
      <span
        className="flex-1 truncate text-xs text-ink-muted"
        title={formatAbsoluteTime(commit.committedAt)}
      >
        As saved {formatRelativeTime(commit.committedAt)} by {who}
      </span>
      {canToggleSource && (
        <div className="flex items-center gap-1">
          <Button
            variant={showSource ? 'outline' : 'primary'}
            size="tiny"
            onClick={() => setSourceForSha(null)}
          >
            Preview
          </Button>
          <Button
            variant={showSource ? 'primary' : 'outline'}
            size="tiny"
            onClick={() => setSourceForSha(commit.sha)}
          >
            Source changes
          </Button>
        </div>
      )}
      {/* Inside the providers, so it downloads THIS save's bytes and is
          disabled with its reason for a reader who may not download — and
          idle until the patch has said which SIDE of the save "this version"
          means, which for a deleting save is the one before it. Absent
          altogether for a save with no version of this file to hand over. */}
      {!untouched && (
        <DownloadFileButton
          filePath={filePath}
          size="tiny"
          label="Download this version"
          pending={loaded === null}
        />
      )}
    </div>
  );

  let body;
  if (error !== null) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-6 text-center">
        <p role="alert" className="flex items-start gap-2 text-xs text-danger">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
        <RetryReadButton onRetry={retry} />
      </div>
    );
  } else if (loaded === null) {
    body = (
      <div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-muted">
        <Loader2 size={13} className="animate-spin" />
        Loading this version…
      </div>
    );
  } else if (kind === 'source' || showSource) {
    body = (
      <div className="flex-1 overflow-auto">
        <UnifiedDiffView diff={loaded.patch} emptyMessage="No file changes in this save." />
      </div>
    );
  } else if (kind === 'no-preview') {
    body = (
      <div className="flex flex-1 items-center justify-center px-6 py-6 text-center text-xs text-ink-muted">
        No preview for this format.
      </div>
    );
  } else {
    const Renderer = getFileRenderer(filePath);
    const viewer = (
      /* Not a component created during render: `getFileRenderer` returns one
         of a fixed set of module-level components (or a lazy wrapper built
         once at module load), keyed by the path's extension — the same lookup,
         with the same identity, `FileViewer` mounts. */
      /* eslint-disable-next-line react-hooks/static-components */
      <Renderer
        // A byte-reading viewer (pdf, image, docx, deck, workbook, message)
        // ignores these and reads the save through `?ref=`; a text-fed one
        // (html, csv) renders exactly this string, which is the save's own
        // text. `savedContent` matches `content` so the renderer is never
        // dirty — there is nothing here to save.
        content={loaded.text ?? ''}
        savedContent={loaded.text ?? ''}
        filePath={filePath}
        onSave={NO_SAVE}
        readOnly
      />
    );
    body =
      getRendererLayout(filePath) === 'prose' ? (
        // `READ_PANE`: the viewer's own "Try again" unmounts itself, and this
        // div is what stays mounted around it for focus to land on. See
        // `RetryReadButton`.
        <div {...READ_PANE} className="flex-1 overflow-auto p-3">
          <FilePaneCard file={displayFileName(filePath)} fileTitle={fileNameTooltip(filePath)}>
            {viewer}
          </FilePaneCard>
        </div>
      ) : (
        // A viewport (pdf, image, workbook, sandboxed page): it owns its own
        // scrolling and needs a DEFINITE height to do it — an `h-full` child
        // of an auto-height column collapses to 0px. The floor keeps a short
        // panel from squeezing a PDF into a sliver.
        <div
          {...READ_PANE}
          data-testid="history-preview-viewport"
          className="min-h-[24rem] flex-1 p-3"
        >
          {viewer}
        </div>
      );
  }

  return (
    <RendererWorkspaceContext.Provider value={rendererContext}>
      <CanDownloadContext.Provider value={access.canDownload}>
        {/* A read region for the whole pane, so the pane's own "Try again" —
            which unmounts itself exactly as a viewer's does — has somewhere to
            hand focus. A viewer's own body marks a nearer one below. */}
        <div {...READ_PANE} className="flex min-h-0 flex-1 flex-col">
          {header}
          {loaded?.deleted && (
            // The note, then the version just before the save beneath it: a
            // reader who selected the save that removed a file wants to see
            // what was removed (decision 4).
            <p className="border-b border-line px-3 py-2 text-xs text-ink shrink-0">
              This save deleted the file.
            </p>
          )}
          {body}
        </div>
      </CanDownloadContext.Provider>
    </RendererWorkspaceContext.Provider>
  );
}

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Banner } from '../../../shared/components';
import { fetchFileAccess } from '../../access/api';
import { FilePaneCard } from '../../workspace/components/FilePaneCard';
import {
  CanDownloadContext,
  DownloadFileButton,
} from '../../workspace/components/renderers/DownloadFileButton';
import {
  RendererWorkspaceContext,
  getFileRenderer,
  getRendererLayout,
} from '../../workspace/components/renderers';
import { kbFileUrl } from '../../workspace/routing/kb-routes';
import { getOrCreateWorkspace } from '../../workspace/services/workspace.api';

/**
 * A document or image shown with the FILE PAGE's viewer, read from a named
 * branch's workspace.
 *
 * A change request that adds a pdf, a deck or a screenshot used to reach its
 * owner as one sentence — "there is no text to compare" — and the owner was
 * asked to approve bytes nobody had seen. Every one of those formats already
 * has a viewer on the file page, and a viewer only needs a workspace id and a
 * path; a branch IS a workspace here. So the pane mounts the same renderer,
 * pointed at the request's branch, and the reader decides on the actual
 * document.
 *
 * Read-only throughout: no save path, no lock, no edit mode. The bytes belong
 * to someone else's branch and the only verbs over them are the dialog's own
 * Apply and Decline.
 */

/** The branch workspace this pane reads from, once it has bootstrapped. */
interface BranchWorkspace {
  id: string;
  kbDirName: string;
}

/**
 * Bootstrap (or join) the shared workspace for `branch`.
 *
 * The same call `readFileOnBranch` makes for the text diff — going through
 * the endpoint rather than deriving `encodeURIComponent(branch)` client-side
 * is what forces the backend to clone a branch nobody has opened yet, which
 * for a change request's branch is the common case.
 */
function useBranchWorkspace(branch: string): { workspace: BranchWorkspace | null; failed: boolean } {
  /**
   * The answer carries the branch it is an answer FOR, so switching files (or
   * panes) needs no synchronous reset in the effect — the read below simply
   * doesn't recognise the previous branch's answer. Clearing state in the
   * effect body would cost a cascading render on every switch, and for one
   * render would show the OLD branch's workspace under the NEW branch's file.
   */
  const [state, setState] = useState<{
    branch: string;
    workspace: BranchWorkspace | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOrCreateWorkspace(branch)
      .then(({ workspace }) => {
        if (cancelled) return;
        setState({
          branch,
          workspace: { id: workspace.id, kbDirName: workspace.kbDirName },
          failed: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ branch, workspace: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [branch]);

  if (state === null || state.branch !== branch) return { workspace: null, failed: false };
  return { workspace: state.workspace, failed: state.failed };
}

/** The read/download verdicts for one path on one branch. */
interface BranchFileAccess {
  /** `null` while the lookup is in flight. */
  canRead: boolean | null;
  canDownload: boolean | null;
}

/**
 * The same access question the file page asks, against the branch being read.
 *
 * The raw endpoint is the authoritative gate — it 403s a path the caller may
 * not read, on any workspace — but a viewer meeting that 403 says "Failed to
 * load PDF (HTTP 403)", or (the image viewer) says nothing at all and spins.
 * Asking first is what lets the pane give the refusal the file page gives.
 *
 * Default-ALLOW when the lookup itself fails, matching `useFileAccess`: a
 * transient API failure must not manufacture a refusal, and the bytes are
 * still gated where it counts.
 */
function useBranchFileAccess(
  workspaceId: string | null,
  repoRelativePath: string,
): BranchFileAccess {
  /** Keyed by what was asked, for the reason `useBranchWorkspace` is. */
  const key = `${workspaceId ?? ''}::${repoRelativePath}`;
  const [answer, setAnswer] = useState<{ key: string; access: BranchFileAccess } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    fetchFileAccess(workspaceId, repoRelativePath)
      .then((res) => {
        if (!cancelled) {
          setAnswer({ key, access: { canRead: res.canRead, canDownload: res.canDownload } });
        }
      })
      .catch(() => {
        // `canDownload: null` — unknown, so the button stays clickable and the
        // backend keeps the last word on it.
        if (!cancelled) setAnswer({ key, access: { canRead: true, canDownload: null } });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, repoRelativePath, key]);

  if (answer === null || answer.key !== key) return { canRead: null, canDownload: null };
  return answer.access;
}

/**
 * The refusal, worded as `FileRoute` words it — the same sentence a reader
 * gets for the same file on the file page, because it IS the same answer.
 */
function AccessRefused({ repoRelativePath }: { repoRelativePath: string }) {
  const name = repoRelativePath.slice(repoRelativePath.lastIndexOf('/') + 1);
  return (
    <div className="py-6">
      <p className="pb-2 text-ui font-medium text-ink">You don't have access to this file</p>
      <Banner role="alert" tone="danger">
        <span className="font-mono">{name}</span> is restricted. Ask an owner to grant you read
        access.
      </Banner>
    </div>
  );
}

/**
 * A read-only save handler for a pane that has no save. Every renderer here
 * is mounted `readOnly`, and the view-only viewers (pdf, images, decks,
 * workbooks, mail) have no editing surface to reach it from at all — so this
 * refusing rather than silently resolving keeps the impossible case honest.
 */
const NO_SAVE = (): Promise<void> =>
  Promise.reject(new Error('A change request preview is read-only.'));

export interface BranchFilePreviewProps {
  /** The branch whose bytes to show — the request's branch, or its target. */
  branch: string;
  /** Repo-relative path (the dialog's own currency), no `kbDirName` prefix. */
  repoRelativePath: string;
  /** What this pane is showing. */
  label: 'Proposed version' | 'Current version';
  /**
   * The branch to open the CURRENT version on, for a file the request
   * CHANGES. Null for an added file (there is no current version) and for one
   * the request doesn't touch (this pane already IS the current version).
   */
  currentVersionBranch?: string | null;
}

/**
 * The viewer pane: a label, the "open the current version" way out, and the
 * file page's renderer for this extension bound to `branch`'s workspace.
 */
export function BranchFilePreview({
  branch,
  repoRelativePath,
  label,
  currentVersionBranch = null,
}: BranchFilePreviewProps) {
  const { workspace, failed } = useBranchWorkspace(branch);
  const access = useBranchFileAccess(workspace?.id ?? null, repoRelativePath);

  const Renderer = getFileRenderer(repoRelativePath);
  const layout = getRendererLayout(repoRelativePath);
  const fileName = repoRelativePath.slice(repoRelativePath.lastIndexOf('/') + 1);

  const header = (
    <div className="flex flex-wrap items-center gap-3 pb-2">
      <span className="text-meta font-medium text-ink-muted">{label}</span>
      {currentVersionBranch && workspace && (
        // A new tab, not a navigation: leaving the dialog mid-review would
        // lose the review context, and the two versions are meant to be read
        // side by side.
        <a
          href={kbFileUrl(currentVersionBranch, `${workspace.kbDirName}/${repoRelativePath}`)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-meta text-ink-faint transition-colors hover:text-ink"
        >
          Open the current version
          <ExternalLink size={11} aria-hidden />
        </a>
      )}
    </div>
  );

  let body;
  if (failed) {
    body = (
      <p className="py-6 text-center text-detail text-ink-faint">
        The change request's branch couldn't be opened, so this file can't be shown here.
      </p>
    );
  } else if (!workspace || access.canRead === null) {
    body = <p className="py-6 text-center text-detail text-ink-faint">Loading…</p>;
  } else if (access.canRead === false) {
    body = <AccessRefused repoRelativePath={repoRelativePath} />;
  } else {
    const viewer = (
      <RendererWorkspaceContext.Provider value={{ workspaceId: workspace.id }}>
        <CanDownloadContext.Provider value={access.canDownload}>
          {/* Not a component created during render: `getFileRenderer` returns
              one of a fixed set of module-level components (or a lazy wrapper
              built once at module load), keyed by the path's extension — the
              same lookup, with the same identity, `FileViewer` mounts. */}
          {/* eslint-disable-next-line react-hooks/static-components */}
          <Renderer
            // The viewers here fetch their own bytes; the text buffer is
            // never read, and there is nothing to seed it from on a branch
            // the dialog deliberately does not check out.
            content=""
            savedContent=""
            filePath={`${workspace.kbDirName}/${repoRelativePath}`}
            onSave={NO_SAVE}
            readOnly
          />
        </CanDownloadContext.Provider>
      </RendererWorkspaceContext.Provider>
    );
    body =
      layout === 'prose' ? (
        // A document: the same edged frame, with the same mono filename bar,
        // the file page puts around prose.
        <FilePaneCard file={fileName}>{viewer}</FilePaneCard>
      ) : (
        // A viewport (pdf, image, workbook): it owns its own scrolling and
        // needs a DEFINITE height to do it — an `h-full` child of an
        // auto-height column collapses to 0px. `h-full` takes the pane's
        // height when the pane has one; the floor keeps a short dialog from
        // squeezing a PDF into a sliver.
        <div data-testid="cr-preview-viewport" className="h-full min-h-[60vh]">
          {viewer}
        </div>
      );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

export interface BranchFileDownloadProps {
  branch: string;
  repoRelativePath: string;
  label: string;
}

/**
 * The way out for a format no viewer here renders — a legacy `.doc`, an
 * OpenDocument file, a `.zip`, an unknown binary. The dialog keeps its note
 * ("there is no text to compare") and this hands over the bytes it is talking
 * about, from the request's branch rather than the checked-out tree.
 */
export function BranchFileDownload({ branch, repoRelativePath, label }: BranchFileDownloadProps) {
  const { workspace } = useBranchWorkspace(branch);
  if (!workspace) return null;
  return (
    <RendererWorkspaceContext.Provider value={{ workspaceId: workspace.id }}>
      <DownloadFileButton
        filePath={`${workspace.kbDirName}/${repoRelativePath}`}
        size="sm"
        label={label}
      />
    </RendererWorkspaceContext.Provider>
  );
}

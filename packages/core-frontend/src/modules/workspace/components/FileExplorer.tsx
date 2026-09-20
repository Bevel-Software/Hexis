import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import {
  ChevronRight,
  FilePlus,
  FolderPlus,
  FolderUp,
  Trash2,
  Pencil,
  Upload,
  X,
  PackageOpen,
  Download,
  Link2,
  Loader2,
  Pin,
  PinOff,
  Users,
  Undo2,
} from 'lucide-react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import {
  isProtectedBranch,
  validateFilename,
  KNOWLEDGE_BASE_DIR,
  DATA_DIR,
  PLUGINS_DIR,
  SKILLS_DIR,
  AGENTS_DIR,
  PIPELINES_DIR,
} from '@bevel-software/platform-shared';
import {
  KNOWLEDGE_UPLOAD_TARGET,
  useWorkspace,
  type UploadInput,
  type UploadTarget,
} from '../state/workspace.context';
import { rootAnchoredPath } from '../utils/pasteLink';
import { findKbRoot, KB_ROOT_DIRS, pathExistsInTree, treeHasVisibleEntries } from '../utils/fileTree';
import { uploadErrorNextStep } from '../utils/uploadError';
import { useMergedWorkspaceTree } from '../hooks/useMergedWorkspaceTree';
import { ChangeRequestDialog } from '../../change-requests/components/ChangeRequestDialog';
import { PR_STALE_EVENT, SUGGESTIONS_RETRACTED_EVENT } from '../../../core/events';
import {
  listChangeRequestsUnderFolder,
  removeFolderFromChangeRequests,
} from '../../change-requests/services/change-requests.api';
import { cancelPullRequest } from '../../pr/services/pr-cancel.api';
import { snapshotEntries } from '../utils/readDroppedEntries';
import { useSearchParams } from 'react-router-dom';
import { CR_FILE_PARAM, CR_PARAM, useFileNav } from '../routing/kb-routes';
import { rawFileUrl } from '../services/workspace.api';
import { downloadViaBlob } from './renderers/downloadFile';
import { cn } from '../../../lib/utils';
import { Banner, MenuPanel, MenuItem, TextField, IconButton } from '../../../shared/components';
import { useDismissableMenu, usePointerMenuPosition } from '../../../shared/components';
import { useOpenChangeRequests } from '../hooks/useOpenChangeRequests';
import { AdminContext } from '../../admin/state/admin.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { offersManageAccess } from '../../access/manage-access-affordance';
import { useAppRegistry } from '../../../core/registry';
import { fetchFileAccess, fetchProspectiveAccess } from '../../access/api';
import {
  TreeActionConfirmDialog,
  type DeleteMode,
  type FolderProposals,
  type MoveAccessChange,
  type TreeConfirmRequest,
} from './TreeActionConfirm';
import {
  ACCESS_LOOKUP_TIMEOUT_MS,
  accessChangeOf,
  moveWarnings,
  platformFileDragRefusal,
  platformFileMoveRefusal,
} from '../utils/treeConfirm';

/**
 * The tree row — the prototype's `.trow` (proto:684-693), and token for token
 * the same string as the Library sidebar's `rowClass`
 * (`PluginsSidebar.tsx:68-72`). Two sidebars in one app should not read as two
 * different products, and the only way to guarantee that is for both to be
 * this one declaration.
 *
 * Names and one caret, nothing else. The folder icon repeated what the caret
 * already said and the file icon repeated what the extension already said;
 * both stood where the name should start (proto:3552-3559).
 */
const ROW_CLASS =
  'flex w-full items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-left text-ui transition-colors';
const ROW_TONE = (current: boolean) =>
  current ? 'bg-hover font-semibold text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink';

/** Indent: `10 + depth * 13` (proto:3561). */
const indentFor = (depth: number) => 10 + depth * 13;

/**
 * The caret's slot — 13px wide, and rendered EMPTY for a file. Every folder
 * shows the caret, an empty one included: without it a folder reads as a file.
 * The slot is what keeps a file's name in line with its siblings' once the
 * icons are gone: the indent is the tree, so it has to survive them
 * (proto:3571-3572).
 */
function CaretSlot({ open, show }: { open?: boolean; show: boolean }) {
  return (
    <span className="flex h-3.5 w-3.5 flex-none items-center justify-center text-ink-faint">
      {show && (
        <ChevronRight
          size={13}
          className={cn('transition-transform duration-150', open && 'rotate-90')}
        />
      )}
    </span>
  );
}

/** How many trailing characters of a file name always stay on screen. */
const FILE_NAME_TAIL = 8;

/**
 * A file's name, truncated in the MIDDLE when it does not fit: the lead is
 * shortened with an ellipsis and the last `FILE_NAME_TAIL` characters stay —
 * for an ordinary name that is the extension, the part that says what the
 * file is. A name that fits reads exactly as before, because the two halves
 * sit flush against each other.
 *
 * The split halves are a picture, so they are hidden from assistive tech; the
 * whole name is carried once, unsplit, in a visually hidden span. A folder has
 * no extension to protect and keeps the plain end truncation.
 */
function FileName({ name }: { name: string }) {
  // By code point, so the split never lands inside a surrogate pair.
  const chars = Array.from(name);
  if (chars.length <= FILE_NAME_TAIL) return <span className="truncate">{name}</span>;
  return (
    <span className="flex min-w-0" data-file-name>
      <span className="sr-only">{name}</span>
      <span aria-hidden className="truncate" data-name-lead>
        {chars.slice(0, -FILE_NAME_TAIL).join('')}
      </span>
      <span aria-hidden className="flex-none whitespace-pre" data-name-tail>
        {chars.slice(-FILE_NAME_TAIL).join('')}
      </span>
    </span>
  );
}

// ── Pinned folders (client-side, localStorage) ──

const PINNED_STORAGE_KEY = 'bevel-pinned-folders';

function readPinnedPaths(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

interface PinnedController {
  /**
   * Whether this tree offers pinning at all. Only the Knowledge explorer has
   * a Company Context section to pin INTO; a tree without one hides the item
   * rather than offering a verb that lands nowhere.
   */
  available: boolean;
  isPinned: (path: string) => boolean;
  togglePin: (path: string) => void;
}

// Default no-op so a ContextMenu rendered outside the provider (e.g. in a unit
// test) never throws — the real controller is supplied by FileExplorer.
const NO_PINNING: PinnedController = {
  available: false,
  isPinned: () => false,
  togglePin: () => {},
};
const PinnedContext = createContext<PinnedController>(NO_PINNING);
const usePinned = () => useContext(PinnedContext);

// Lets the deep right-click menu open the Manage access sheet without prop
// drilling through the recursive tree. FileExplorer supplies the opener and
// renders the dialog.
const ManageAccessContext = createContext<(entry: FileTreeEntry) => void>(() => {});
const useManageAccess = () => useContext(ManageAccessContext);

/**
 * The tree shows files from TWO places: this branch, and the caller's own
 * open change requests. A path in this controller is the second kind — it was
 * synthesized into the tree from `minePaths` because it does not exist on the
 * branch — and its row renders differently and opens the change request,
 * because there is no content here to open.
 *
 * Context, not props, for the same reason as the two above: the tree is
 * recursive, and every intermediate directory would otherwise have to carry
 * a concern that only file rows have.
 */
interface SuggestionsController {
  /** CR number for a synthesized suggestion-only path; null for real files. */
  crFor(path: string): number | null;
  /** Open the shared change-request dialog on the request this path belongs to. */
  open(path: string, crNumber: number): void;
  /**
   * The caller AUTHORED this request, so they may take it back.
   *
   * Every suggestion row is the caller's own today — the map they are
   * synthesized from is `/mine`. The menu asks anyway, because the answer is
   * what the offer means: an owner looking at someone else's proposal must
   * never be shown a Withdraw (their "no" is Decline, in the dialog), and
   * this predicate is already right for the day those rows appear here.
   */
  mine(crNumber: number): boolean;
  /**
   * Every file the request carries — a multi-file drop is ONE request, and
   * withdrawing it withdraws all of them, which the confirmation says out loud.
   * Empty when the request has not arrived in the shared list yet.
   */
  filesOf(path: string, crNumber: number): string[];
  /**
   * Cancel the request down the author-cancel path — the same call the file
   * page's change box makes — and tell the app its request list changed, so
   * the rows go without a reload.
   */
  withdraw(crNumber: number): Promise<void>;
}
const SuggestionsContext = createContext<SuggestionsController>({
  crFor: () => null,
  open: () => {},
  mine: () => false,
  filesOf: () => [],
  withdraw: async () => {},
});
const useSuggestions = () => useContext(SuggestionsContext);

/**
 * Which row is current, and where a row's click goes.
 *
 * Context, for the same reason as the three above — and because the SAME rows
 * serve two navs. The Knowledge explorer opens a file in the pane workspace
 * on the checked-out branch; the Library's Skills tree opens a skill on its
 * own page, on the default branch, whatever is checked out. The rows know
 * neither: they report the path they hold and read which one is active.
 */
export interface TreeNav {
  /** The workspace-relative path the surface is showing — lights its row, reveals its folders. */
  activePath: string | null;
  open(path: string): void;
  /**
   * Extra items for a row's context menu, decided by the SURFACE for the
   * entry at hand — injected, so the one tree serves every nav without
   * growing a verb per caller. Rendered after the tree's own create items,
   * in the order given; absent or empty, the menu is the tree's alone.
   * (The Library's Plugins tree adds "New plugin" on folders this way.)
   */
  menuItems?(entry: FileTreeEntry): TreeMenuItem[];
}

/** One injected context-menu item — see `TreeNav.menuItems`. */
export interface TreeMenuItem {
  /** Stable within one menu; keys the rendered item. */
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect(): void;
}
const TreeNavContext = createContext<TreeNav>({ activePath: null, open: () => {} });

/**
 * Which tree this is, for the upload banners — see `UploadTarget`. Every drop
 * inside a `TreeChrome` carries it into `dispatchUpload`, and the
 * `UploadNotices` inside the same chrome renders only the banners that come
 * back with it. One page can hold two of these trees (the Library sidebar
 * holds `Skills/` and `Plugins/`); before they were told apart, one drop
 * painted its notice in both.
 */
const UploadTargetContext = createContext<UploadTarget>(KNOWLEDGE_UPLOAD_TARGET);

/** The tree the surrounding `TreeChrome` is, for a drop or a banner. */
const useUploadTarget = () => useContext(UploadTargetContext);

/**
 * Ask before a delete or a move — see `TreeActionConfirm`. `TreeChrome` holds
 * the one open request and renders its dialog; a row outside any chrome has
 * no one to ask, so the default runs the operation as it always did.
 */
const TreeConfirmContext = createContext<(request: TreeConfirmRequest) => void>((request) => {
  void request.run();
});
const useTreeConfirm = () => useContext(TreeConfirmContext);

/**
 * The row button for a path, found in the DOM. A move is dropped on ANOTHER
 * row, so the dragged row's ref is not in hand where the drop lands; the path
 * is. (A pinned folder renders twice — the first match is the one to return to.)
 */
function rowForPath(path: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-tree-path]')) {
    if (el.dataset.treePath === path) return el;
  }
  return null;
}
const useTreeNav = () => useContext(TreeNavContext);

/** Depth-first lookup of a tree entry by its exact relativePath. */
function findEntryByPath(node: FileTreeEntry, path: string): FileTreeEntry | null {
  if (node.relativePath === path) return node;
  if (!node.children) return null;
  for (const child of node.children) {
    const found = findEntryByPath(child, path);
    if (found) return found;
  }
  return null;
}

// ── Download permission ──

/**
 * The tooltip on a Download the caller may not use, and the reason a late
 * refusal gives. One string, because the menu and the 403 notice are two
 * views of the SAME verdict and must not drift.
 */
export const DOWNLOAD_DENIED_MESSAGE = "You don't have download permission for this item";

/**
 * The entry's `download:` verdict, asked ONCE — the menu mounts when it
 * opens and unmounts when it closes, so the request is per menu open, never
 * per tree render (one request per row was the alternative, and it is why
 * this lives here and not on the row).
 *
 * `null` means "not known": the lookup is in flight, there is nothing to ask
 * about, or it failed. The item stays ENABLED on null — a flash of disabled
 * on every menu open would be worse than the 403 this preflight exists to
 * avoid, and the backend's own gate is authoritative either way.
 *
 * The path goes to the server workspace-relative, exactly as the download
 * URLs send it: the access route strips `<kbDirName>/` itself, with the same
 * strip the download gate applies, so the preflight asks the question the
 * gate will answer. A path the route refuses outright (the tree root's `.`)
 * throws and leaves the verdict unknown, which is the enabled-as-today case.
 */
function useDownloadVerdict(entry: FileTreeEntry | null): boolean | null {
  const { workspaceId } = useWorkspace();
  const path = entry?.relativePath ?? null;
  const kind = entry?.type === 'directory' ? 'folder' : 'file';
  // The verdict is stored WITH the question it answers, and read back only
  // while that question still stands. Keying it — rather than clearing it
  // when a new lookup starts — is what makes an answer about a PREVIOUS
  // entry unreadable as this one's: a stale `false` would disable a Download
  // the caller does have, and would stay disabled for good if the new lookup
  // failed, because the failure path deliberately leaves the verdict alone.
  // Keying also costs no extra render, so there is no flash of a wrong state.
  const key = workspaceId && path !== null ? `${workspaceId}\u0000${path}\u0000${kind}` : null;
  const [answered, setAnswered] = useState<{ key: string; verdict: boolean } | null>(null);
  useEffect(() => {
    if (!workspaceId || path === null || key === null) return;
    let cancelled = false;
    fetchFileAccess(workspaceId, path, kind)
      .then((res) => {
        if (!cancelled) setAnswered({ key, verdict: res.canDownload });
      })
      .catch(() => {
        // Default-allow, as `useFileAccess` does: a transient lookup failure
        // must not take an action away from someone who has it.
      });
    return () => {
      cancelled = true;
    };
  }, [key, workspaceId, path, kind]);
  return answered !== null && answered.key === key ? answered.verdict : null;
}

// ── Context Menu ──

function ContextMenu({
  x,
  y,
  entry,
  isRoot,
  onClose,
  onCreateFile,
  onCreateFolder,
  onRename,
  renameRefusal = null,
  onDownload,
  onWithdraw,
  returnFocusTo,
  deletable = true,
  extraItems = [],
  proposed = false,
}: {
  x: number;
  y: number;
  entry: FileTreeEntry;
  isRoot: boolean;
  /**
   * The entry exists only on a change request's branch. Nothing that acts on
   * THIS branch's copy applies (there is none), so only the path and Manage
   * access — which follows the file to the proposal — are offered.
   */
  proposed?: boolean;
  /** False for a folder the platform owns (a reserved root): no Delete. */
  deletable?: boolean;
  onClose: () => void;
  onCreateFile?: () => void;
  onCreateFolder?: () => void;
  onRename?: () => void;
  /**
   * Why Rename is not on offer for this row — a platform file stays in its
   * folder, and a rename is a move. The item is still drawn and still
   * reachable: an affordance that vanishes teaches nobody why.
   */
  renameRefusal?: string | null;
  onDownload?: () => void;
  /**
   * Take this suggestion back. Supplied ONLY by a proposed row whose change
   * request the caller authored — its absence is what keeps Withdraw off an
   * owner's view of someone else's proposal, the same way `onRename`'s
   * absence keeps Rename off a row that cannot be renamed.
   */
  onWithdraw?: () => void;
  /** The surface's own items for this entry — see `TreeNav.menuItems`. */
  extraItems?: TreeMenuItem[];
  /** The row this menu was opened from — Escape hands focus back to it. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}) {
  const { deleteEntry, unzipHere, kbDirName, fileTree } = useWorkspace();
  const suggestions = useSuggestions();
  const { isPinned, togglePin, available: pinning } = usePinned();
  const openManageAccess = useManageAccess();
  const confirm = useTreeConfirm();
  const pinned = isPinned(entry.relativePath);
  const [unzipping, setUnzipping] = useState(false);
  // Asked only where a Download is on offer — a proposed row or an absent
  // folder has none, and must not spend a request finding that out.
  const canDownload = useDownloadVerdict(onDownload ? entry : null);
  const downloadDenied = canDownload === false;
  // Outside-click, Escape, and focus return — none of which `MenuPanel`
  // provides (it is presentation only, by design).
  const ref = useDismissableMenu<HTMLDivElement>({ open: true, onClose, returnFocusTo });
  // Measured placement, because the pointer is not a safe place to paint from.
  // A folder's menu is nine rows, and a right-click low in the sidebar used to
  // draw it straight off the bottom of the window with no way to reach what
  // fell below: `Manage access`, `Rename` and `Delete` among them, and for a
  // folder that `Manage access` row is the product's only route to it.
  const pos = usePointerMenuPosition(ref, x, y);

  // Only files whose name ends with `.zip` (case-insensitive) get the
  // extraction affordance — matches the OS shell-extension behavior users
  // already know from Windows Explorer / macOS Finder.
  const isZip = !proposed && entry.type === 'file' && /\.zip$/i.test(entry.name);

  // The one prototype context-menu item the platform has never had
  // (proto:3948). The page-level Share `⌄ → Copy path` does not cover it: that only
  // ever reaches the file you have open, never a folder row or an unopened
  // one. A clipboard write can be refused outright (a non-secure origin), and
  // a silent no-op is the worst possible answer to "copy this" — so a refusal
  // surfaces the same way every other failure in this tree does.
  // The ROOT-ANCHORED form: pasted into a Markdown link it resolves from any
  // folder, where the bare `knowledge-base/…` resolved against the linking
  // file's own folder and landed on File not found.
  const handleCopyPath = async () => {
    const copied = rootAnchoredPath(entry.relativePath);
    try {
      await navigator.clipboard.writeText(copied);
      onClose();
    } catch (err) {
      console.error('Failed to copy path:', err);
      onClose();
      alert(`Couldn't copy the path to the clipboard.\n\n${copied}`);
    }
  };

  // Delete asks first; Confirm runs the delete exactly as the menu used to.
  // A KB folder can also hold proposed files — the dialog then offers to take
  // them out of their change requests as well (`runWithProposals`).
  const repoFolder =
    entry.type === 'directory' && kbDirName && entry.relativePath.startsWith(`${kbDirName}/`)
      ? entry.relativePath.slice(kbDirName.length + 1)
      : null;
  const handleDelete = () => {
    onClose();
    const deleteOnBranch = async (): Promise<boolean> => {
      // A folder only proposed files put in the tree is not on this branch:
      // nothing to delete here, and asking the server would only queue a
      // commit for a path that does not exist.
      if (fileTree && !pathExistsInTree(fileTree, entry.relativePath)) return true;
      try {
        return (await deleteEntry(entry.relativePath)) !== false;
      } catch (err) {
        console.error('Failed to delete entry:', err);
        const msg = err instanceof Error ? err.message : String(err);
        alert(`Failed to delete ${entry.relativePath}:\n${msg}`);
        return false;
      }
    };
    confirm({
      kind: 'delete',
      entry,
      returnFocusTo: () => returnFocusTo?.current ?? null,
      // The folder it was in — the row itself is gone once the delete lands.
      focusAfterRun: () => rowForPath(entry.relativePath.split('/').slice(0, -1).join('/')),
      isProposed: (path) => suggestions.crFor(path) !== null,
      run: async () => {
        await deleteOnBranch();
      },
      ...(repoFolder !== null && {
        runWithProposals: async () => {
          // The branch first: a delete that failed (or was called off over
          // unsaved tabs) must not have already emptied the proposals.
          if (!(await deleteOnBranch())) return;
          let leftovers: string[];
          try {
            // What the removal could not take out, said rather than left to
            // reappear unexplained in the tree once the refetch lands.
            leftovers = (await removeFolderFromChangeRequests(repoFolder)).flatMap((r) => [
              ...(r.stillProposed.length > 0
                ? [`#${r.number} still proposes ${r.stillProposed.join(', ')} — added while the folder was being deleted.`]
                : []),
              ...(r.keptForSaves ? [`#${r.number} stays open: a save to it was still landing.`] : []),
            ]);
          } catch (err) {
            console.error('Failed to remove proposed changes:', err);
            const msg = err instanceof Error ? err.message : String(err);
            alert(`Deleted ${entry.name}, but couldn't remove its proposed changes:\n${msg}`);
            window.dispatchEvent(new Event(PR_STALE_EVENT));
            return;
          }
          // The rows and dots go now; the refetch confirms it.
          window.dispatchEvent(new CustomEvent(SUGGESTIONS_RETRACTED_EVENT, { detail: { folder: repoFolder } }));
          window.dispatchEvent(new Event(PR_STALE_EVENT));
          if (leftovers.length > 0) {
            alert(`Deleted ${entry.name} and its proposed changes, except:\n${leftovers.join('\n')}`);
          }
        },
      }),
    });
  };

  const handleUnzip = async () => {
    if (unzipping) return;
    setUnzipping(true);
    try {
      const result = await unzipHere(entry.relativePath);
      onClose();
      // Surface a summary banner only when something was skipped — a silent
      // success is the right behavior for the happy path (matches Finder /
      // Explorer's "Extract here").
      if (result.skipped.length > 0) {
        const preview = result.skipped
          .slice(0, 5)
          .map((s) => `  - ${s.path}: ${s.reason}`)
          .join('\n');
        const more = result.skipped.length > 5 ? `\n  …and ${result.skipped.length - 5} more` : '';
        alert(
          `Extracted ${result.extracted} file(s) from ${entry.name}.\n` +
            `Skipped ${result.skipped.length} entry(ies):\n${preview}${more}`,
        );
      }
    } catch (err) {
      console.error('Failed to unzip:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to unzip ${entry.name}:\n${msg}`);
    } finally {
      setUnzipping(false);
    }
  };

  return (
    // Positioning stays with the caller — `MenuPanel` is presentation only, so
    // the fixed wrapper and its measured placement are ours, and the panel
    // inside is the shared one.
    <div
      ref={ref}
      className="fixed z-50"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
    <MenuPanel role="menu" aria-label={`Actions for ${entry.name}`} className="min-w-[180px]">
      {onCreateFile && (
        <MenuItem role="menuitem" onClick={() => { onCreateFile(); onClose(); }}>
          <span className="flex items-center gap-2"><FilePlus size={14} />New file</span>
        </MenuItem>
      )}
      {onCreateFolder && (
        <MenuItem role="menuitem" onClick={() => { onCreateFolder(); onClose(); }}>
          <span className="flex items-center gap-2"><FolderPlus size={14} />New folder</span>
        </MenuItem>
      )}
      {/* The surface's own verbs for this entry, after the tree's create
          items — a "make a thing here" reads with the other two. */}
      {extraItems.map((item) => (
        <MenuItem key={item.id} role="menuitem" onClick={() => { item.onSelect(); onClose(); }}>
          <span className="flex items-center gap-2">{item.icon}{item.label}</span>
        </MenuItem>
      ))}
      {isZip && (
        <MenuItem role="menuitem" onClick={handleUnzip} disabled={unzipping}>
          <span className="flex items-center gap-2">
            <PackageOpen size={14} />
            {unzipping ? 'Unzipping…' : 'Unzip here'}
          </span>
        </MenuItem>
      )}
      {onDownload && (
        <MenuItem
          role="menuitem"
          // `aria-disabled`, not `disabled`: the item keeps its tooltip and
          // its place in the tab order, so the reason is reachable by mouse
          // AND by keyboard. Activation is refused here instead — which is
          // what stops Enter and Space on the focused item, not just a click.
          aria-disabled={downloadDenied || undefined}
          title={downloadDenied ? DOWNLOAD_DENIED_MESSAGE : undefined}
          onClick={() => {
            if (downloadDenied) return;
            onDownload();
            onClose();
          }}
        >
          <span className="flex items-center gap-2">
            <Download size={14} />
            {entry.type === 'directory' ? 'Download as zip' : 'Download'}
          </span>
        </MenuItem>
      )}
      {/* The workspace root has no path worth linking: it would copy `/.`. */}
      {!isRoot && (
        <MenuItem role="menuitem" onClick={handleCopyPath}>
          <span className="flex items-center gap-2"><Link2 size={14} />Copy path</span>
        </MenuItem>
      )}
      {offersManageAccess(entry) && (
        <>
          <div className="my-1 border-t border-line" />
          <MenuItem role="menuitem" onClick={() => { openManageAccess(entry); onClose(); }}>
            <span className="flex items-center gap-2"><Users size={14} />Manage access</span>
          </MenuItem>
        </>
      )}
      {entry.type === 'directory' && !isRoot && pinning && (
        <MenuItem role="menuitem" onClick={() => { togglePin(entry.relativePath); onClose(); }}>
          <span className="flex items-center gap-2">
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? 'Unpin' : 'Pin to top'}
          </span>
        </MenuItem>
      )}
      {!isRoot && onRename && (
        <MenuItem
          role="menuitem"
          // Same shape as a denied Download: `aria-disabled`, so the reason
          // stays reachable by mouse AND keyboard, with activation refused
          // here rather than by taking the item out of the tab order.
          aria-disabled={renameRefusal ? true : undefined}
          title={renameRefusal ?? undefined}
          onClick={() => {
            if (renameRefusal) return;
            onRename();
            onClose();
          }}
        >
          <span className="flex items-center gap-2"><Pencil size={14} />Rename</span>
        </MenuItem>
      )}
      {!isRoot && deletable && (
        // Danger tone comes from the primitive, not from a hand-written red.
        <MenuItem role="menuitem" tone="danger" onClick={handleDelete}>
          <span className="flex items-center gap-2"><Trash2 size={14} />Delete</span>
        </MenuItem>
      )}
      {onWithdraw && (
        // Last, in danger tone, exactly where Delete sits on a row that has
        // one: it is the same shape of act — what the row points at stops
        // existing — and a proposed row never has a Delete to collide with.
        <MenuItem role="menuitem" tone="danger" onClick={() => { onWithdraw(); onClose(); }}>
          <span className="flex items-center gap-2"><Undo2 size={14} />Withdraw suggestion</span>
        </MenuItem>
      )}
    </MenuPanel>
    </div>
  );
}

// ── Inline Input ──

function InlineInput({
  onSubmit,
  onCancel,
  placeholder,
}: {
  onSubmit: (value: string) => void;
  onCancel: () => void;
  placeholder: string;
}) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const error = trimmed.length === 0 ? null : validateFilename(trimmed);
  const valid = trimmed.length > 0 && error === null;

  const submit = () => {
    if (valid) onSubmit(trimmed);
  };

  return (
    <div className="w-full">
      <TextField
        autoFocus
        className={cn('bg-sunken px-2 py-0.5 text-detail', error && 'border-danger')}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => {
          if (valid) onSubmit(trimmed);
          else onCancel();
        }}
        title={error ?? undefined}
        aria-invalid={error ? true : undefined}
      />
      {error && <div className="mt-0.5 px-1 text-meta text-danger">{error}</div>}
    </div>
  );
}

// ── Rename Input ──

/**
 * `onSubmit` answers with the refusal to show, or null once the rename
 * landed. A refused rename KEEPS THE BOX OPEN with the sentence under it —
 * the name the user typed is still there to fix, which is the whole point of
 * being told "A file named Notes.md already exists in Sales." The box used to
 * close first and report through `alert()`, which was the only way to avoid
 * the create flow's popup loop (the alert blurs the still-mounted input,
 * whose onBlur re-submits); an inline sentence steals no focus, so the loop
 * cannot start.
 */
function RenameInput({
  currentName,
  isFile,
  onSubmit,
  onCancel,
}: {
  currentName: string;
  isFile: boolean;
  onSubmit: (value: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(currentName);
  // The server's answer to the last name submitted. Cleared on every edit, so
  // a name that has been changed since is submitted again rather than read as
  // still-refused.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmed = value.trim();
  const nameError = trimmed.length === 0 ? null : validateFilename(trimmed);
  const error = nameError ?? refusal;
  const valid = trimmed.length > 0 && nameError === null;

  const submit = () => {
    if (submitting) return;
    if (!valid || trimmed === currentName) { onCancel(); return; }
    setSubmitting(true);
    void onSubmit(trimmed)
      // `onSubmit` answers rather than throws; a rejection anyway must still
      // free the box, or it would be stuck refusing to submit again.
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
      .then((answer) => {
        setSubmitting(false);
        // On success the row unmounts this input; only a refusal has anywhere
        // to land.
        setRefusal(answer);
      });
  };

  return (
    <div className="w-full">
      <TextField
        autoFocus
        className={cn('bg-sunken px-2 py-0.5 text-detail', error && 'border-danger')}
        value={value}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        // Frozen while the rename is in flight: an edit made in that window
        // would be discarded by the row unmounting on success, and a refusal
        // coming back would land under a name it was never about. `readOnly`
        // rather than `disabled` so the box keeps focus and the caret.
        readOnly={submitting}
        onChange={(e) => {
          if (submitting) return;
          setValue(e.target.value);
          setRefusal(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        // A name the server has already refused is not sent again on the way
        // out: clicking away from a refusal closes the box, it does not retry
        // a rename that cannot land.
        onBlur={() => { if (refusal !== null) onCancel(); else submit(); }}
        onFocus={(e) => {
          if (isFile) {
            // Select name without extension for files
            const dotIdx = currentName.lastIndexOf('.');
            if (dotIdx > 0) e.target.setSelectionRange(0, dotIdx);
            else e.target.select();
          } else {
            e.target.select();
          }
        }}
        title={error ?? undefined}
        aria-invalid={error ? true : undefined}
      />
      {error && (
        <div role="alert" data-testid="rename-error" className="mt-0.5 px-1 text-meta text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

// ── Row Notice ──

/**
 * One row's own bad news — a refused download, a refused drop — drawn under
 * the row at the row's indent, with a Dismiss. Never an `alert()`: a modal
 * popup stops the whole app to say something the tree can say in place, and
 * (the create flow learned this the hard way) it steals focus from whatever
 * input is still mounted.
 */
function RowNotice({
  message,
  testId,
  dismissLabel,
  paddingLeft,
  onDismiss,
}: {
  message: string;
  testId: string;
  dismissLabel: string;
  paddingLeft: number;
  onDismiss: () => void;
}) {
  return (
    <Banner
      role="alert"
      tone="danger"
      data-testid={testId}
      className="items-center gap-1 rounded-none px-2 py-1 text-xs"
      style={{ paddingLeft }}
    >
      <span className="flex items-start gap-1">
        <span className="flex-1">{message}</span>
        <IconButton size={18} tone="danger" title="Dismiss" aria-label={dismissLabel} onClick={onDismiss}>
          <X size={12} />
        </IconButton>
      </span>
    </Banner>
  );
}

// ── Tree Node ──

const DRAG_MIME = 'application/x-workspace-path';
/**
 * What kind of row is being dragged — `directory` or `file`. The path alone
 * does not say (a folder may be named like a file), and the move dialog asks
 * a file-only access question, so the kind travels with the path.
 */
const DRAG_KIND_MIME = 'application/x-workspace-kind';

export function FileTreeNode({
  entry,
  depth,
  initiallyExpanded,
  collapseChildren,
  reserved = false,
  absent = false,
}: {
  entry: FileTreeEntry;
  depth: number;
  // Overrides the depth-based default for whether this node starts expanded.
  // The explorer's Knowledge/Skills roots use this so their own children start
  // collapsed regardless of depth (auto-reveal on deep links still wins).
  initiallyExpanded?: boolean;
  // When set, this node's direct children start collapsed (so opening Knowledge
  // reveals the ontologies without cascading them all open).
  collapseChildren?: boolean;
  /**
   * The folder is a root the platform owns (`Skills/` in the Library). It is
   * an ordinary collapsible folder row — the same row Knowledge and Data get
   * at the top of the explorer: it takes drops, offers the create buttons,
   * opens the folder's menu on right-click — minus what a reserved root must
   * not do: be renamed, deleted, dragged, or pinned.
   */
  reserved?: boolean;
  /**
   * The folder is not on disk yet — a reserved root drawn before the
   * knowledge base has it, so the way to create it is on screen. Everything
   * that WRITES works (each write creates its parents); what READS the folder
   * is withheld: no Download, which would ask the server for a zip of nothing.
   */
  absent?: boolean;
}) {
  const { createFile, createDirectory, dispatchUpload, isUploading, moveEntry, workspaceId, kbDirName, pendingUploads } = useWorkspace();
  const nav = useTreeNav();
  /**
   * Why this row cannot be renamed, or null when it can. A platform file is
   * refused here with the sentence the server refuses with — the tree says it
   * without a round trip, and says the same thing.
   */
  const platformRefusal = platformFileMoveRefusal(entry.relativePath, kbDirName);
  /**
   * Why it cannot be DRAGGED — the same, minus an admin's one repair (see
   * `platformFileDragRefusal`). Read through the context rather than
   * `useAdmin()` so a tree rendered without an `AdminProvider` — a host app's,
   * a test's — still draws: no provider is simply nobody's admin, which is the
   * refusal this row had before the exception existed.
   */
  const isAdmin = useContext(AdminContext)?.isAdmin ?? false;
  const dragRefusal = platformFileDragRefusal(entry.relativePath, kbDirName, isAdmin);
  const confirm = useTreeConfirm();
  // Which tree this row belongs to, so an upload's banners land here and not
  // in the other tree on the same page.
  const uploadTarget = useUploadTarget();
  // One shared fetch behind this — see `OpenChangeRequestsProvider`.
  const openChangeRequests = useOpenChangeRequests();
  const suggestions = useSuggestions();

  /**
   * A refused download, said in place under the row. Never an `alert()`: the
   * menu's preflight already turns the KNOWN refusal into a disabled item, so
   * what reaches here is the rare late one — permission changed while the
   * menu was open — and a modal popup for it stops the whole app to report
   * something the row itself can say.
   */
  const [downloadError, setDownloadError] = useState<string | null>(null);
  /**
   * A refused drop, said in place under the row it was dropped on — the same
   * treatment a refused download gets, and for the same reason. It used to be
   * an `alert()`, which stops the app to report something the tree can say;
   * the sentence the server sends ("A file named Notes.md already exists in
   * Sales.") is the whole message, so it is shown verbatim.
   */
  const [moveError, setMoveError] = useState<string | null>(null);
  /**
   * Which download the notice is allowed to speak for. The menu closes on
   * click but the ROW does not, so a second Download can be started (reopen,
   * click again) while the first is still in flight — and the two can land
   * out of order. Only the latest may write `downloadError`: without this, a
   * slow refusal arriving after a fast success reports a failed download the
   * user just watched succeed.
   */
  const downloadSeq = useRef(0);

  const handleDownload = useCallback(async () => {
    if (!workspaceId) return;
    // Files hit /file/raw; folders hit /folder/zip and arrive as <name>.zip.
    // Both endpoints share the same per-path `download:` access gate, the
    // same `?download=1` flag shape, and the same Content-Disposition
    // handling on the backend — branching here just picks the URL.
    // The menu preflights the gate's verdict (`useDownloadVerdict`); a 403
    // still reaching here is a permission that changed since it opened.
    const isFolder = entry.type === 'directory';
    const url = isFolder
      ? `/api/workspace/${workspaceId}/folder/zip?path=${encodeURIComponent(entry.relativePath)}&download=1`
      : rawFileUrl(workspaceId, entry.relativePath, { download: true });
    const savedAs = isFolder ? `${entry.name}.zip` : entry.name;
    const seq = ++downloadSeq.current;
    setDownloadError(null);
    try {
      const outcome = await downloadViaBlob(url, savedAs);
      // Superseded: a later download for this row has already spoken.
      if (seq !== downloadSeq.current) return;
      if (!outcome.ok) {
        setDownloadError(
          outcome.status === 403
            ? `Couldn't download ${entry.name}. ${DOWNLOAD_DENIED_MESSAGE}.`
            : `Couldn't download ${entry.name} (HTTP ${outcome.status})${outcome.body ? `: ${outcome.body}` : ''}`,
        );
        return;
      }
    } catch (err) {
      console.error('Failed to download:', err);
      if (seq !== downloadSeq.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setDownloadError(`Couldn't download ${entry.name}: ${msg}`);
    }
  }, [workspaceId, entry.relativePath, entry.name, entry.type]);
  // `null` = no explicit user intent; fall through to the auto-expand / depth
  // default. Once the user clicks the chevron, intent wins over auto-expand
  // until the auto-expand trigger transitions (new file opened, new upload),
  // at which point intent is reset and auto-expand takes over again.
  const [userIntent, setUserIntent] = useState<boolean | null>(null);
  const [creating, setCreating] = useState<'file' | 'directory' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Only the root row uses these refs, but hooks must run unconditionally.
  const rootFileInputRef = useRef<HTMLInputElement>(null);
  const rootFolderInputRef = useRef<HTMLInputElement>(null);

  const handleRootUploadClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    rootFileInputRef.current?.click();
  }, []);

  const handleRootFolderClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    rootFolderInputRef.current?.click();
  }, []);

  /**
   * Every upload into this row goes through here. Nothing is asked first: an
   * upload into a folder the caller cannot read is refused by the server's
   * read-before-write gate, and the refusal shows in this tree's banner.
   */
  const uploadAfterGate = useCallback(
    (input: UploadInput, targetDir: string) => {
      void dispatchUpload(input, targetDir, uploadTarget);
    },
    [dispatchUpload, uploadTarget],
  );

  // Resetting `value` after dispatch lets users re-select the same file and
  // still get an `onChange` event the second time around.
  const pickTarget = entry.relativePath === '.' ? '' : entry.relativePath;
  const handleRootFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) uploadAfterGate({ kind: 'files', files }, pickTarget);
  }, [uploadAfterGate, pickTarget]);

  // Folder picker: each File carries a `webkitRelativePath` like
  // "foldername/sub/file.txt" — we feed those straight into the upload
  // pipeline as pre-resolved paths. Note: `<input webkitdirectory>` only
  // enumerates files (the browser hides empty subdirs from us), so empty
  // folders are only preserved via the drag-and-drop path that uses the
  // FileSystem entries API.
  const handleRootFolderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const items = files.map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
    uploadAfterGate({ kind: 'paths', items }, pickTarget);
  }, [uploadAfterGate, pickTarget]);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const paddingLeft = indentFor(depth);
  const isRoot = entry.relativePath === '.';
  const isPending = pendingUploads.has(entry.relativePath);
  // A folder with nothing in it still gets its caret — without one it reads
  // as a file — and opening it says so with a muted "Empty" row.
  const isEmpty = (entry.children?.length ?? 0) === 0;
  // Escape inside the context menu hands focus back to the row it came from.
  const rowRef = useRef<HTMLButtonElement>(null);

  // Auto-expand a directory whenever the open file lives inside it (so
  // deep-link URLs reveal the file's row in the tree) or while files
  // dropped under it are still uploading (so the user can watch them
  // fill in).
  const isOpenFileAncestor = entry.type === 'directory' && !!nav.activePath && (
    isRoot || nav.activePath.startsWith(entry.relativePath + '/')
  );
  const autoExpanded = entry.type === 'directory' && (isPending || isOpenFileAncestor);

  // Fingerprint of what currently drives auto-expand. When it transitions
  // (different file opened, upload starts), the user's prior collapse intent
  // is stale — reset so deep-links / new uploads can re-reveal the folder.
  const autoTrigger = `${isPending ? 'P' : ''}|${isOpenFileAncestor ? nav.activePath : ''}`;
  const prevAutoTriggerRef = useRef(autoTrigger);
  useEffect(() => {
    if (prevAutoTriggerRef.current !== autoTrigger) {
      prevAutoTriggerRef.current = autoTrigger;
      setUserIntent(null);
    }
  }, [autoTrigger]);

  const isExpanded = userIntent ?? (autoExpanded || (initiallyExpanded ?? depth < 2));

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Rendered directly under the row it belongs to, at the row's own indent,
  // so the failure is attached to the file it is about — the sidebar shows
  // many rows and a banner at the top would name one of them in prose.
  const downloadNotice = downloadError && (
    <RowNotice
      message={downloadError}
      testId="tree-download-error"
      dismissLabel="Dismiss download error"
      paddingLeft={paddingLeft}
      onDismiss={() => setDownloadError(null)}
    />
  );
  const moveNotice = moveError && (
    <RowNotice
      message={moveError}
      testId="tree-move-error"
      dismissLabel="Dismiss move error"
      paddingLeft={paddingLeft}
      onDismiss={() => setMoveError(null)}
    />
  );

  /**
   * The rename box's submit: move this entry to `newName` beside itself.
   * Answers with the sentence to show IN the box — "A file named Notes.md
   * already exists in Sales." — or null once the rename landed, which is the
   * only case that closes the box. A refused rename leaves the name the user
   * typed on screen to fix; it is never reported through `alert()`, which
   * would say it somewhere the user has to dismiss and, by stealing focus
   * from the still-mounted input, re-submit the same doomed rename.
   */
  const renameTo = useCallback(async (newName: string): Promise<string | null> => {
    const parentDir = entry.relativePath.substring(0, entry.relativePath.lastIndexOf('/'));
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;
    try {
      await moveEntry(entry.relativePath, newPath);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    setRenaming(false);
    return null;
  }, [entry.relativePath, moveEntry]);

  // ── Drag source (internal reorder) ──
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (isRoot || reserved || dragRefusal) { e.preventDefault(); return; }
    e.dataTransfer.setData(DRAG_MIME, entry.relativePath);
    e.dataTransfer.setData(DRAG_KIND_MIME, entry.type);
    e.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  }, [entry.relativePath, entry.type, isRoot, reserved, dragRefusal]);

  const handleDragEnd = useCallback(() => {
    setDragging(false);
  }, []);

  // ── Drop target ──
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);

      // Internal move (reorder)
      const sourcePath = e.dataTransfer.getData(DRAG_MIME);
      if (sourcePath) {
        const droppedOn = entry.type === 'directory'
          ? (isRoot ? '' : entry.relativePath)
          : '';
        // "The top level" is the top of the tree the dragged row lives in —
        // the KB clone's own root — not the workspace folder the clone sits
        // in. The explorer draws the clone's roots (Knowledge, Data, …) and
        // its loose files, never a row for the clone itself, so a drop that
        // resolves to no folder is how the clone's root is reached at all:
        // it is where an admin drops a misplaced `roles.yaml` to put it back.
        // Left bare, that move would send the file to `roles.yaml` BESIDE the
        // clone — out of the repository, where nothing reads it and git never
        // sees it again.
        const kbPrefix = kbDirName ? `${kbDirName}/` : null;
        const targetDir =
          droppedOn === '' && kbPrefix !== null && sourcePath.startsWith(kbPrefix)
            ? kbDirName!
            : droppedOn;
        const name = sourcePath.split('/').pop()!;
        const newPath = targetDir ? `${targetDir}/${name}` : name;
        // Skip no-op or nesting a directory inside itself
        if (
          newPath === sourcePath ||
          targetDir === sourcePath ||
          targetDir.startsWith(sourcePath + '/')
        ) {
          return;
        }
        // The dragged row is a platform file: refused here, with the server's
        // sentence, and nothing is sent. The row itself is not draggable, so
        // this catches a drag begun before the tree knew the path's shape
        // (a drop is the last moment the answer is still cheap).
        const refusal = platformFileDragRefusal(sourcePath, kbDirName, isAdmin);
        if (refusal) {
          alert(refusal);
          return;
        }
        // Every cross-folder move is an access change, so it asks first;
        // nothing is sent until Confirm.
        confirm({
          kind: 'move',
          sourcePath,
          sourceIsDirectory: e.dataTransfer.getData(DRAG_KIND_MIME) === 'directory',
          targetDir,
          // Named after the row that was dropped on, so a drop that resolved
          // to the clone's root still reads as "the top level".
          destinationLabel: droppedOn ? entry.name : 'the top level',
          returnFocusTo: () => rowForPath(sourcePath),
          // The row it was dropped on stays put; the source row moves away.
          focusAfterRun: () => rowForPath(entry.relativePath),
          run: async () => {
            try {
              setMoveError(null);
              await moveEntry(sourcePath, newPath);
            } catch (err) {
              // Same surfacing as rename — a refused move (a name already
              // taken here, a folder the caller may not write) must not read
              // as one that silently reverted. Both entries stay where they
              // are: the server moved nothing.
              const msg = err instanceof Error ? err.message : String(err);
              setMoveError(msg);
            }
          },
        });
        return;
      }

      // External file/folder drop. Snapshot the entries synchronously
      // before any await — the browser invalidates `DataTransfer` once the
      // handler returns, and the walker awaits inside.
      const dir = entry.type === 'directory' ? entry.relativePath : '';
      const targetDir = dir === '.' ? '' : dir;
      const entries = e.dataTransfer.items ? snapshotEntries(e.dataTransfer.items) : [];
      if (entries.length > 0) {
        uploadAfterGate({ kind: 'items', entries }, targetDir);
        return;
      }
      // Fallback for older browsers / non-entry drops: use the flat FileList.
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      uploadAfterGate({ kind: 'files', files }, targetDir);
    },
    [entry, isRoot, uploadAfterGate, moveEntry, confirm, kbDirName, isAdmin],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (entry.type === 'directory') {
      e.dataTransfer.dropEffect = 'move';
      setDragOver(true);
    }
  }, [entry.type]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  if (entry.type === 'directory') {
    const dirPath = isRoot ? '' : entry.relativePath;
    const createButtons = (
      <>
        <IconButton
          size={18}
          title="New file"
          aria-label={`New file in ${entry.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setUserIntent(true);
            setCreating('file');
          }}
        >
          <FilePlus size={13} />
        </IconButton>
        <IconButton
          size={18}
          title="New folder"
          aria-label={`New folder in ${entry.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setUserIntent(true);
            setCreating('directory');
          }}
        >
          <FolderPlus size={13} />
        </IconButton>
      </>
    );
    const pickerButtons = (
      <>
        <IconButton
          size={18}
          title="Add files"
          aria-label="Add files"
          disabled={isUploading}
          onClick={handleRootUploadClick}
        >
          <Upload size={13} />
        </IconButton>
        <input
          ref={rootFileInputRef}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          data-testid="file-explorer-file-input"
          onChange={handleRootFileChange}
        />
        <IconButton
          size={18}
          title="Add folder"
          aria-label="Add folder"
          disabled={isUploading}
          onClick={handleRootFolderClick}
        >
          <FolderUp size={13} />
        </IconButton>
        <input
          ref={rootFolderInputRef}
          type="file"
          multiple
          webkitdirectory=""
          hidden
          aria-hidden="true"
          data-testid="file-explorer-folder-input"
          onChange={handleRootFolderChange}
        />
      </>
    );
    return (
      <div>
        <div
          className={cn(
            ROW_CLASS,
            ROW_TONE(false),
            'group',
            dragOver && 'bg-hover text-ink ring-1 ring-accent/40',
          )}
          style={{ paddingLeft, opacity: dragging ? 0.5 : isPending ? 0.6 : 1 }}
          draggable={!isRoot && !reserved && !renaming && !isPending && !dragRefusal}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onContextMenu={handleContextMenu}
        >
          <button
            ref={rowRef}
            type="button"
            data-tree-path={entry.relativePath}
            aria-expanded={isExpanded}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => setUserIntent(!isExpanded)}
          >
            <CaretSlot open={isExpanded} show />
            {renaming ? (
              <RenameInput
                currentName={entry.name}
                isFile={false}
                onSubmit={renameTo}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <span className="truncate">{entry.name}</span>
            )}
          </button>
          <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
            {createButtons}
          </div>
          {isRoot && pickerButtons}
        </div>
        {downloadNotice}
        {moveNotice}
        {isExpanded && (
          <div>
            {creating && (
              // Line the input up with the child rows it is about to join:
              // one more indent step (13px), plus the caret slot (13px) and
              // the row gap (6px) the child's name starts after.
              <div style={{ paddingLeft: paddingLeft + 32 }} className="px-2 py-0.5">
                <InlineInput
                  placeholder={creating === 'file' ? 'filename' : 'folder name'}
                  onSubmit={async (name) => {
                    const fullPath = dirPath ? `${dirPath}/${name}` : name;
                    const kind = creating;
                    // Close the inline input BEFORE anything can fail. On
                    // error the alert() below steals focus; leaving the input
                    // mounted means dismissing the alert blurs it, and the
                    // input's onBlur re-fires this same onSubmit — an infinite
                    // "Failed to create …" popup loop against an unchanging
                    // 403. Unmounting first breaks that cycle.
                    setCreating(null);
                    try {
                      if (kind === 'file') await createFile(fullPath);
                      else await createDirectory(fullPath);
                    } catch (err) {
                      // Surface the refusal (a protected branch's write gate,
                      // or the read-before-write gate: "You don't have
                      // permission to write to …") — otherwise the input
                      // clears and nothing appears, which reads as the file
                      // silently vanishing.
                      const msg = err instanceof Error ? err.message : String(err);
                      alert(`Failed to create ${name}:\n${msg}`);
                    }
                  }}
                  onCancel={() => setCreating(null)}
                />
              </div>
            )}
            {isEmpty && !creating && (
              // Not a row anyone acts on — no path, no focus, no menu — so
              // keyboard navigation and the context menu never meet it. It
              // sits where a first child would, name column included.
              <div
                data-tree-empty
                className={cn(ROW_CLASS, 'text-ink-faint')}
                style={{ paddingLeft: indentFor(depth + 1) }}
              >
                <CaretSlot show={false} />
                <span className="truncate">Empty</span>
              </div>
            )}
            {entry.children?.map((child) => (
              <FileTreeNode
                key={child.relativePath}
                entry={child}
                depth={depth + 1}
                initiallyExpanded={collapseChildren ? false : undefined}
              />
            ))}
          </div>
        )}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            entry={entry}
            isRoot={isRoot}
            onClose={() => setContextMenu(null)}
            onCreateFile={() => { setUserIntent(true); setCreating('file'); }}
            onCreateFolder={() => { setUserIntent(true); setCreating('directory'); }}
            // A reserved root is the platform's: no rename, no delete. (No pin
            // either, but that needs no gate: only the Knowledge explorer
            // offers pinning, and its roots are not reserved.)
            onRename={reserved ? undefined : () => setRenaming(true)}
            // A folder NAMED like a platform file (`access.md/`) meets the same
            // rule: the server reads the path, not the kind, and refuses to
            // move it. Without this the row refused the drag and offered the
            // rename, which opened an editor only to fail on the round trip.
            renameRefusal={platformRefusal}
            deletable={!reserved}
            onDownload={absent ? undefined : handleDownload}
            extraItems={nav.menuItems?.(entry)}
            returnFocusTo={rowRef}
          />
        )}
      </div>
    );
  }

  // A file from the caller's own open change request that does not exist on
  // this branch. Its row is a LINK to the request, not a file: there is no
  // content here to show, so clicking opens the change-request view, and none
  // of the file affordances (rename, drag, download) apply — they would all
  // 404 against a path this branch has never heard of. The context menu keeps
  // only what makes sense for a proposal: the path, and Manage access, which
  // the chrome points at the change request's branch. The accent colour is
  // the tell that this is proposed, not present.
  const suggestedCr = suggestions.crFor(entry.relativePath);
  if (suggestedCr !== null) {
    // The one thing the author can DO to a proposal from here: take it back.
    // The reporter of this had uploaded a file into a folder they cannot
    // write, watched it turn into an accent-coloured row, and concluded there
    // was no way to undo it — the Withdraw that already existed was on the
    // file page and in the dialog, neither of which the row leads to.
    //
    // `undefined` for anyone else's request, which is what keeps the item off
    // the menu entirely; an owner's "no" is Decline, and it stays in the dialog.
    const withdraw = suggestions.mine(suggestedCr)
      ? () => {
          // The request may not be in the shared list yet (the broad fetch
          // trails a just-made suggestion). Naming the row's own file is then
          // both true and the least surprising thing to say.
          const carried = suggestions.filesOf(entry.relativePath, suggestedCr);
          confirm({
            kind: 'withdraw',
            crNumber: suggestedCr,
            files: carried.length > 0 ? carried : [entry.relativePath],
            returnFocusTo: () => rowRef.current,
            // The row leaves the tree with the request it stood for, so focus
            // goes to the folder that held it — as a delete's does.
            focusAfterRun: () => rowForPath(entry.relativePath.split('/').slice(0, -1).join('/')),
            run: async () => {
              try {
                await suggestions.withdraw(suggestedCr);
              } catch (err) {
                // Already applied, or declined meanwhile: the same surfacing
                // every other refused tree operation gets. The rows refresh
                // either way (see the controller), so what the user sees next
                // is the truth from the server rather than a stale row.
                console.error('Failed to withdraw suggestion:', err);
                const msg = err instanceof Error ? err.message : String(err);
                alert(`Couldn't withdraw ${entry.name}:\n${msg}`);
              }
            },
          });
        }
      : undefined;
    return (
      <>
        <button
          ref={rowRef}
          type="button"
          data-tree-path={entry.relativePath}
          className={cn(
            ROW_CLASS,
            'text-accent hover:bg-hover hover:text-accent-hover',
            'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink-muted',
          )}
          style={{ paddingLeft }}
          onClick={() => suggestions.open(entry.relativePath, suggestedCr)}
          onContextMenu={handleContextMenu}
          title="Proposed by you: opens the change request"
        >
          <CaretSlot show={false} />
          <FileName name={entry.name} />
          <span
            aria-hidden
            className="ml-auto h-1.5 w-1.5 flex-none rounded-full bg-accent"
          />
        </button>
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            entry={entry}
            isRoot={false}
            proposed
            deletable={false}
            onWithdraw={withdraw}
            onClose={() => setContextMenu(null)}
            returnFocusTo={rowRef}
          />
        )}
      </>
    );
  }

  const isActive = entry.relativePath === nav.activePath;

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        data-tree-path={entry.relativePath}
        aria-current={isActive}
        className={cn(
          ROW_CLASS,
          ROW_TONE(isActive),
          'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink-muted',
          isPending && 'cursor-progress',
        )}
        style={{ paddingLeft, opacity: dragging ? 0.5 : isPending ? 0.6 : 1 }}
        draggable={!renaming && !isPending && !dragRefusal}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onClick={() => { if (!renaming && !isPending) nav.open(entry.relativePath); }}
        onContextMenu={handleContextMenu}
        title={isPending ? 'Adding…' : undefined}
      >
        {/* The pending spinner is the one glyph that survives the icon cull,
            because it says something no other part of the row says. It takes
            the caret's slot so the name never shifts when it appears. */}
        {isPending ? (
          <span className="flex h-3.5 w-3.5 flex-none items-center justify-center">
            <Loader2 size={13} className="animate-spin text-ink-faint" />
          </span>
        ) : (
          <CaretSlot show={false} />
        )}
        {renaming ? (
          <RenameInput
            currentName={entry.name}
            isFile={true}
            onSubmit={renameTo}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <FileName name={entry.name} />
        )}
        {/* News about a file you are not looking at (proto:692). Amber, not
            the tab dot's accent: on a tab the dot marks the file you have
            open; here it marks one you do not. */}
        {openChangeRequests.paths.has(entry.relativePath) && (
          <span
            title="Open change request"
            className="ml-auto h-1.5 w-1.5 flex-none rounded-full bg-wait-dot"
          />
        )}
      </button>
      {downloadNotice}
      {moveNotice}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={entry}
          isRoot={false}
          onClose={() => setContextMenu(null)}
          onRename={() => setRenaming(true)}
          renameRefusal={platformRefusal}
          onDownload={handleDownload}
          extraItems={nav.menuItems?.(entry)}
          returnFocusTo={rowRef}
        />
      )}
    </>
  );
}

// ── Explorer Root ──

/**
 * Everything a tree of `FileTreeNode`s needs AROUND it, and nothing about
 * where it sits: the navigation (which row is current, where a click goes),
 * the suggestion rows' change-request dialog, the right-click menu's Manage
 * access sheet, and — for the one tree that has somewhere to pin into — a pin
 * controller. The Knowledge explorer and the Library's Skills tree both render
 * inside one of these, which is why their rows cannot drift: the rows are one
 * component and so are their surroundings.
 */
export function TreeChrome({
  nav,
  suggestionOnlyPaths,
  pinned,
  uploadTarget = KNOWLEDGE_UPLOAD_TARGET,
  children,
}: {
  nav: TreeNav;
  suggestionOnlyPaths: ReadonlyMap<string, number>;
  pinned?: PinnedController;
  /**
   * Which tree this is, for the upload banners — see `UploadTarget`. Two
   * trees on one page (the Library sidebar's `Skills/` and `Plugins/`) must
   * name themselves differently, or one drop's notice appears in both.
   */
  uploadTarget?: UploadTarget;
  children: ReactNode;
}) {
  const openChangeRequests = useOpenChangeRequests();
  const { workspaceId, kbDirName } = useWorkspace();
  // The move dialog's denied-destination warning reads this: the one move a
  // denied destination still takes is an admin's platform-file restore, and
  // for anyone else the refusal it predicts is the right prediction. Read
  // through the context so a tree drawn without an `AdminProvider` still
  // draws — see `FileTreeNode`.
  const isAdmin = useContext(AdminContext)?.isAdmin ?? false;
  /**
   * A clicked suggestion row opens the SHARED change-request dialog on the
   * request the path belongs to, AT that file — the row is a link to the
   * request's view of one file, and arriving at some other file (the
   * request's first) is arriving somewhere the user did not click.
   *
   * The open dialog lives in the URL (`?cr=12&file=Sales/brief.pdf`), not in
   * component state, so a reload — or a link pasted to a colleague — lands
   * back on the same file of the same request instead of on the bare tree.
   * Everything below DERIVES from the query: there is one source of truth for
   * what is open, and no effect to keep it in step with.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const openSuggestion = useMemo(() => {
    const number = Number(searchParams.get(CR_PARAM));
    const path = searchParams.get(CR_FILE_PARAM);
    if (!Number.isInteger(number) || number <= 0 || !path) return null;
    const cr = openChangeRequests.forPath(path).find((c) => c.number === number) ?? null;
    // Not (yet) a request this viewer has: the list may still be loading, so
    // nothing opens and the query stands — the dialog appears when it lands.
    if (!cr) return null;
    // The query is in the TREE's path space; the change request's files are
    // repo-relative. One conversion, here, at the hand-over.
    const prefix = kbDirName ? `${kbDirName}/` : null;
    return { cr, path, file: prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path };
  }, [searchParams, kbDirName, openChangeRequests]);
  const setOpenSuggestion = useCallback(
    (open: { number: number; path: string } | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (open) {
            next.set(CR_PARAM, String(open.number));
            next.set(CR_FILE_PARAM, open.path);
          } else {
            next.delete(CR_PARAM);
            next.delete(CR_FILE_PARAM);
          }
          return next;
        },
        // Opening a request is a place you can come back from; closing it
        // again should not leave two entries to press Back through.
        { replace: !open },
      );
    },
    [setSearchParams],
  );
  const suggestionsController = useMemo<SuggestionsController>(
    () => ({
      crFor: (path) => suggestionOnlyPaths.get(path) ?? null,
      open: (path, crNumber) => setOpenSuggestion({ number: crNumber, path }),
      mine: (crNumber) => openChangeRequests.mineNumbers.has(crNumber),
      filesOf: (path, crNumber) =>
        openChangeRequests.forPath(path).find((c) => c.number === crNumber)?.touchedNodePaths ?? [],
      withdraw: async (crNumber) => {
        try {
          await cancelPullRequest(crNumber);
        } finally {
          // On BOTH paths. A cancel that succeeded has removed the request,
          // and one that was refused (applied or declined meanwhile) means
          // the row was already describing something that is no longer open —
          // either way the next thing on screen should come from the server.
          window.dispatchEvent(new Event(PR_STALE_EVENT));
        }
      },
    }),
    [suggestionOnlyPaths, setOpenSuggestion, openChangeRequests],
  );
  // Right-click → Manage access opens this sheet for the chosen entry.
  const [accessTarget, setAccessTarget] = useState<FileTreeEntry | null>(null);
  // `Manage <folder> →` from a proposed file's sheet keeps that file's change
  // request: the inherited grant it retargets from was read on the request's
  // branch, so the folder's rules are edited there too — not on the viewed
  // branch, which the folder path alone would resolve to.
  const [inheritedProposal, setInheritedProposal] = useState<
    { number: number; branch: string | null } | undefined
  >(undefined);
  const openAccess = useCallback((entry: FileTreeEntry) => {
    setInheritedProposal(undefined);
    setAccessTarget(entry);
  }, []);
  // A proposed-only file does not exist on the branch being viewed, so its
  // access can only be edited where it lives: the change request's branch.
  // Everything else — including a file a request merely modifies, which is a
  // real row here — keeps the ambient workspace. The branch is null when the
  // request cannot be resolved; the dialog refuses rather than falling back
  // to a workspace the file is not on.
  const accessProposal = useMemo(() => {
    if (!accessTarget) return undefined;
    if (inheritedProposal) return inheritedProposal;
    const crNumber = suggestionOnlyPaths.get(accessTarget.relativePath);
    if (crNumber === undefined) return undefined;
    const cr = openChangeRequests
      .forPath(accessTarget.relativePath)
      .find((c) => c.number === crNumber);
    return { number: crNumber, branch: cr?.branch ?? null };
  }, [accessTarget, inheritedProposal, suggestionOnlyPaths, openChangeRequests]);

  // The one open delete/move confirmation for this tree, stamped with the
  // workspace it was asked in: its `run` closes over that workspace's
  // operations, so a switch while it is open drops it rather than letting
  // Confirm act on a branch the dialog never described.
  const [openConfirm, setOpenConfirm] = useState<
    { request: TreeConfirmRequest; workspaceId: string | null } | null
  >(null);
  const confirmRequest =
    openConfirm && openConfirm.workspaceId === workspaceId ? openConfirm.request : null;
  const askConfirm = useCallback(
    (request: TreeConfirmRequest) => setOpenConfirm({ request, workspaceId }),
    [workspaceId],
  );
  // Dropped outright, so switching back does not bring it back either.
  useEffect(() => {
    setOpenConfirm((open) => (open && open.workspaceId !== workspaceId ? null : open));
  }, [workspaceId]);
  // Whether the caller may write the move's destination: null until known.
  // The same three short-circuits as `useFileAccess` (and the upload's
  // suggestion routing): drafts and paths outside the KB are writable
  // without asking, and a failed lookup warns about nothing — the server
  // is the gate either way, and the dialog never waits on this.
  // Keyed by the request it answers, so a stale answer never reaches the next one.
  const [writableAnswer, setWritableAnswer] = useState<
    { request: TreeConfirmRequest; canWrite: boolean } | null
  >(null);
  const destinationWritable =
    writableAnswer && writableAnswer.request === confirmRequest ? writableAnswer.canWrite : null;
  const focusAfterConfirm = useRef<(() => HTMLElement | null) | null>(null);
  useEffect(() => {
    if (confirmRequest?.kind !== 'move' || !workspaceId || !kbDirName) return;
    if (!isProtectedBranch(decodeURIComponent(workspaceId))) return;
    const prefix = `${kbDirName}/`;
    if (!confirmRequest.targetDir.startsWith(prefix)) return;
    let cancelled = false;
    fetchFileAccess(workspaceId, confirmRequest.targetDir.slice(prefix.length), 'folder')
      .then((res) => { if (!cancelled) setWritableAnswer({ request: confirmRequest, canWrite: res.canWrite }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [confirmRequest, workspaceId, kbDirName]);
  // Who the move costs access and who it gains it for. The dialog opens at
  // once and fills this in: the answer describes the move, it does not gate
  // it, and Move is enabled the whole time. Keyed by the request it answers,
  // so a late answer never decorates the next move.
  const [accessAnswer, setAccessAnswer] = useState<
    { request: TreeConfirmRequest; change: MoveAccessChange } | null
  >(null);
  const moveRequest = confirmRequest?.kind === 'move' ? confirmRequest : null;
  // Both ends have to sit inside the KB clone for the access tree to govern
  // them; outside it there are no rules to compare, and the dialog says
  // nothing about access it cannot resolve. `kbDirName` alone is the KB root.
  const insideKb = (path: string) =>
    !!kbDirName && (path === kbDirName || path.startsWith(`${kbDirName}/`));
  const accessLookup =
    moveRequest && workspaceId && kbDirName
    && !moveRequest.sourceIsDirectory
    && moveRequest.sourcePath.startsWith(`${kbDirName}/`)
    && insideKb(moveRequest.targetDir)
      ? moveRequest
      : null;
  const moveAccessChange: MoveAccessChange = !accessLookup
    ? { status: 'unavailable' }
    : accessAnswer?.request === accessLookup
      ? accessAnswer.change
      : { status: 'loading' };
  useEffect(() => {
    if (!accessLookup || !workspaceId || !kbDirName) return;
    const prefix = `${kbDirName}/`;
    const controller = new AbortController();
    // Two seconds is the whole budget; past it the answer is no longer wanted
    // and the dialog falls back to saying it could not work the change out.
    const timer = setTimeout(() => controller.abort(), ACCESS_LOOKUP_TIMEOUT_MS);
    let cancelled = false;
    fetchProspectiveAccess(
      workspaceId,
      accessLookup.sourcePath.slice(prefix.length),
      accessLookup.targetDir === kbDirName ? '' : accessLookup.targetDir.slice(prefix.length),
      controller.signal,
    )
      .then((access) => {
        if (cancelled) return;
        setAccessAnswer({
          request: accessLookup,
          change: { status: 'ready', ...accessChangeOf(access) },
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // Running out of the two seconds is a designed outcome, not a fault:
        // the abort is ours, and the dialog already says what it means. Only
        // a genuine failure is worth a line in the console.
        if ((err as { name?: string } | null)?.name !== 'AbortError') {
          console.warn('[FileExplorer] prospective access:', err);
        }
        setAccessAnswer({ request: accessLookup, change: { status: 'failed' } });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [accessLookup, workspaceId, kbDirName]);
  // A folder delete asks which open change requests propose files in the
  // folder. It asks for EVERY knowledge-base folder: the shared list may still
  // be loading, or have failed, and its silence is not "no proposals". A
  // folder the list shows no proposals under opens the plain dialog at once
  // (its Delete is "Delete folder only") and switches to the three-way one
  // if the answer names requests. Keyed by the request it answers.
  const [proposalsAnswer, setProposalsAnswer] = useState<
    { request: TreeConfirmRequest; proposals: FolderProposals } | null
  >(null);
  const deleteFolder =
    confirmRequest?.kind === 'delete' && confirmRequest.entry.type === 'directory' && kbDirName
    && confirmRequest.entry.relativePath.startsWith(`${kbDirName}/`)
      ? confirmRequest
      : null;
  const folderHasProposals =
    deleteFolder !== null
    && [...openChangeRequests.paths].some((p) => p.startsWith(`${deleteFolder.entry.relativePath}/`));
  const answered = proposalsAnswer && proposalsAnswer.request === confirmRequest ? proposalsAnswer.proposals : null;
  const folderProposals: FolderProposals = folderHasProposals
    ? (answered ?? { status: 'loading' })
    // With no proposals in the list, only an answer that names requests
    // changes the dialog; a failed check has nothing to warn about.
    : answered?.status === 'ready' && answered.requests.length > 0
      ? answered
      : { status: 'none' };
  useEffect(() => {
    if (!deleteFolder || !kbDirName) return;
    let cancelled = false;
    listChangeRequestsUnderFolder(deleteFolder.entry.relativePath.slice(kbDirName.length + 1))
      .then((requests) => {
        if (!cancelled) setProposalsAnswer({ request: deleteFolder, proposals: { status: 'ready', requests } });
      })
      .catch((err) => {
        console.warn('[FileExplorer] change requests under folder:', err);
        if (!cancelled) setProposalsAnswer({ request: deleteFolder, proposals: { status: 'failed' } });
      });
    return () => { cancelled = true; };
  }, [deleteFolder, kbDirName]);
  const closeConfirm = (andRun: boolean, mode: DeleteMode = 'folder-only') => {
    if (!confirmRequest) return;
    focusAfterConfirm.current = andRun ? confirmRequest.focusAfterRun : confirmRequest.returnFocusTo;
    setOpenConfirm(null);
    if (!andRun) return;
    if (mode === 'with-proposals' && confirmRequest.kind === 'delete' && confirmRequest.runWithProposals) {
      void confirmRequest.runWithProposals();
    } else {
      void confirmRequest.run();
    }
  };
  // Focus goes back to the row once the dialog has unmounted — after the
  // Dialog's own restore, which would otherwise hand it to the (gone) menu.
  useEffect(() => {
    if (confirmRequest || !focusAfterConfirm.current) return;
    focusAfterConfirm.current()?.focus();
    focusAfterConfirm.current = null;
  }, [confirmRequest]);

  return (
    <>
      <TreeConfirmContext.Provider value={askConfirm}>
      <TreeNavContext.Provider value={nav}>
      <UploadTargetContext.Provider value={uploadTarget}>
      <PinnedContext.Provider value={pinned ?? NO_PINNING}>
      <ManageAccessContext.Provider value={openAccess}>
      <SuggestionsContext.Provider value={suggestionsController}>
        {children}
      </SuggestionsContext.Provider>
      </ManageAccessContext.Provider>
      </PinnedContext.Provider>
      </UploadTargetContext.Provider>
      </TreeNavContext.Provider>
      </TreeConfirmContext.Provider>
      {confirmRequest && (
        <TreeActionConfirmDialog
          request={confirmRequest}
          warnings={
            confirmRequest.kind === 'move'
              ? moveWarnings({ ...confirmRequest, kbDirName, canWrite: destinationWritable, isAdmin })
              : []
          }
          accessChange={moveAccessChange}
          proposals={folderProposals}
          onCancel={() => closeConfirm(false)}
          onConfirm={(mode) => closeConfirm(true, mode)}
        />
      )}
      {openSuggestion && (
        <ChangeRequestDialog
          // Remounted when the query names a different file, so the seeded
          // selection below is re-read instead of being a one-time landing.
          key={`${openSuggestion.cr.number}:${openSuggestion.file}`}
          cr={openSuggestion.cr}
          initialPath={openSuggestion.file}
          onClose={() => setOpenSuggestion(null)}
          onResolved={() => {
            setOpenSuggestion(null);
            window.dispatchEvent(new Event(PR_STALE_EVENT));
          }}
        />
      )}
      {accessTarget && (
        <ManageAccessDialog
          key={`${accessTarget.relativePath}@${accessProposal?.branch ?? ''}`}
          entry={accessTarget}
          proposal={accessProposal}
          // The dialog is keyed on the path, so pointing it at a parent remounts
          // it against that folder, on the same branch the grant was read on.
          onManageAncestor={(ancestor) => {
            setInheritedProposal(accessProposal);
            setAccessTarget(ancestor);
          }}
          onClose={() => {
            setInheritedProposal(undefined);
            setAccessTarget(null);
          }}
        />
      )}
    </>
  );
}

/** Shown when the read filter kept entries out and none are left on screen. */
export const NOTHING_SHARED_MESSAGE = 'Nothing here is shared with you yet. Ask an admin to grant you access.';
/** Shown when the knowledge base has nothing in it at all. */
export const KB_EMPTY_MESSAGE = 'This knowledge base is empty.';

/**
 * Why a tree has nothing in it, when it has nothing in it. Read is
 * default-deny, so an empty sidebar has two causes that look identical and
 * call for different next steps: the caller may read none of what exists
 * (ask an admin), or nothing exists yet (make something — said only to a
 * caller who may write at `rootPath`, the surface's root folder).
 *
 * Renders nothing while the tree loads and once a single entry is visible.
 * The Knowledge explorer and the Library's trees both render it, from the
 * same merged listing, so they give the same answer.
 */
export function EmptyTreeNotice({ rootPath }: { rootPath: string | null }) {
  const { kbDirName } = useWorkspace();
  const { tree, withheld } = useMergedWorkspaceTree();
  const empty = tree !== null && !treeHasVisibleEntries(tree, kbDirName);
  // Asked only when the message would carry the hint: a withheld tree never does.
  const canWrite = useCanWriteFolder(empty && withheld === 0 ? rootPath : null);
  if (!empty) return null;
  if (withheld > 0) {
    return (
      <div data-testid="tree-empty-notice" role="status" className="px-3 py-2 text-xs text-ink-muted">
        {NOTHING_SHARED_MESSAGE}
      </div>
    );
  }
  return (
    <div data-testid="tree-empty-notice" role="status" className="px-3 py-2 text-xs text-ink-muted">
      {KB_EMPTY_MESSAGE}
      {canWrite && (
        <>
          {' '}
          <span data-testid="tree-empty-create-hint">
            Use New file or New folder on the folder above, or drop files here.
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Whether the caller may write into a workspace-relative folder; false until
 * known, and on a failed lookup — it decides a hint, never a gate. The same
 * short-circuits as `useFileAccess`: a path outside the KB and a draft branch
 * are writable without asking.
 */
function useCanWriteFolder(workspacePath: string | null): boolean {
  const { workspaceId, kbDirName } = useWorkspace();
  const [answer, setAnswer] = useState<{ key: string; canWrite: boolean } | null>(null);
  const prefix = kbDirName ? `${kbDirName}/` : null;
  const key = workspacePath && workspaceId && prefix ? `${workspaceId}|${workspacePath}` : null;
  // The KB clone's own folder (a tree that predates the split) is the repo
  // root: inside the KB, and sent as-is — the server reads a bare kbDirName as ''.
  const isKbRoot = workspacePath !== null && workspacePath === kbDirName;
  const shortCircuit =
    key !== null &&
    ((!isKbRoot && !workspacePath!.startsWith(prefix!)) || !isProtectedBranch(decodeURIComponent(workspaceId!)));
  useEffect(() => {
    if (key === null || shortCircuit) return;
    let cancelled = false;
    fetchFileAccess(workspaceId!, isKbRoot ? workspacePath! : workspacePath!.slice(prefix!.length), 'folder')
      .then((res) => { if (!cancelled) setAnswer({ key, canWrite: res.canWrite }); })
      .catch(() => { if (!cancelled) setAnswer({ key, canWrite: false }); });
    return () => { cancelled = true; };
  }, [key, shortCircuit, isKbRoot, workspaceId, workspacePath, prefix]);
  if (key === null) return false;
  if (shortCircuit) return true;
  return answer?.key === key && answer.canWrite;
}

/**
 * The upload banners for THIS tree: the last upload's error, or its one
 * non-error notice (the upload is under way, or it landed on the suggestions
 * branch). Every tree that can upload renders a pair, because the state is
 * the workspace's and a drop into a tree with no banner would fail — or
 * succeed elsewhere — in silence. Each pair shows only the banners stamped
 * with its own `uploadTarget`, which is what keeps one drop from painting
 * the same notice in both of the Library sidebar's trees.
 *
 * The error says everything in the banner, on as many lines as it takes:
 * the file's name, the server's reason in full, and what to do next. It used
 * to be one `truncate`d line with the reason in a `title` — a tooltip nobody
 * on a touch device could open, over text that had already cut the reason off.
 */
export function UploadNotices() {
  const { uploadErrors, clearUploadError, uploadNotices, clearUploadNotice } = useWorkspace();
  const target = useUploadTarget();
  const error = uploadErrors.get(target) ?? null;
  const notice = uploadNotices.get(target) ?? null;
  return (
    <>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-1 px-2 py-1 text-xs text-danger bg-danger-soft border-b border-danger/30 shrink-0"
        >
          <div className="flex-1 min-w-0 space-y-0.5 whitespace-pre-wrap break-words">
            <div className="font-medium">Couldn't add {error.filename}</div>
            <div>{error.reason}</div>
            <div className="text-ink-muted">{uploadErrorNextStep(error.status)}</div>
          </div>
          <IconButton
            size={18}
            tone="danger"
            title="Dismiss"
            aria-label="Dismiss upload error"
            onClick={() => clearUploadError(target)}
          >
            <X size={12} />
          </IconButton>
        </div>
      )}
      {/* Either "this is happening" or "it LANDED, on the suggestions
          branch". Both are load-bearing: a suggestion-routed upload puts
          nothing in the tree where the user dropped the files, and silence
          there reads as a failed upload. */}
      {notice && (
        <div
          role="status"
          data-testid="upload-notice"
          className="flex items-start gap-1 px-2 py-1 text-xs text-ink bg-wait-soft border-b border-line shrink-0"
        >
          <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">{notice.message}</span>
          {/* Nothing to dismiss about an upload still running — it clears
              itself the moment it has a result to show instead. */}
          {notice.kind !== 'progress' && (
            <IconButton
              size={18}
              title="Dismiss"
              aria-label="Dismiss upload notice"
              onClick={() => clearUploadNotice(target)}
            >
              <X size={12} />
            </IconButton>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Walk down to the node that actually holds the KB content. The file tree roots
 * at the per-branch workspace dir and wraps the KB clone a level or two deep
 * (`<branch>/<kbDir>/{KnowledgeBase,Data,Agents,Pipelines,Skills,Tools,…}`), so
 * the split lives below the visible root. Returns the first node whose children
 * include one of those well-known root directories, or null when there's no
 * such split (legacy clones).
 */
// (`findKbRoot` lives in `../utils/fileTree` — shared with registry-
// contributed explorer items.)

export function FileExplorer() {
  const { openFilePath, dispatchUpload, kbDirName } = useWorkspace();
  const { openFile } = useFileNav();
  const [dragOver, setDragOver] = useState(false);
  // Download is a per-path permission (resolved server-side from the access
  // tree's `download:` verb), so there is no global gate here: the menu asks
  // about the entry it was opened on (`useDownloadVerdict`) and disables the
  // item with the reason. A 403 that still lands — the permission changed
  // while the menu was open — becomes the row's own inline notice.
  const { tree: mergedTree, suggestionOnlyPaths } = useMergedWorkspaceTree();
  // The pane workspace's own navigation: the open tab is the current row, and
  // a click opens the file on the checked-out branch.
  const nav = useMemo<TreeNav>(() => ({ activePath: openFilePath, open: openFile }), [openFilePath, openFile]);

  // Pinned folders — a personal, client-side shortcut list surfaced at the top
  // of the explorer. Stored as relativePaths in localStorage; toggled from the
  // right-click menu (Pin to top / Unpin).
  const [pinnedPaths, setPinnedPaths] = useState<string[]>(readPinnedPaths);
  const togglePin = useCallback((path: string) => {
    setPinnedPaths((prev) => {
      const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
      try {
        window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable — pins stay in memory for this session.
      }
      return next;
    });
  }, []);
  const pinnedController = useMemo<PinnedController>(
    () => ({ available: true, isPinned: (path) => pinnedPaths.includes(path), togglePin }),
    [pinnedPaths, togglePin],
  );
  // Resolve pinned paths to live tree entries, dropping any that no longer
  // exist on this branch (a folder pinned elsewhere may be absent here).
  const pinnedEntries = useMemo(
    () =>
      mergedTree
        ? pinnedPaths
            .map((p) => findEntryByPath(mergedTree, p))
            .filter((e): e is FileTreeEntry => e != null)
        : [],
    [mergedTree, pinnedPaths],
  );

  // Registry-contributed rows for the Pinned section (rendered below the
  // pinned folders). The enterprise knowledge system contributes its
  // "Graph view" entry — the interactive ontology graph — this way; the core
  // ships none of its own.
  const { explorerItems } = useAppRegistry();

  // KB content splits into separate top-level folders; surface them as labelled
  // sections rather than a single flat root. The Knowledge section hoists
  // `KnowledgeBase/`'s children and folds in any other top-level content folder
  // (e.g. a stray `Legal/`); loose top-level files (access.md, roles.yaml) sit
  // below a divider. Clones that predate the split (none of the well-known root
  // dirs) fall back to the flat tree.
  //
  // `Plugins/` is NOT among them. It is the Skills & Tools app's storage — one
  // folder per plugin holding its skills and its tools — and that app presents
  // it as plugins, skills and tools rather than as files. Listing it here too
  // offered a second, worse way in: raw markdown editing of a SKILL.md with
  // none of the surrounding affordances, on a folder whose access is managed
  // from the plugin page. Deep links into a plugin file still resolve; the
  // folder just is not a browsing destination in Knowledge.
  //
  // `Skills/` neither: the Skills & Tools sidebar renders that root as its
  // own tree (`SkillsTree`), with these same rows, and a skill file opens on
  // its skill page there.
  //
  // `Data/`, `Agents/` and `Pipelines/` are rendered when PRESENT but never
  // created by core (see `CORE_REQUIRED_DIRS`) — a deployment that owns the
  // agentic execution layer seeds them, and this reads whatever is there.
  const sections = useMemo(() => {
    // Descend past the workspace / KB-clone wrapper levels to the node that
    // actually holds the well-known root dirs, then split that level.
    const kids = findKbRoot(mergedTree)?.children;
    if (!kids) return null;
    const findDir = (name: string) =>
      kids.find((c) => c.type === 'directory' && c.name === name);
    const knowledgeBase = findDir(KNOWLEDGE_BASE_DIR);
    const data = findDir(DATA_DIR);
    const agents = findDir(AGENTS_DIR);
    const pipelines = findDir(PIPELINES_DIR);
    // Plugins counts toward "is this a split layout?" even though it is never
    // rendered: its presence proves the split just as well as the others, and
    // without it a KB whose only root is Plugins would fail this check, fall
    // back to the flat tree, and show the folder that way instead.
    const plugins = findDir(PLUGINS_DIR);
    // Same for Skills: the Library surface renders it, not this explorer.
    const skills = findDir(SKILLS_DIR);
    if (!knowledgeBase && !data && !agents && !pipelines && !plugins && !skills) return null;
    // Any other top-level content folder (e.g. a stray `Legal/`) folds into Knowledge.
    const otherDirs = kids.filter(
      (c) => c.type === 'directory' && !KB_ROOT_DIRS.has(c.name),
    );
    // Present Knowledge, Data, Agents and Pipelines as named roots. Knowledge is
    // synthetic so it can relabel `KnowledgeBase` and absorb the stray
    // content folders; it reuses KnowledgeBase's own path so file ops on the
    // row still resolve.
    const knowledge: FileTreeEntry | null = knowledgeBase
      ? {
          ...knowledgeBase,
          name: 'Knowledge',
          children: [...(knowledgeBase.children ?? []), ...otherDirs],
        }
      : otherDirs.length > 0
        ? { name: 'Knowledge', relativePath: otherDirs[0].relativePath, type: 'directory', children: otherDirs }
        : null;
    const dataRoot: FileTreeEntry | null = data ? { ...data, name: DATA_DIR } : null;
    const agentsRoot: FileTreeEntry | null = agents ? { ...agents, name: AGENTS_DIR } : null;
    const pipelinesRoot: FileTreeEntry | null = pipelines
      ? { ...pipelines, name: PIPELINES_DIR }
      : null;
    return {
      knowledge,
      data: dataRoot,
      agents: agentsRoot,
      pipelines: pipelinesRoot,
      looseFiles: kids.filter((c) => c.type === 'file'),
    };
  }, [mergedTree]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      // Only handle external file/folder drops at the root level.
      if (e.dataTransfer.getData(DRAG_MIME)) return;
      const entries = e.dataTransfer.items ? snapshotEntries(e.dataTransfer.items) : [];
      if (entries.length > 0) {
        // Outside the `TreeChrome` below, so this one names the tree itself.
        dispatchUpload({ kind: 'items', entries }, '', KNOWLEDGE_UPLOAD_TARGET);
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) dispatchUpload({ kind: 'files', files }, '', KNOWLEDGE_UPLOAD_TARGET);
    },
    [dispatchUpload],
  );

  return (
    <TreeChrome nav={nav} suggestionOnlyPaths={suggestionOnlyPaths} pinned={pinnedController}>
    {/* No background, no border, no width: this is the CONTENTS of the app's
        one sidebar, and `SidebarFrame` is the sidebar. It used to be
        `bg-white` against the Library's `bg-sidebar`, which is how two navs in
        one app ended up looking like two apps. */}
    <div
      // The drop target. It was findable as `role="complementary"` while this
      // was the `<aside>`; the aside is `SidebarFrame`'s now, and a second
      // complementary nested inside the first would be a lie about the page's
      // landmarks.
      data-testid="file-explorer-root"
      className={`h-full w-full min-w-0 flex flex-col overflow-hidden ${
        dragOver ? 'ring-2 ring-inset ring-accent/40' : ''
      }`}
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
    >
      <UploadNotices />
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* "Company Context", not "Pinned". The mechanism is pinning; the
            SECTION is the handful of places this company actually works out
            of. A label naming the mechanism tells you how the rows got there,
            which nobody is wondering — the useful heading says what they are.

            Same padding as the Library's `SectionLabel`, because it is the
            same thing: a heading over a list of places. */}
        <div className="px-2.5 pb-1.5 text-label uppercase text-ink-faint">Company Context</div>
        {pinnedEntries.map((e) => (
          <FileTreeNode key={`pin:${e.relativePath}`} entry={e} depth={0} collapseChildren />
        ))}
        {explorerItems.map(({ id, Component }) => (
          <Component key={id} tree={mergedTree} />
        ))}
        <div className="mx-3 my-2 border-t border-line" />
        {!mergedTree ? (
          <div className="px-3 py-4 text-xs text-ink-muted">Loading...</div>
        ) : sections ? (
          <>
            {sections.knowledge && (
              <FileTreeNode entry={sections.knowledge} depth={0} collapseChildren />
            )}
            {sections.data && (
              <FileTreeNode entry={sections.data} depth={0} collapseChildren />
            )}
            {sections.agents && (
              <FileTreeNode entry={sections.agents} depth={0} collapseChildren />
            )}
            {sections.pipelines && (
              <FileTreeNode entry={sections.pipelines} depth={0} collapseChildren />
            )}
            {sections.looseFiles.length > 0 && (
              <>
                <div className="mx-3 my-2 border-t border-line" />
                {sections.looseFiles.map((c) => (
                  <FileTreeNode key={c.relativePath} entry={c} depth={0} />
                ))}
              </>
            )}
          </>
        ) : (
          <FileTreeNode entry={mergedTree} depth={0} />
        )}
        {/* Under the (empty) roots, so the hint's "folder above" is on
            screen: Knowledge's own folder is where a first page goes. A tree
            that predates the split starts at the KB clone's folder when it
            wraps one, as `treeHasVisibleEntries` reads it. */}
        <EmptyTreeNotice
          rootPath={
            sections
              ? sections.knowledge?.relativePath ?? null
              : (mergedTree?.children?.find((c) => c.type === 'directory' && c.name === kbDirName) ?? mergedTree)
                  ?.relativePath ?? null
          }
        />
      </div>
    </div>
    </TreeChrome>
  );
}

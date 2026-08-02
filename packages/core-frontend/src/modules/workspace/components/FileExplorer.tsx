import { useState, useCallback, useEffect, useMemo, useRef, createContext, useContext } from 'react';
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
} from 'lucide-react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import {
  validateFilename,
  KNOWLEDGE_BASE_DIR,
  GROUPS_DIR,
  LEGACY_SKILLS_DIR,
  LEGACY_TOOLS_DIR,
  DATA_DIR,
  AGENTS_DIR,
  PIPELINES_DIR,
} from '@bevel-software/platform-shared';
import { useWorkspace } from '../state/workspace.context';
import { mergePendingIntoTree, findKbRoot, KB_ROOT_DIRS } from '../utils/fileTree';
import { snapshotEntries } from '../utils/readDroppedEntries';
import { useFileNav } from '../routing/kb-routes';
import { authFetch } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { MenuPanel, MenuItem, TextField, IconButton } from '../../../shared/components';
import { useDismissableMenu } from '../../../shared/components';
import { useOpenChangeRequests } from '../hooks/useOpenChangeRequests';
import { PullRequestsForMe } from '../../git/components/PullRequestsForMe';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { useAppRegistry } from '../../../core/registry';

/**
 * The tree row — the prototype's `.trow` (proto:684-693), and token for token
 * the same string as the Library sidebar's `rowClass`
 * (`GroupsSidebar.tsx:68-72`). Two sidebars in one app should not read as two
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
 * The caret's slot — 13px wide, and rendered EMPTY for a file and for a
 * childless folder. It is what keeps a file's name in line with its siblings'
 * once the icons are gone: the indent is the tree, so it has to survive them
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
  isPinned: (path: string) => boolean;
  togglePin: (path: string) => void;
}

// Default no-op so a ContextMenu rendered outside the provider (e.g. in a unit
// test) never throws — the real controller is supplied by FileExplorer.
const PinnedContext = createContext<PinnedController>({
  isPinned: () => false,
  togglePin: () => {},
});
const usePinned = () => useContext(PinnedContext);

// Lets the deep right-click menu open the Manage access sheet without prop
// drilling through the recursive tree. FileExplorer supplies the opener and
// renders the dialog.
const ManageAccessContext = createContext<(entry: FileTreeEntry) => void>(() => {});
const useManageAccess = () => useContext(ManageAccessContext);

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
  onDownload,
  returnFocusTo,
}: {
  x: number;
  y: number;
  entry: FileTreeEntry;
  isRoot: boolean;
  onClose: () => void;
  onCreateFile?: () => void;
  onCreateFolder?: () => void;
  onRename?: () => void;
  onDownload?: () => void;
  /** The row this menu was opened from — Escape hands focus back to it. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}) {
  const { deleteEntry, unzipHere } = useWorkspace();
  const { isPinned, togglePin } = usePinned();
  const openManageAccess = useManageAccess();
  const pinned = isPinned(entry.relativePath);
  const [unzipping, setUnzipping] = useState(false);
  // Outside-click, Escape, and focus return — none of which `MenuPanel`
  // provides (it is presentation only, by design).
  const ref = useDismissableMenu<HTMLDivElement>({ open: true, onClose, returnFocusTo });

  // Only files whose name ends with `.zip` (case-insensitive) get the
  // extraction affordance — matches the OS shell-extension behavior users
  // already know from Windows Explorer / macOS Finder.
  const isZip = entry.type === 'file' && /\.zip$/i.test(entry.name);

  // The one prototype context-menu item the platform has never had
  // (proto:3948). The page-level `⋯ → Copy path` does not cover it: that only
  // ever reaches the file you have open, never a folder row or an unopened
  // one. A clipboard write can be refused outright (a non-secure origin), and
  // a silent no-op is the worst possible answer to "copy this" — so a refusal
  // surfaces the same way every other failure in this tree does.
  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(entry.relativePath);
      onClose();
    } catch (err) {
      console.error('Failed to copy path:', err);
      onClose();
      alert(`Couldn't copy the path to the clipboard.\n\n${entry.relativePath}`);
    }
  };

  const handleDelete = async () => {
    onClose();
    try {
      await deleteEntry(entry.relativePath);
    } catch (err) {
      console.error('Failed to delete entry:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to delete ${entry.relativePath}:\n${msg}`);
    }
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
    // the fixed-to-the-pointer wrapper is ours and the panel inside is the
    // shared one.
    <div
      ref={ref}
      className="fixed z-50"
      style={{ left: x, top: y }}
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
      {isZip && (
        <MenuItem role="menuitem" onClick={handleUnzip} disabled={unzipping}>
          <span className="flex items-center gap-2">
            <PackageOpen size={14} />
            {unzipping ? 'Unzipping…' : 'Unzip here'}
          </span>
        </MenuItem>
      )}
      {onDownload && (
        <MenuItem role="menuitem" onClick={() => { onDownload(); onClose(); }}>
          <span className="flex items-center gap-2">
            <Download size={14} />
            {entry.type === 'directory' ? 'Download as zip' : 'Download'}
          </span>
        </MenuItem>
      )}
      <MenuItem role="menuitem" onClick={handleCopyPath}>
        <span className="flex items-center gap-2"><Link2 size={14} />Copy path</span>
      </MenuItem>
      {!isRoot && (
        <>
          <div className="my-1 border-t border-line" />
          <MenuItem role="menuitem" onClick={() => { openManageAccess(entry); onClose(); }}>
            <span className="flex items-center gap-2"><Users size={14} />Manage access</span>
          </MenuItem>
        </>
      )}
      {entry.type === 'directory' && !isRoot && (
        <MenuItem role="menuitem" onClick={() => { togglePin(entry.relativePath); onClose(); }}>
          <span className="flex items-center gap-2">
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? 'Unpin' : 'Pin to top'}
          </span>
        </MenuItem>
      )}
      {!isRoot && onRename && (
        <MenuItem role="menuitem" onClick={() => { onRename(); onClose(); }}>
          <span className="flex items-center gap-2"><Pencil size={14} />Rename</span>
        </MenuItem>
      )}
      {!isRoot && (
        // Danger tone comes from the primitive, not from a hand-written red.
        <MenuItem role="menuitem" tone="danger" onClick={handleDelete}>
          <span className="flex items-center gap-2"><Trash2 size={14} />Delete</span>
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

function RenameInput({
  currentName,
  isFile,
  onSubmit,
  onCancel,
}: {
  currentName: string;
  isFile: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(currentName);
  const trimmed = value.trim();
  const error = trimmed.length === 0 ? null : validateFilename(trimmed);
  const valid = trimmed.length > 0 && error === null;

  const submit = () => {
    if (valid && trimmed !== currentName) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <div className="w-full">
      <TextField
        autoFocus
        className={cn('bg-sunken px-2 py-0.5 text-detail', error && 'border-danger')}
        value={value}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={submit}
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
      {error && <div className="mt-0.5 px-1 text-meta text-danger">{error}</div>}
    </div>
  );
}

// ── Tree Node ──

const DRAG_MIME = 'application/x-workspace-path';

function FileTreeNode({
  entry,
  depth,
  initiallyExpanded,
  collapseChildren,
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
}) {
  const { openFilePath, createFile, createDirectory, dispatchUpload, isUploading, moveEntry, workspaceId, pendingUploads } = useWorkspace();
  const { openFile } = useFileNav();
  // One shared fetch behind this — see `OpenChangeRequestsProvider`.
  const openChangeRequests = useOpenChangeRequests();

  const handleDownload = useCallback(async () => {
    if (!workspaceId) return;
    // Files hit /file/raw; folders hit /folder/zip and arrive as <name>.zip.
    // Both endpoints share the same per-path `download:` access gate, the
    // same `?download=1` flag shape, and the same Content-Disposition
    // handling on the backend — branching here just picks the URL.
    // No preflight: a 403 surfaces in the alert below.
    const isFolder = entry.type === 'directory';
    const url = isFolder
      ? `/api/workspace/${workspaceId}/folder/zip?path=${encodeURIComponent(entry.relativePath)}&download=1`
      : `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(entry.relativePath)}&download=1`;
    const savedAs = isFolder ? `${entry.name}.zip` : entry.name;
    try {
      const res = await authFetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        alert(`Failed to download ${entry.name} (HTTP ${res.status})${body ? `: ${body}` : ''}`);
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = savedAs;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('Failed to download:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to download ${entry.name}:\n${msg}`);
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

  // Resetting `value` after dispatch lets users re-select the same file and
  // still get an `onChange` event the second time around.
  const handleRootFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) dispatchUpload({ kind: 'files', files }, '');
  }, [dispatchUpload]);

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
    dispatchUpload({ kind: 'paths', items }, '');
  }, [dispatchUpload]);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const paddingLeft = indentFor(depth);
  const isRoot = entry.relativePath === '.';
  const isPending = pendingUploads.has(entry.relativePath);
  // A folder with nothing in it doesn't get a caret, because there is nothing
  // to open (proto:3565).
  const hasChildren = (entry.children?.length ?? 0) > 0;
  // Escape inside the context menu hands focus back to the row it came from.
  const rowRef = useRef<HTMLButtonElement>(null);

  // Auto-expand a directory whenever the open file lives inside it (so
  // deep-link URLs reveal the file's row in the tree) or while files
  // dropped under it are still uploading (so the user can watch them
  // fill in).
  const isOpenFileAncestor = entry.type === 'directory' && !!openFilePath && (
    isRoot || openFilePath.startsWith(entry.relativePath + '/')
  );
  const autoExpanded = entry.type === 'directory' && (isPending || isOpenFileAncestor);

  // Fingerprint of what currently drives auto-expand. When it transitions
  // (different file opened, upload starts), the user's prior collapse intent
  // is stale — reset so deep-links / new uploads can re-reveal the folder.
  const autoTrigger = `${isPending ? 'P' : ''}|${isOpenFileAncestor ? openFilePath : ''}`;
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

  // ── Drag source (internal reorder) ──
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (isRoot) { e.preventDefault(); return; }
    e.dataTransfer.setData(DRAG_MIME, entry.relativePath);
    e.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  }, [entry.relativePath, isRoot]);

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
        const targetDir = entry.type === 'directory'
          ? (isRoot ? '' : entry.relativePath)
          : '';
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
        moveEntry(sourcePath, newPath);
        return;
      }

      // External file/folder drop. Snapshot the entries synchronously
      // before any await — the browser invalidates `DataTransfer` once the
      // handler returns, and the walker awaits inside.
      const dir = entry.type === 'directory' ? entry.relativePath : '';
      const targetDir = dir === '.' ? '' : dir;
      const entries = e.dataTransfer.items ? snapshotEntries(e.dataTransfer.items) : [];
      if (entries.length > 0) {
        dispatchUpload({ kind: 'items', entries }, targetDir);
        return;
      }
      // Fallback for older browsers / non-entry drops: use the flat FileList.
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      dispatchUpload({ kind: 'files', files }, targetDir);
    },
    [entry, isRoot, dispatchUpload, moveEntry],
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
          draggable={!isRoot && !renaming && !isPending}
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
            aria-expanded={isExpanded}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => { if (hasChildren) setUserIntent(!isExpanded); }}
          >
            <CaretSlot open={isExpanded} show={hasChildren} />
            {renaming ? (
              <RenameInput
                currentName={entry.name}
                isFile={false}
                onSubmit={async (newName) => {
                  const parentDir = entry.relativePath.substring(0, entry.relativePath.lastIndexOf('/'));
                  const newPath = parentDir ? `${parentDir}/${newName}` : newName;
                  // Close the input BEFORE the fallible move — see the create
                  // flow: on error the alert() blurs the still-mounted input,
                  // whose onBlur re-fires this onSubmit, looping the popup.
                  setRenaming(false);
                  try {
                    await moveEntry(entry.relativePath, newPath);
                  } catch (err) {
                    // Same surfacing as the create flow above — a silent failure
                    // reads as the rename being accepted and then reverting.
                    const msg = err instanceof Error ? err.message : String(err);
                    alert(`Failed to rename ${entry.name}:\n${msg}`);
                  }
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <span className="truncate">{entry.name}</span>
            )}
          </button>
          <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
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
          </div>
          {isRoot && (
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
          )}
        </div>
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
                      // Surface the refusal (e.g. a protected branch's write
                      // gate: "You don't have permission to write to …") —
                      // otherwise the input clears and nothing appears, which
                      // reads as the file silently vanishing.
                      const msg = err instanceof Error ? err.message : String(err);
                      alert(`Failed to create ${name}:\n${msg}`);
                    }
                  }}
                  onCancel={() => setCreating(null)}
                />
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
            onRename={() => setRenaming(true)}
            onDownload={handleDownload}
            returnFocusTo={rowRef}
          />
        )}
      </div>
    );
  }

  const isActive = entry.relativePath === openFilePath;

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        aria-current={isActive}
        className={cn(
          ROW_CLASS,
          ROW_TONE(isActive),
          'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink-muted',
          isPending && 'cursor-progress',
        )}
        style={{ paddingLeft, opacity: dragging ? 0.5 : isPending ? 0.6 : 1 }}
        draggable={!renaming && !isPending}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onClick={() => { if (!renaming && !isPending) openFile(entry.relativePath); }}
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
            onSubmit={async (newName) => {
              const parentDir = entry.relativePath.substring(0, entry.relativePath.lastIndexOf('/'));
              const newPath = parentDir ? `${parentDir}/${newName}` : newName;
              // Close the input BEFORE the fallible move — see the create
              // flow: on error the alert() blurs the still-mounted input,
              // whose onBlur re-fires this onSubmit, looping the popup.
              setRenaming(false);
              try {
                await moveEntry(entry.relativePath, newPath);
              } catch (err) {
                // Same surfacing as the create flow — a silent failure reads
                // as the rename being accepted and then reverting.
                const msg = err instanceof Error ? err.message : String(err);
                alert(`Failed to rename ${entry.name}:\n${msg}`);
              }
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="truncate">{entry.name}</span>
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
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={entry}
          isRoot={false}
          onClose={() => setContextMenu(null)}
          onRename={() => setRenaming(true)}
          onDownload={handleDownload}
          returnFocusTo={rowRef}
        />
      )}
    </>
  );
}

// ── Explorer Root ──

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
  const { fileTree, dispatchUpload, uploadError, clearUploadError, pendingUploads } = useWorkspace();
  const [dragOver, setDragOver] = useState(false);
  // Download is now a per-path permission (resolved server-side from the
  // access tree's `download:` verb), so there's no global preflight gate
  // here anymore. The menu items always render; if the user clicks on a
  // file they don't have download permission for, the backend returns 403
  // and `handleDownload` shows the error.
  // Optimistic overlay: every dropped/picked file shows up in the tree
  // within a frame, even before its commit echoes back from the server.
  const mergedTree = useMemo(
    () => (fileTree ? mergePendingIntoTree(fileTree, pendingUploads) : null),
    [fileTree, pendingUploads],
  );

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
    () => ({ isPinned: (path) => pinnedPaths.includes(path), togglePin }),
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

  // Right-click → Manage access opens this sheet for the chosen entry.
  const [accessTarget, setAccessTarget] = useState<FileTreeEntry | null>(null);

  // KB content splits Knowledge (`KnowledgeBase/`), Data (`Data/`), Agents
  // (`Agents/`), Pipelines (`Pipelines/`), Skills (`Skills/`) and Tools
  // (`Tools/`) into separate top-level folders; surface them as labelled sections
  // rather than a single flat root. The Knowledge section hoists `KnowledgeBase/`'s
  // children and folds in any other top-level content folder (e.g. a stray
  // `Legal/`); loose top-level files (access.md, roles.yaml) sit below a divider.
  // Clones that predate the split (none of the well-known root dirs) fall back
  // to the flat tree.
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
    const groups = findDir(GROUPS_DIR);
    // Pre-merge clones still have the split pair; both are rendered so a KB
    // that has not migrated does not lose its skills and tools from the tree.
    const skills = findDir(LEGACY_SKILLS_DIR);
    const tools = findDir(LEGACY_TOOLS_DIR);
    if (!knowledgeBase && !data && !agents && !pipelines && !groups && !skills && !tools)
      return null;
    // Any other top-level content folder (e.g. a stray `Legal/`) folds into Knowledge.
    const otherDirs = kids.filter(
      (c) => c.type === 'directory' && !KB_ROOT_DIRS.has(c.name),
    );
    // Present Knowledge, Data, Agents, Pipelines and Groups as named roots
    // (plus the legacy Skills/Tools pair while it still exists). Knowledge is synthetic so it can relabel `KnowledgeBase` and
    // absorb the stray content folders; it reuses KnowledgeBase's own path so
    // file ops on the row still resolve.
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
    const groupsRoot: FileTreeEntry | null = groups ? { ...groups, name: GROUPS_DIR } : null;
    const skillsRoot: FileTreeEntry | null = skills
      ? { ...skills, name: LEGACY_SKILLS_DIR }
      : null;
    const toolsRoot: FileTreeEntry | null = tools ? { ...tools, name: LEGACY_TOOLS_DIR } : null;
    return {
      knowledge,
      data: dataRoot,
      agents: agentsRoot,
      pipelines: pipelinesRoot,
      groups: groupsRoot,
      skills: skillsRoot,
      tools: toolsRoot,
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
        dispatchUpload({ kind: 'items', entries }, '');
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) dispatchUpload({ kind: 'files', files }, '');
    },
    [dispatchUpload],
  );

  return (
    <>
    <aside
      className={`h-full w-full min-w-0 flex flex-col bg-white overflow-hidden ${
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
      {uploadError && (
        <div
          role="alert"
          className="flex items-start gap-1 px-2 py-1 text-xs text-danger bg-danger-soft border-b border-danger/30 shrink-0"
        >
          <span className="flex-1 truncate" title={uploadError.reason}>
            Couldn't add {uploadError.filename}: {uploadError.reason}
          </span>
          <IconButton
            size={18}
            tone="danger"
            title="Dismiss"
            aria-label="Dismiss upload error"
            onClick={clearUploadError}
          >
            <X size={12} />
          </IconButton>
        </div>
      )}
      <PinnedContext.Provider value={pinnedController}>
      <ManageAccessContext.Provider value={setAccessTarget}>
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        {/* "Company Context", not "Pinned". The mechanism is pinning; the
            SECTION is the handful of places this company actually works out
            of. A label naming the mechanism tells you how the rows got there,
            which nobody is wondering — the useful heading says what they are. */}
        <div className="px-3 pt-2 pb-1 text-label uppercase text-ink-faint">Company Context</div>
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
            {sections.groups && (
              <FileTreeNode entry={sections.groups} depth={0} collapseChildren />
            )}
            {sections.skills && (
              <FileTreeNode entry={sections.skills} depth={0} collapseChildren />
            )}
            {sections.tools && (
              <FileTreeNode entry={sections.tools} depth={0} collapseChildren />
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
      </div>
      </ManageAccessContext.Provider>
      </PinnedContext.Provider>
      <PullRequestsForMe />
    </aside>
    {accessTarget && (
      <ManageAccessDialog
        key={accessTarget.relativePath}
        entry={accessTarget}
        onClose={() => setAccessTarget(null)}
      />
    )}
    </>
  );
}

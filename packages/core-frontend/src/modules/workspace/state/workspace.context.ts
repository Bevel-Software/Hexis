import { createContext, useContext } from 'react';
import type { FileTreeEntry } from '@bevel-software/shared';

export interface UploadError {
  filename: string;
  reason: string;
}

/**
 * One item the user has handed to the upload pipeline. Either a pre-resolved
 * file (file picker / single-file drag) or a `FileSystemEntry` snapshot
 * captured synchronously in the drop handler (folder drag — walked lazily so
 * uploads start before enumeration finishes).
 */
export type UploadInput =
  | { kind: 'files'; files: File[] }
  | { kind: 'items'; entries: FileSystemEntry[] }
  | { kind: 'paths'; items: { file: File; relativePath: string }[] };

/**
 * In-memory record of a file or directory the user has dropped/picked but
 * whose round-trip to the server hasn't landed yet. Rendered alongside the
 * server-sourced file tree so the dropped tree appears in the sidebar within
 * one frame of the drop, not after every commit has pushed.
 */
export interface PendingEntry {
  fullPath: string;
  type: 'file' | 'directory';
}

export interface OpenTab {
  path: string;
  /**
   * The user-facing value for this tab. Includes any in-flight edits that
   * haven't been saved yet — preserved across tab switches so typed bytes
   * survive a switch + return. `null` means the cache was invalidated by an
   * `fsRevision` bump (working tree mutated underneath this tab); activating
   * such a tab triggers a refetch.
   */
  content: string | null;
  /**
   * The bytes currently on disk. The renderer uses this as the baseline for
   * computing dirty state; differs from `content` while the user has unsaved
   * edits. `null` when content was never fetched or has been invalidated.
   */
  savedContent: string | null;
  isDirty: boolean;
  pendingFileContent: string | null;
}

export interface WorkspaceContextValue {
  workspaceId: string | null;
  /**
   * Directory name (relative to the workspace root) where the per-user KB
   * clone lives — comes from the backend's `KB_DIR_NAME` env, surfaced via
   * `WorkspaceInfo.kbDirName`. Null until the workspace has bootstrapped.
   * Renderers and chat cards use it to build correct KB-relative paths
   * without hardcoding the repo name.
   */
  kbDirName: string | null;
  fileTree: FileTreeEntry | null;

  /** All tabs currently open in the editor strip. */
  openTabs: OpenTab[];
  /** Active tab; null when no tabs are open. */
  activeTab: OpenTab | null;
  /** Filenames of any tabs in `openTabs` that have unsaved edits. */
  dirtyTabFilenames: string[];

  // Derived from `activeTab` for backward compatibility with existing readers.
  openFilePath: string | null;
  /** Active tab's current value (includes in-flight unsaved edits). */
  openFileContent: string | null;
  /** Active tab's on-disk bytes. Renderers use this to compute dirty state. */
  openFileSavedContent: string | null;
  hasUnsavedFileChanges: boolean;
  pendingFileContent: string | null;

  /** Internal bridge from file renderers to workspace navigation guards. */
  setHasUnsavedFileChanges?: (hasUnsaved: boolean) => void;
  /**
   * Cache the active tab's in-flight value as the user types. Called by the
   * renderer's `onValueChange` so that switching to a different tab and back
   * preserves typed-but-unsaved bytes.
   */
  setActiveTabContent: (value: string) => void;
  /**
   * Force-invalidate cached tab content and refetch the active tab. Used by
   * code paths that mutate the working tree externally (e.g. `git revert` from
   * the history panel) where the standard `saveFile`/`createFile`/etc. paths
   * don't fire.
   */
  bumpFsRevision: () => void;
  /**
   * Set the branch used as part of the localStorage key for tab persistence.
   * The hook's auto-write effect doesn't fire until this is set AND
   * `hydrateTabs` has run for the matching key.
   */
  setPersistenceBranch: (branch: string | null) => void;
  /**
   * Monotonic counter bumped on every working-tree mutation (create, delete, move,
   * upload, save). Consumers that depend on `git status` (e.g. the App-level refresh
   * effect) watch this to re-poll without coupling this hook to the git module.
   * Also used internally to invalidate cached tab content.
   */
  fsRevision: number;
  /**
   * Most recent upload error, surfaced inline in the file explorer for both
   * the toolbar button and drag-drop. Cleared on the next successful dispatch
   * or via `clearUploadError`.
   */
  uploadError: UploadError | null;
  /** True while a `dispatchUpload` call is in flight; gates the toolbar button. */
  isUploading: boolean;
  /**
   * Progress for the in-flight upload (folder drops in particular).
   * `total` starts as `null` while the streaming walker is still discovering
   * files and becomes a concrete number once the walk completes. `uploaded`
   * ticks up per successful file. Null when nothing is uploading.
   */
  uploadProgress: { uploaded: number; total: number | null } | null;
  /**
   * Files and directories the user has dropped or picked but whose
   * server-side commits haven't echoed back yet. The FileExplorer overlays
   * these onto the server tree so the dropped structure appears immediately.
   * Keyed by full workspace-relative path.
   */
  pendingUploads: Map<string, PendingEntry>;
  refreshFileTree: () => Promise<FileTreeEntry | null>;

  /**
   * Open a file in a new tab, or activate an existing tab for it. Never
   * prompts on dirty state — opening more tabs never discards work. Returns
   * `false` if the workspace isn't ready yet or the call was superseded by a
   * newer addTab (older read whose response would otherwise steal focus from
   * the newer open). Throws on read failure so callers can surface
   * "file-missing" / "file-load-failed" UI.
   */
  addTab: (relativePath: string) => Promise<boolean>;
  /**
   * Close a tab. Prompts via `window.confirm` if the tab has unsaved edits;
   * pass `{ skipConfirm: true }` from bulk-close paths that have already
   * collected one consolidated confirm. If the closed tab was active,
   * activates the tab to its left (or right) and returns its path so the
   * caller can update the URL. Returns `{ closed: false }` when the user
   * cancelled the dirty-confirm.
   */
  closeTab: (
    tab: OpenTab,
    options?: { skipConfirm?: boolean },
  ) => Promise<{ closed: boolean; newActivePath: string | null }>;
  /** Activate a tab without prompting. Triggers a refetch if the tab's cache was invalidated. */
  activateTab: (tab: OpenTab) => void;
  /** Reorder a tab by moving it to a new index in the strip. */
  reorderTab: (tab: OpenTab, toIndex: number) => void;
  /**
   * Close every tab without prompting. Used by `deleteWorkspace` and similar
   * destructive paths where the caller has already confirmed.
   */
  closeAllTabs: () => void;
  /**
   * Bulk-restore a tab list. Fetches every path in parallel; silently drops
   * paths that 404 (file no longer on this branch) AND paths that 403 (read
   * access denied — the tab auto-closes rather than lingering unreadable).
   * Sets state once and activates `activePath` (or the last surviving path if
   * `activePath` was dropped, or null if everything was dropped). Returns
   * which paths survived, which were dropped, and which were denied — callers
   * surface "file not found" / "no access" for a deeplinked path that didn't
   * make it.
   */
  hydrateTabs: (
    paths: string[],
    activePath: string | null,
  ) => Promise<{ surviving: string[]; dropped: string[]; denied: string[] }>;

  createFile: (relativePath: string, content?: string) => Promise<void>;
  createDirectory: (relativePath: string) => Promise<void>;
  /**
   * Extract a `.zip` file already in the workspace. Defaults to "unzip here":
   * the archive's parent directory becomes the destination. Refreshes the
   * file tree and bumps `fsRevision` on success. Resolves with the count of
   * extracted entries and the list of entries the backend skipped (macOS
   * noise, invalid names, zip-slip attempts) so the caller can decide
   * whether to surface a banner.
   */
  unzipHere: (zipRelativePath: string) => Promise<{
    extracted: number;
    skipped: { path: string; reason: string }[];
    destination: string;
  }>;
  /** Low-level primitive — uploads files sequentially to the given target. */
  uploadFiles: (files: File[], targetDirectory: string) => Promise<void>;
  /**
   * UI-facing entry point for uploads from drag-drop and file/folder pickers.
   * Captures errors into `uploadError`, toggles `isUploading`, drives
   * `pendingUploads` for optimistic rendering, and (for `kind: 'items'`)
   * lazily walks dropped FileSystemEntries so uploads start before
   * enumeration finishes. Preserves empty subdirectories from folder drops
   * by creating them server-side after the file upload pass.
   */
  dispatchUpload: (input: UploadInput, targetDirectory: string) => Promise<void>;
  clearUploadError: () => void;
  deleteEntry: (relativePath: string) => Promise<void>;
  moveEntry: (oldPath: string, newPath: string) => Promise<void>;
  saveFile: (relativePath: string, content: string) => Promise<void>;
  /**
   * Re-read the matching tab's bytes from the server and replace the tab's
   * `content` + `savedContent` with them, clearing dirty + any pending agent
   * preview. Used when taking ownership of a file (clicking Edit) so the
   * user always starts from the canonical on-disk state — even if a
   * teammate's save echo via SSE hasn't landed yet. Silently no-ops if the
   * tab isn't open or the workspace isn't ready.
   */
  reloadTabFromDisk: (relativePath: string) => Promise<void>;
  /**
   * Called by the chat hook when the agent has written a new version of the
   * currently-active file. Routes to `activeTab.pendingFileContent`. The chat
   * hook captures the active path before its readFile and re-checks it after,
   * so this stays single-arg for v1 — multi-tab agent edits aren't a feature
   * yet.
   */
  setPendingContent: (content: string) => void;
  /** Accept the active tab's pending agent changes — becomes the new accepted content */
  acceptPendingContent: () => Promise<void>;
  /** Reject the active tab's pending agent changes — reverts the file on disk to the current accepted content */
  rejectPendingContent: () => Promise<void>;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceContext.Provider');
  return ctx;
}

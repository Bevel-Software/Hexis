import { useState, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { isProtectedBranch, type FileTreeEntry } from '@bevel-software/platform-shared';
import { useEventBus, canonicalizeWorkspaceId } from '../../workflow/state/event-bus.context';
import { AuthContext } from '../../auth/state/auth.context';
import { fetchFileAccess } from '../../access/api';
import {
  ensureKnowledgeSuggestionWorkspace,
  ensureKnowledgeChangeRequest,
  type KnowledgeSuggestionTarget,
} from '../../change-requests/services/propose.api';
import { PR_STALE_EVENT } from '../../../core/events';
import type {
  OpenTab,
  PendingEntry,
  UploadError,
  UploadInput,
  WorkspaceContextValue,
} from '../state/workspace.context';
import {
  getOrCreateWorkspace,
  listFiles,
  readFile,
  writeFile,
  createDirectory as createDirectoryApi,
  uploadFile,
  flushBatch,
  deleteFile as deleteFileApi,
  moveEntry as moveEntryApi,
  deleteWorkspace as deleteWorkspaceApi,
  unzipFile as unzipFileApi,
  WorkspaceApiError,
} from '../services/workspace.api';
import { contentChanged } from '../utils/diff';
import { isUploadNoise, walkEntries, type DroppedItem } from '../utils/readDroppedEntries';
import { tabsKey, type PersistedTabState } from '../utils/tab-persistence';

const PERSIST_DEBOUNCE_MS = 200;
// Bounded concurrency cap for upload requests. The server serializes git
// commits per workspace anyway, but network bytes can pipeline — 4 strikes a
// balance: responsive without monopolizing the browser's HTTP/1.1 connection
// budget or stressing the lock service.
const UPLOAD_CONCURRENCY = 4;
const UNSAVED_TAB_WARNING = (filename: string) =>
  `You have unsaved changes in ${filename}. Close anyway?`;
const UNSAVED_TABS_BULK_WARNING = (filenames: string[]) =>
  `You have unsaved changes in:\n  - ${filenames.join('\n  - ')}\nClose anyway?`;

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Return a copy of the tree with the entry at `targetPath` (and any
 * descendants beneath it) removed. Used by `deleteEntry`'s optimistic
 * removal: the folder vanishes from the explorer immediately while the
 * server churns through N per-file commits + push.
 *
 * Tree paths are globally unique, so the recursion finds at most one
 * match — but always-recurse keeps the helper trivially correct and
 * the trees here are small (hundreds of entries, not millions).
 */
function pruneTreeAt(
  tree: FileTreeEntry | null,
  targetPath: string,
): FileTreeEntry | null {
  if (!tree) return null;
  if (!tree.children) return tree;
  return {
    ...tree,
    children: tree.children
      .filter((c) => c.relativePath !== targetPath)
      .map((c) => pruneTreeAt(c, targetPath) as FileTreeEntry),
  };
}

// Flatten a FileTreeEntry into the set of paths it covers. Used to reconcile
// the optimistic pending-upload overlay against the freshly-fetched server
// tree after a folder drop — entries whose paths now exist on the server are
// dropped from the overlay (the real entry takes over rendering).
function collectPaths(root: FileTreeEntry): Set<string> {
  const out = new Set<string>();
  const visit = (node: FileTreeEntry) => {
    if (node.relativePath && node.relativePath !== '.') {
      out.add(node.relativePath);
    }
    if (node.children) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return out;
}

interface UseWorkspaceStateReturn extends WorkspaceContextValue {
  setPersistenceBranch: (branch: string | null) => void;
  deleteWorkspace: () => Promise<void>;
}

export function useWorkspaceState(): UseWorkspaceStateReturn {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [kbDirName, setKbDirName] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<FileTreeEntry | null>(null);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<UploadError | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  // Who is signed in — the suggestion-routed upload needs an author for the
  // branch name and the change request. Read nullable (not `useAuth`, which
  // throws) so the hook keeps working in harnesses with no auth provider;
  // no user simply means no suggestion routing.
  const authUser = useContext(AuthContext)?.user ?? null;
  const [fsRevision, setFsRevision] = useState(0);
  const [persistenceBranch, setPersistenceBranchState] = useState<string | null>(null);

  const bumpFs = useCallback(() => setFsRevision((n) => n + 1), []);

  // Monotonic token so a slow `addTab` whose response arrives after a newer add
  // doesn't clobber the newer state.
  const addRequestIdRef = useRef(0);
  // Tracks the (workspaceId, persistenceBranch) key we've successfully hydrated
  // for. Auto-persist effect won't write until hydrate has run for the current
  // key — avoids overwriting localStorage with `[]` before the restore lands.
  const hydratedKeyRef = useRef<string | null>(null);
  // Refs for stale-closure-safe reads inside callbacks.
  const openTabsRef = useRef<OpenTab[]>(openTabs);
  const activeTabPathRef = useRef<string | null>(activeTabPath);
  const fileTreeRef = useRef<FileTreeEntry | null>(fileTree);
  /**
   * Paths the user has optimistically removed but the server is still
   * processing. Mid-delete `file-changed` events (one per per-file commit)
   * trigger `refreshFileTree`, which fetches the partial server state —
   * the folder is still mostly there until the last file lands. Without
   * this reconciliation, the explorer would show the folder vanish, then
   * reappear with N-k files, then drain slowly, then vanish again. We
   * prune any in-flight paths out of every refresh response so the
   * optimistic state stays stable until the delete finishes.
   */
  const pendingDeletePathsRef = useRef<Set<string>>(new Set());
  // persistenceBranch as a ref too, so hydrateTabs reads the latest value
  // even when setPersistenceBranch was called in the same render.
  const persistenceBranchRef = useRef<string | null>(persistenceBranch);
  useEffect(() => { openTabsRef.current = openTabs; }, [openTabs]);
  useEffect(() => { activeTabPathRef.current = activeTabPath; }, [activeTabPath]);
  useEffect(() => { fileTreeRef.current = fileTree; }, [fileTree]);
  useEffect(() => { persistenceBranchRef.current = persistenceBranch; }, [persistenceBranch]);

  const setPersistenceBranch = useCallback((branch: string | null) => {
    persistenceBranchRef.current = branch;
    setPersistenceBranchState(branch);
  }, []);

  // Bootstrap workspace, branch-aware (PLAN §3). One effect that depends
  // on `persistenceBranch` handles both the initial mount and every
  // subsequent branch switch — using two effects (default-branch mount +
  // branch-rebootstrap) races on first load when the URL carries a
  // non-default branch: both effects fire in parallel, and whichever
  // resolves last clobbers the other's workspaceId/fileTree, sometimes
  // landing the user on `target-company-state` for a beat before
  // snapping to the URL's branch.
  //
  // The `cancelled` flag drops the previous bootstrap's result when
  // `persistenceBranch` changes mid-flight, so a fast switch never
  // overwrites the newer branch's state with an older response.
  useEffect(() => {
    const branch = persistenceBranch ?? undefined;
    let cancelled = false;
    (async () => {
      try {
        const { workspace, fileTree: tree } = await getOrCreateWorkspace(branch);
        if (cancelled) return;
        setWorkspaceId(workspace.id);
        setKbDirName(workspace.kbDirName);
        setFileTree(tree);
      } catch (err) {
        if (!cancelled) console.error('Failed to bootstrap workspace:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [persistenceBranch]);

  const refreshFileTree = useCallback(async () => {
    if (!workspaceId) return null;
    try {
      let tree = await listFiles(workspaceId);
      // Reconcile with in-flight optimistic deletes — see the ref's
      // JSDoc for the disappear/reappear/disappear bug this avoids.
      for (const pending of pendingDeletePathsRef.current) {
        const pruned = pruneTreeAt(tree, pending);
        if (pruned) tree = pruned;
      }
      setFileTree(tree);
      return tree;
    } catch (err) {
      console.error('Failed to refresh file tree:', err);
      return null;
    }
  }, [workspaceId]);

  // ── Tab CRUD ──────────────────────────────────────────────────────────────

  /**
   * Remove a tab because its file is gone or unreadable — a 404 (file vanished)
   * or a 403 (read access denied/revoked). A tab the user isn't allowed to read
   * AUTO-CLOSES rather than lingering in a no-access state, mirroring the tree,
   * which hides unreadable files entirely.
   */
  const dropTabByPath = useCallback((path: string) => {
    setOpenTabs((prev) => prev.filter((t) => t.path !== path));
    if (activeTabPathRef.current === path) {
      const surviving = openTabsRef.current.filter((t) => t.path !== path);
      setActiveTabPath(surviving[0]?.path ?? null);
    }
  }, []);

  const activateTab = useCallback((tab: OpenTab) => {
    setActiveTabPath(tab.path);
    // If the tab's content was invalidated (fsRevision bump), refetch in the
    // background so the renderer shows fresh bytes. The renderer's existing
    // null-content guard renders an empty/loading state until content arrives.
    if (tab.content === null && workspaceId) {
      const path = tab.path;
      readFile(workspaceId, path).then((content) => {
        setOpenTabs((prev) => prev.map((t) => (
          t.path === path ? { ...t, content, savedContent: content } : t
        )));
      }).catch((err) => {
        if (
          err instanceof WorkspaceApiError &&
          (err.status === 404 || err.status === 403)
        ) {
          // File vanished (404) or read access was revoked (403) — auto-close.
          dropTabByPath(path);
        } else {
          console.error('Failed to refetch tab content:', err);
        }
      });
    }
  }, [workspaceId, dropTabByPath]);

  const addTab = useCallback(async (relativePath: string): Promise<boolean> => {
    if (!workspaceId) return false;
    // If a tab for this path already exists, just activate it. NEVER prompts
    // on dirty state — opening more tabs never discards work.
    const existing = openTabsRef.current.find((t) => t.path === relativePath);
    if (existing) {
      activateTab(existing);
      return true;
    }
    const requestId = ++addRequestIdRef.current;
    try {
      const content = await readFile(workspaceId, relativePath);
      const isLatest = requestId === addRequestIdRef.current;
      // Re-check dedup in case of races during the await.
      const stillExisting = openTabsRef.current.find((t) => t.path === relativePath);
      if (stillExisting) {
        // Only steal focus when THIS call is the latest open — preserves the
        // newer open's focus when an older read resolves second.
        if (isLatest) activateTab(stillExisting);
        return true;
      }
      const newTab: OpenTab = {
        path: relativePath,
        content,
        savedContent: content,
        isDirty: false,
        pendingFileContent: null,
      };
      // Race-safe append: a parallel addTab for the same path may have inserted
      // the tab between the dedup check above and this setter.
      setOpenTabs((prev) => (
        prev.some((t) => t.path === relativePath) ? prev : [...prev, newTab]
      ));
      if (isLatest) setActiveTabPath(relativePath);
      return true;
    } catch (err) {
      // Drop stale errors silently — the user already navigated to a newer
      // tab, surfacing the older error would be confusing.
      if (requestId !== addRequestIdRef.current) return false;
      // A 403 (read-restricted deep-link / id-link) throws like any other
      // failure: NO tab is created for a file the user can't read — the route
      // surfaces an access-denied state instead. Mirrors the tree, which hides
      // unreadable files entirely.
      console.error('Failed to read file:', err);
      throw err;
    }
  }, [workspaceId, activateTab]);

  const closeTab = useCallback(async (
    tab: OpenTab,
    options?: { skipConfirm?: boolean },
  ): Promise<{ closed: boolean; newActivePath: string | null }> => {
    if (tab.isDirty && !options?.skipConfirm) {
      const confirmed = window.confirm(UNSAVED_TAB_WARNING(basename(tab.path)));
      if (!confirmed) return { closed: false, newActivePath: activeTabPathRef.current };
    }
    const tabs = openTabsRef.current;
    const idx = tabs.findIndex((t) => t.path === tab.path);
    if (idx < 0) return { closed: true, newActivePath: activeTabPathRef.current };
    const next = tabs.filter((_, i) => i !== idx);
    setOpenTabs(next);
    let newActivePath = activeTabPathRef.current;
    if (activeTabPathRef.current === tab.path) {
      // Activate left neighbor, or right if none, or null if list is now empty.
      const newActive = next[idx - 1] ?? next[idx] ?? null;
      newActivePath = newActive?.path ?? null;
      setActiveTabPath(newActivePath);
    }
    return { closed: true, newActivePath };
  }, []);

  const closeAllTabs = useCallback(() => {
    setOpenTabs([]);
    setActiveTabPath(null);
  }, []);

  const reorderTab = useCallback((tab: OpenTab, toIndex: number) => {
    setOpenTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.path === tab.path);
      if (fromIdx < 0) return prev;
      const clamped = Math.max(0, Math.min(toIndex, prev.length - 1));
      if (clamped === fromIdx) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(clamped, 0, moved);
      return next;
    });
  }, []);

  const hydrateTabs = useCallback(async (
    paths: string[],
    activePath: string | null,
  ): Promise<{ surviving: string[]; dropped: string[]; denied: string[] }> => {
    if (!workspaceId) return { surviving: [], dropped: paths.slice(), denied: [] };
    // Deduplicate while preserving order.
    const uniqPaths = paths.filter((p, i) => paths.indexOf(p) === i);

    if (uniqPaths.length === 0) {
      setOpenTabs([]);
      setActiveTabPath(null);
      hydratedKeyRef.current = persistenceBranchRef.current
        ? `${workspaceId}.${persistenceBranchRef.current}`
        : null;
      return { surviving: [], dropped: [], denied: [] };
    }

    // Fetch every path in parallel. 404s are silently dropped (file no longer
    // on this branch); 403s are dropped too — a persisted tab the user can no
    // longer read auto-closes rather than erroring the whole hydrate into a
    // retry loop — but reported separately so a denied DEEPLINK can surface an
    // access message instead of "file not found". Other errors throw so the
    // caller can show "file-load-failed".
    const results = await Promise.allSettled(uniqPaths.map((p) => readFile(workspaceId, p)));
    const survivors: OpenTab[] = [];
    const surviving: string[] = [];
    const dropped: string[] = [];
    const denied: string[] = [];
    for (let i = 0; i < uniqPaths.length; i++) {
      const path = uniqPaths[i];
      const res = results[i];
      if (res.status === 'fulfilled') {
        survivors.push({
          path,
          content: res.value,
          savedContent: res.value,
          isDirty: false,
          pendingFileContent: null,
        });
        surviving.push(path);
      } else {
        const err = res.reason;
        if (err instanceof WorkspaceApiError && err.status === 404) {
          dropped.push(path);
        } else if (err instanceof WorkspaceApiError && err.status === 403) {
          denied.push(path);
        } else {
          // Surface the first unexpected failure so the route can show
          // "file-load-failed" rather than misleading "file-missing".
          throw err;
        }
      }
    }

    setOpenTabs(survivors);
    // Activate `activePath` if it survived; else last surviving path; else null.
    const requested = activePath && survivors.some((t) => t.path === activePath)
      ? activePath
      : (survivors[survivors.length - 1]?.path ?? null);
    setActiveTabPath(requested);
    hydratedKeyRef.current = persistenceBranchRef.current
      ? `${workspaceId}.${persistenceBranchRef.current}`
      : null;
    return { surviving, dropped, denied };
  }, [workspaceId]);

  // ── Renderer value bridge → active tab.content ────────────────────────────

  // Renderer fires this on every keystroke. Caching the typed value on the
  // tab is what lets the user switch to another tab and come back without
  // losing in-flight bytes.
  const setActiveTabContent = useCallback((value: string) => {
    const path = activeTabPathRef.current;
    if (!path) return;
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx < 0) return prev;
      if (prev[idx].content === value) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], content: value };
      return next;
    });
  }, []);

  // ── Renderer dirty bridge → active tab.isDirty ────────────────────────────

  const setHasUnsavedFileChanges = useCallback((dirty: boolean) => {
    const path = activeTabPathRef.current;
    if (!path) return;
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx < 0) return prev;
      if (prev[idx].isDirty === dirty) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], isDirty: dirty };
      return next;
    });
  }, []);

  // ── Working-tree mutations ────────────────────────────────────────────────

  const createFile = useCallback(async (relativePath: string, content?: string) => {
    if (!workspaceId) return;
    await writeFile(workspaceId, relativePath, content ?? '');
    await refreshFileTree();
    bumpFs();
  }, [workspaceId, refreshFileTree, bumpFs]);

  const createDirectory = useCallback(async (relativePath: string) => {
    if (!workspaceId) return;
    await createDirectoryApi(workspaceId, relativePath);
    await refreshFileTree();
    bumpFs();
  }, [workspaceId, refreshFileTree, bumpFs]);

  const unzipHere = useCallback(async (zipRelativePath: string) => {
    if (!workspaceId) {
      return { extracted: 0, skipped: [], destination: '' };
    }
    const result = await unzipFileApi(workspaceId, zipRelativePath);
    await refreshFileTree();
    bumpFs();
    return {
      extracted: result.extracted.length,
      skipped: result.skipped,
      destination: result.destination,
    };
  }, [workspaceId, refreshFileTree, bumpFs]);

  const uploadFiles = useCallback(async (files: File[], targetDirectory: string) => {
    if (!workspaceId) return;
    for (const file of files) {
      const relativePath = targetDirectory ? `${targetDirectory}/${file.name}` : file.name;
      try {
        await uploadFile(workspaceId, relativePath, file);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        throw Object.assign(new Error(message), { filename: file.name });
      }
    }
    await refreshFileTree();
    bumpFs();
  }, [workspaceId, refreshFileTree, bumpFs]);

  const clearUploadError = useCallback(() => setUploadError(null), []);
  const clearUploadNotice = useCallback(() => setUploadNotice(null), []);

  // Pending overlay: files/dirs the user dropped but whose server commits
  // haven't echoed back yet. The ref holds the mutable working set the
  // upload pipeline tweaks; the state snapshot is what React renders.
  // `flushPending` copies the ref into a fresh state Map whenever the
  // pipeline wants the renderer to catch up.
  const pendingUploadsRef = useRef<Map<string, PendingEntry>>(new Map());
  const [pendingUploads, setPendingUploads] = useState<Map<string, PendingEntry>>(
    () => new Map(),
  );
  const [uploadProgress, setUploadProgress] = useState<
    { uploaded: number; total: number | null } | null
  >(null);

  const flushPending = useCallback(() => {
    // Snapshot via a new Map so React sees a stable reference change.
    setPendingUploads(new Map(pendingUploadsRef.current));
  }, []);

  const addPending = useCallback((entry: PendingEntry) => {
    pendingUploadsRef.current.set(entry.fullPath, entry);
    flushPending();
  }, [flushPending]);

  const removePending = useCallback((fullPath: string) => {
    if (pendingUploadsRef.current.delete(fullPath)) flushPending();
  }, [flushPending]);

  const clearPendingMatching = useCallback((predicate: (entry: PendingEntry) => boolean) => {
    let changed = false;
    for (const [key, entry] of pendingUploadsRef.current) {
      if (predicate(entry)) {
        pendingUploadsRef.current.delete(key);
        changed = true;
      }
    }
    if (changed) flushPending();
  }, [flushPending]);

  /**
   * Should this upload land on the caller's suggestions branch instead of
   * here? Yes exactly when this branch is protected, the target folder is
   * inside the KB clone, and the per-path ACL says the caller may not write
   * it — the same three short-circuits as `useFileAccess`: drafts are
   * free-for-all, and paths outside the KB are the user's own workspace.
   * (The branch is recovered from the workspace id, which is the encoded
   * branch name for every branch workspace.)
   */
  const resolveSuggestionRouting = useCallback(
    async (targetDirectory: string): Promise<KnowledgeSuggestionTarget | null> => {
      if (!workspaceId || !kbDirName || !authUser) return null;
      if (!isProtectedBranch(decodeURIComponent(workspaceId))) return null;
      const prefix = `${kbDirName}/`;
      if (!targetDirectory.startsWith(prefix)) return null;
      const repoRelative = targetDirectory.slice(prefix.length);
      if (!repoRelative) return null;
      const access = await fetchFileAccess(workspaceId, repoRelative);
      if (access.canWrite) return null;
      return ensureKnowledgeSuggestionWorkspace(authUser.email);
    },
    [workspaceId, kbDirName, authUser],
  );

  const activeUploadsRef = useRef(0);
  const dispatchUpload = useCallback(async (input: UploadInput, targetDirectory: string) => {
    if (!workspaceId) return;

    // ── Suggestion routing ──
    // An upload into a KB folder the caller may NOT write neither fails nor
    // forces its way in: it lands on their personal suggestions branch and
    // surfaces as a change request — the same review path a typed proposal
    // takes. Resolved up front, because every byte below has to land in the
    // right workspace. If the access question itself cannot be answered,
    // upload normally: the backend's write gate stays the authority and
    // refuses with its own words.
    let suggestion: KnowledgeSuggestionTarget | null = null;
    try {
      suggestion = await resolveSuggestionRouting(targetDirectory);
    } catch (err) {
      console.warn('[workspace] suggestion routing check failed:', err);
    }
    const uploadWorkspaceId = suggestion?.workspaceId ?? workspaceId;
    // No optimistic tree overlay for a suggestion-routed upload: the files
    // will never appear in THIS branch's tree — they surface as suggestion
    // rows once the change request lists them.
    const optimistic = suggestion === null;
    // Pin the workspace at dispatch time. A folder upload can take seconds;
    // if the user switches branches mid-flight, the trailing state
    // mutations (setUploadError / setIsUploading / setFileTree via
    // refreshFileTree / clearPendingMatching) would clobber the new
    // branch's UI with old-branch results. `isCurrent()` gates every
    // post-await mutation; the workspaceId reset effect above already
    // clears the optimistic refs the moment the switch happens.
    const dispatchWorkspaceId = workspaceId;
    const isCurrent = () => workspaceIdRef.current === dispatchWorkspaceId;

    setUploadError(null);
    setUploadNotice(null);
    activeUploadsRef.current += 1;
    setIsUploading(true);

    // Batch mode collapses N per-file pushes into one end-of-burst push
    // via `POST /flush` — mirrors the recursive folder-delete batch.
    // Folder drops / folder-picker / multi-file pickers go through batch;
    // a single-file pick stays on the legacy 1-commit-1-push path so the
    // 1-file UX is exactly as fast as before (no extra `/flush` RTT).
    const isBatch =
      input.kind === 'items'
      || input.kind === 'paths'
      || (input.kind === 'files' && input.files.length > 1);

    // Track tree shape we discover as we walk so we can preserve empty
    // subdirectories. `discoveredDirs` = every directory the walker yielded;
    // `fileAncestors` = every prefix of every uploaded file's relative path.
    // `emptyDirs = discoveredDirs − fileAncestors` after the walk completes.
    const discoveredDirs = new Set<string>();
    const fileAncestors = new Set<string>();
    const fullPath = (rel: string) =>
      targetDirectory ? `${targetDirectory}/${rel}` : rel;
    const recordFileAncestors = (rel: string) => {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        fileAncestors.add(parts.slice(0, i).join('/'));
      }
    };

    let uploaded = 0;
    let total: number | null = null;
    let abort = false;
    let firstError: { filename: string; reason: string } | null = null;
    // Tracks whether any deferred `createDirectory` (empty-dir preservation)
    // commits landed. Without this, a folder drop containing only empty
    // subdirectories would skip `flushBatch` (`uploaded === 0`) and leave
    // the dir-create commits stranded unpushed locally.
    let deferredDirsQueued = false;

    const setProgress = () => {
      setUploadProgress({ uploaded, total });
    };

    const recordError = (filename: string, err: unknown) => {
      if (firstError) return;
      const reason = err instanceof Error ? err.message : 'Upload failed';
      firstError = { filename, reason };
      abort = true;
    };

    // Concurrency-bounded upload pump. Producer pushes UploadItems; workers
    // pull and upload. We don't use a queue + N worker promises because we
    // also want the producer to suspend when the queue is saturated, so we
    // model the cap as a semaphore.
    const inFlight: Promise<void>[] = [];

    const uploadOne = async (file: File, relativePath: string): Promise<void> => {
      const path = fullPath(relativePath);
      if (optimistic) {
        addPending({ fullPath: path, type: 'file' });
        // Pre-register the file's directory ancestors so the dropped
        // structure flashes in immediately, before any commits land.
        for (const ancestor of fileAncestors) {
          const ancestorFull = fullPath(ancestor);
          if (!pendingUploadsRef.current.has(ancestorFull)) {
            addPending({ fullPath: ancestorFull, type: 'directory' });
          }
        }
      }
      try {
        await uploadFile(uploadWorkspaceId, path, file, { defer: isBatch });
        uploaded += 1;
        setProgress();
        // Don't remove the pending entry here — the server commit has
        // landed but the file tree hasn't been refreshed yet, so removing
        // would briefly hide the file in the explorer. Reconciliation
        // happens after the final refresh in the `finally` block below.
      } catch (err) {
        recordError(path, err);
        // On failure, remove the pending entry so the failed file
        // disappears from the explorer rather than lingering as a ghost.
        removePending(path);
      }
    };

    const runWithCap = async (file: File, relativePath: string) => {
      while (inFlight.length >= UPLOAD_CONCURRENCY) {
        await Promise.race(inFlight);
      }
      const p = uploadOne(file, relativePath).finally(() => {
        const idx = inFlight.indexOf(p);
        if (idx >= 0) inFlight.splice(idx, 1);
      });
      inFlight.push(p);
    };

    const consume = async (item: DroppedItem) => {
      // OS-generated noise (`.DS_Store`, `__MACOSX/…`, `._*`) shouldn't be
      // committed to the KB — silently skip, mirroring the unzip route's
      // existing filter. Applied here so all three input modes share the
      // same rule.
      if (isUploadNoise(item.relativePath)) return;
      if (item.kind === 'dir') {
        discoveredDirs.add(item.relativePath);
        const dirFull = fullPath(item.relativePath);
        if (optimistic && !pendingUploadsRef.current.has(dirFull)) {
          addPending({ fullPath: dirFull, type: 'directory' });
        }
        return;
      }
      if (total === null) total = 1; else total += 1;
      setProgress();
      recordFileAncestors(item.relativePath);
      await runWithCap(item.file, item.relativePath);
    };

    try {
      if (input.kind === 'files') {
        const files = input.files.filter((f) => !isUploadNoise(f.name));
        total = files.length;
        setProgress();
        for (const file of files) {
          if (abort) break;
          await runWithCap(file, file.name);
        }
      } else if (input.kind === 'paths') {
        const items = input.items.filter((it) => !isUploadNoise(it.relativePath));
        total = items.length;
        setProgress();
        for (const it of items) {
          if (abort) break;
          recordFileAncestors(it.relativePath);
          await runWithCap(it.file, it.relativePath);
        }
      } else {
        // kind === 'items': lazy walk a snapshot of FileSystemEntry. Uploads
        // start on the first yielded file so the UI doesn't wait for full
        // enumeration.
        for await (const item of walkEntries(input.entries)) {
          if (abort) break;
          await consume(item);
        }
      }
      // Drain remaining in-flight uploads.
      while (inFlight.length > 0) {
        await Promise.race(inFlight);
      }

      // Empty-dir preservation: every directory the walker discovered that
      // didn't end up with a file under it needs an explicit createDirectory
      // call so its `.gitkeep` is committed. Skipped on error so we don't
      // half-commit a broken drop.
      if (!firstError && input.kind === 'items') {
        const emptyDirs: string[] = [];
        for (const dir of discoveredDirs) {
          if (!fileAncestors.has(dir)) emptyDirs.push(dir);
        }
        for (const rel of emptyDirs) {
          const path = fullPath(rel);
          try {
            await createDirectoryApi(uploadWorkspaceId, path, { defer: isBatch });
            if (isBatch) deferredDirsQueued = true;
          } catch (err) {
            recordError(path, err);
            break;
          }
        }
      }

      // End-of-batch checkpoint: push every commit accumulated above in
      // a single round-trip to origin and trigger one `fs-tree-changed`
      // server-side. Skipped on error so we don't try to push a half-
      // committed batch — the local commits sit unpushed until the next
      // save on this branch catches up, exactly like the folder-delete
      // batch's failure mode. The `deferredDirsQueued` arm covers the
      // empty-folders-only drop where `uploaded === 0` but we still
      // queued one or more deferred dir-create commits that need pushing.
      if (isBatch && !firstError && (uploaded > 0 || deferredDirsQueued)) {
        try {
          await flushBatch(uploadWorkspaceId, targetDirectory || '.');
        } catch (err) {
          recordError(targetDirectory || '.', err);
        }
      }

      // Suggestion-routed upload: the files are committed and pushed on the
      // caller's suggestions branch — now make sure the change request that
      // carries them to the owners exists, tell every listener the request
      // list changed (the tree's suggestion rows come from it), and say
      // where the files went. Silence here would be indistinguishable from
      // a failed upload: nothing appears where the user dropped them.
      if (suggestion && !firstError && (uploaded > 0 || deferredDirsQueued)) {
        try {
          await ensureKnowledgeChangeRequest(suggestion, authUser?.name ?? 'Someone');
          window.dispatchEvent(new Event(PR_STALE_EVENT));
          if (isCurrent()) {
            setUploadNotice(
              "You can't write to that folder, so the upload became a suggestion — " +
                'it is now a change request for the folder’s owners to review.',
            );
          }
        } catch (err) {
          recordError('change request', err);
        }
      }
    } catch (err) {
      // Walker-level failure (rare — broken entries are skipped inside the
      // walker). Surface as a generic error.
      recordError('upload', err);
    } finally {
      // Workspace-agnostic bookkeeping always runs so the next dispatch
      // sees a clean count. Everything below it is *workspace-shared* UI
      // state — if the user switched branches mid-flight, applying it
      // would clobber the new branch's view with results from the branch
      // they already left. The workspace-change effect already reset the
      // optimistic overlays.
      activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
      if (isCurrent()) {
        if (firstError) {
          setUploadError(firstError);
          // Drop any pending overlay entries that didn't make it — files
          // we already uploaded successfully are removed inside uploadOne.
          clearPendingMatching(() => true);
        }

        const stillRunning = activeUploadsRef.current > 0;
        setIsUploading(stillRunning);
        if (!stillRunning) setUploadProgress(null);

        // One final refresh to reconcile the server tree with whatever
        // committed, then clear pending overlay entries whose real
        // counterparts have arrived. Entries that didn't make it
        // (e.g. refresh raced ahead of a slow commit echo) stay in the
        // overlay until the next SSE-triggered refresh removes them.
        refreshFileTree()
          .then((tree) => {
            if (!isCurrent()) return;
            if (tree) {
              const realPaths = collectPaths(tree);
              clearPendingMatching((entry) => realPaths.has(entry.fullPath));
            }
            bumpFs();
          })
          .catch((err) => {
            console.warn('[workspace] post-upload tree refresh failed:', err);
          });
      }
    }
  }, [
    workspaceId, refreshFileTree, bumpFs,
    addPending, removePending, clearPendingMatching,
    resolveSuggestionRouting, authUser,
  ]);

  const deleteEntry = useCallback(async (relativePath: string) => {
    if (!workspaceId) return;
    // Pin the workspace at delete time. A recursive folder delete is N
    // per-file commits + one push — multiple seconds. If the user
    // switches branches mid-flight, the post-await mutations below
    // would clobber the new branch's tree / tabs with state from the
    // old branch's delete. `isCurrent()` gates every state mutation
    // after the await; the workspace-change reset effect already
    // clears `pendingDeletePathsRef` on its own.
    const deleteWorkspaceId = workspaceId;
    const isCurrent = () => workspaceIdRef.current === deleteWorkspaceId;

    // Tab sweep: close every tab whose path matches the deleted path or starts
    // with `deletedPath + '/'` (directory delete). If any swept tab is dirty,
    // confirm once with all affected filenames before proceeding.
    const prefix = relativePath + '/';
    const toClose = openTabsRef.current.filter(
      (t) => t.path === relativePath || t.path.startsWith(prefix),
    );
    const dirty = toClose.filter((t) => t.isDirty);
    if (dirty.length > 0) {
      const confirmed = window.confirm(UNSAVED_TABS_BULK_WARNING(dirty.map((t) => basename(t.path))));
      if (!confirmed) return;
    }
    // Optimistic tree removal. A folder delete on the server takes 2-3s
    // (N per-file commits batched into one push) — without optimism the
    // explorer freezes for that whole time and the user assumes nothing
    // happened. Snapshot first so we can roll back on failure. Mark the
    // path as pending so any mid-delete `refreshFileTree` (triggered by
    // per-file `file-changed` SSE events) also prunes it — otherwise the
    // folder would reappear with a partial child list each refresh.
    const treeSnapshot = fileTreeRef.current;
    pendingDeletePathsRef.current.add(relativePath);
    setFileTree((prev) => pruneTreeAt(prev, relativePath));
    bumpFs();
    try {
      await deleteFileApi(workspaceId, relativePath);
    } catch (err) {
      if (!isCurrent()) throw err;
      pendingDeletePathsRef.current.delete(relativePath);
      // Roll back the optimistic prune, then reconcile with whatever
      // partial state actually landed (a mid-batch failure leaves the
      // early files deleted and the rest intact).
      setFileTree(treeSnapshot);
      bumpFs();
      await refreshFileTree();
      throw err;
    }
    if (!isCurrent()) return;
    pendingDeletePathsRef.current.delete(relativePath);
    // Close tabs only after the server confirmed — keeps tab content +
    // cursor position intact on the rollback path.
    if (toClose.length > 0) {
      const survivingTabs = openTabsRef.current.filter(
        (t) => !(t.path === relativePath || t.path.startsWith(prefix)),
      );
      setOpenTabs(survivingTabs);
      if (activeTabPathRef.current && toClose.some((t) => t.path === activeTabPathRef.current)) {
        setActiveTabPath(survivingTabs[survivingTabs.length - 1]?.path ?? null);
      }
    }
    // No final refreshFileTree() — the optimistic prune already matches
    // server state. The backend's end-of-batch `fs-tree-changed` SSE
    // event triggers a refresh anyway as belt-and-suspenders. No second
    // `bumpFs()` either — the optimistic bump above already counted.
  }, [workspaceId, refreshFileTree, bumpFs]);

  const reloadTabFromDisk = useCallback(async (relativePath: string) => {
    if (!workspaceId) return;
    const exists = openTabsRef.current.some((t) => t.path === relativePath);
    if (!exists) return;
    // Capture the workspace this reload was issued for. The `await readFile`
    // below yields to the event loop, during which the user may switch
    // branches (workspaceIdRef.current changes). Applying old-branch bytes
    // to a new-branch tab would silently corrupt the buffer.
    const expectedWorkspaceId = workspaceId;
    try {
      const fresh = await readFile(expectedWorkspaceId, relativePath);
      if (workspaceIdRef.current !== expectedWorkspaceId) return;
      setOpenTabs((prev) => prev.map((t) => {
        if (t.path !== relativePath) return t;
        // Don't clobber in-flight local edits or a pending agent preview
        // that landed during the readFile. The caller (e.g. Edit-click)
        // assumes the tab was clean when it asked us to reload — if it
        // isn't anymore, the user's newer state wins.
        if (t.isDirty || t.pendingFileContent !== null) return t;
        // Skip if bytes are already in sync — avoids a useless re-render that
        // would briefly unmount the renderer.
        if (fresh === t.content && fresh === t.savedContent) return t;
        return {
          ...t,
          content: fresh,
          savedContent: fresh,
          isDirty: false,
          pendingFileContent: null,
        };
      }));
    } catch (err) {
      if (workspaceIdRef.current !== expectedWorkspaceId) return;
      if (err instanceof WorkspaceApiError && err.status === 404) {
        // File vanished between Edit click and reload — drop the tab.
        setOpenTabs((prev) => prev.filter((t) => t.path !== relativePath));
        if (activeTabPathRef.current === relativePath) {
          const surviving = openTabsRef.current.filter((t) => t.path !== relativePath);
          setActiveTabPath(surviving[surviving.length - 1]?.path ?? null);
        }
        return;
      }
      console.warn(`[workspace] reloadTabFromDisk failed for "${relativePath}":`, err);
      throw err;
    }
  }, [workspaceId]);

  const saveFile = useCallback(async (relativePath: string, content: string) => {
    if (!workspaceId) return;
    await writeFile(workspaceId, relativePath, content);
    // Update the matching tab — both the cached current value and the on-disk
    // baseline now equal `content`; clear dirty.
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === relativePath);
      if (idx < 0) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], content, savedContent: content, isDirty: false };
      return next;
    });
    bumpFs();
  }, [workspaceId, bumpFs]);

  const moveEntry = useCallback(async (oldPath: string, newPath: string) => {
    if (!workspaceId) return;
    await moveEntryApi(workspaceId, oldPath, newPath);
    // Rewrite all matching tab paths in place — exact match OR directory prefix.
    const oldPrefix = oldPath + '/';
    setOpenTabs((prev) => prev.map((t) => {
      if (t.path === oldPath) return { ...t, path: newPath };
      if (t.path.startsWith(oldPrefix)) return { ...t, path: newPath + t.path.slice(oldPath.length) };
      return t;
    }));
    if (activeTabPathRef.current === oldPath) {
      setActiveTabPath(newPath);
    } else if (activeTabPathRef.current && activeTabPathRef.current.startsWith(oldPrefix)) {
      setActiveTabPath(newPath + activeTabPathRef.current.slice(oldPath.length));
    }
    await refreshFileTree();
    bumpFs();
  }, [workspaceId, refreshFileTree, bumpFs]);

  // ── Pending-content (agent edits) — routed to active tab ──────────────────

  const setPendingContent = useCallback((content: string) => {
    const path = activeTabPathRef.current;
    if (!path) return;
    const active = openTabsRef.current.find((t) => t.path === path);
    if (!active || active.content === null) return;
    if (!contentChanged(active.content, content)) {
      // No diff — clear any stale pending and bail.
      setOpenTabs((prev) => prev.map((t) => (t.path === path ? { ...t, pendingFileContent: null } : t)));
      return;
    }
    setOpenTabs((prev) => prev.map((t) => (t.path === path ? { ...t, pendingFileContent: content } : t)));
  }, []);

  const acceptPendingContent = useCallback(async () => {
    const path = activeTabPathRef.current;
    if (!path) return;
    const active = openTabsRef.current.find((t) => t.path === path);
    if (!active || active.pendingFileContent === null) return;
    const content = active.pendingFileContent;
    // The agent's bytes were already flushed to disk by its tool call, so
    // accepting means: align both `content` and `savedContent` with that.
    setOpenTabs((prev) => prev.map((t) => (
      t.path === path
        ? { ...t, content, savedContent: content, pendingFileContent: null, isDirty: false }
        : t
    )));
  }, []);

  const rejectPendingContent = useCallback(async () => {
    if (!workspaceId) return;
    const path = activeTabPathRef.current;
    if (!path) return;
    const active = openTabsRef.current.find((t) => t.path === path);
    // Reject means: roll back to the on-disk baseline before the agent wrote.
    // savedContent holds that baseline; if it's null, fall back to content.
    const baseline = active?.savedContent ?? active?.content ?? null;
    if (!active || baseline === null) return;
    await writeFile(workspaceId, path, baseline);
    setOpenTabs((prev) => prev.map((t) => (
      t.path === path
        ? { ...t, content: baseline, savedContent: baseline, pendingFileContent: null, isDirty: false }
        : t
    )));
    bumpFs();
  }, [workspaceId, bumpFs]);

  // ── fsRevision invalidation ───────────────────────────────────────────────

  // When the working tree mutates, refetch the active tab's bytes in the
  // background and swap only if they actually changed. Inactive non-dirty
  // tabs are nulled so re-activating them triggers a refetch. Dirty tabs are
  // never touched — that's the user's in-flight work.
  //
  // **Why we don't null the active tab too** — nulling it would unmount the
  // renderer until the eager refetch resolves (FileViewer early-returns when
  // `openFileContent === null`). On a save-induced bump that's a visible
  // flicker: the file briefly disappears, then the renderer remounts. By
  // keeping the active tab's current bytes in place and only swapping on a
  // genuine diff, the user sees a stable view when bytes haven't changed,
  // and a clean swap when they have.
  const prevFsRevisionRef = useRef(0);
  useEffect(() => {
    if (fsRevision === prevFsRevisionRef.current) return;
    prevFsRevisionRef.current = fsRevision;
    if (fsRevision === 0) return;

    const activePath = activeTabPathRef.current;
    const activeBeforeInvalidation = openTabsRef.current.find((t) => t.path === activePath);
    const activeIsDirty = activeBeforeInvalidation?.isDirty ?? false;

    // Null inactive non-dirty tabs so re-activating them triggers a refetch.
    // The active tab keeps its current content — the eager refetch below
    // swaps it only if the bytes actually changed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenTabs((prev) => prev.map((t) => {
      if (t.isDirty || t.path === activePath) return t;
      return { ...t, content: null, savedContent: null };
    }));

    if (activePath && workspaceId && !activeIsDirty) {
      // Snapshot the workspace and the tab's content fingerprint at issue
      // time. `readFile` yields to the event loop — while it's in flight
      // the user can switch branches, switch active tabs, or start typing,
      // any of which means applying the fetched bytes would clobber
      // newer state. Re-check inside the updater before mutating.
      const expectedWorkspaceId = workspaceId;
      const baselineContent = activeBeforeInvalidation?.content ?? null;
      const baselineSavedContent = activeBeforeInvalidation?.savedContent ?? null;
      readFile(expectedWorkspaceId, activePath).then((content) => {
        if (workspaceIdRef.current !== expectedWorkspaceId) return;
        if (activeTabPathRef.current !== activePath) return;
        setOpenTabs((prev) => prev.map((t) => {
          if (t.path !== activePath) return t;
          // Tab now dirty / has pending agent content / its baseline
          // moved out from under us (e.g. saveFile already updated it
          // synchronously). Anything other than "still the buffer we
          // issued the read against" means newer state wins.
          if (t.isDirty || t.pendingFileContent !== null) return t;
          if (t.content !== baselineContent || t.savedContent !== baselineSavedContent) return t;
          // Same-bytes short-circuit: a save-triggered bump where the tab
          // was already updated synchronously by saveFile() will land here
          // with identical content, so we avoid a needless re-render.
          if (content === t.content && content === t.savedContent) return t;
          return { ...t, content, savedContent: content };
        }));
      }).catch((err) => {
        if (workspaceIdRef.current !== expectedWorkspaceId) return;
        if (err instanceof WorkspaceApiError && err.status === 404) {
          setOpenTabs((prev) => prev.filter((t) => t.path !== activePath));
          setActiveTabPath((cur) => {
            if (cur !== activePath) return cur;
            const surviving = openTabsRef.current.filter((t) => t.path !== activePath);
            return surviving[surviving.length - 1]?.path ?? null;
          });
        } else {
          console.error('Failed to refetch active tab content:', err);
        }
      });
    }
  }, [fsRevision, workspaceId]);

  // ── Reset hydratedKey when persistenceBranch changes ──────────────────────

  // When the user switches branches, the previously-hydrated key no longer
  // applies. Clear the marker so the auto-persist effect waits for a fresh
  // `hydrateTabs` call before writing localStorage for the new branch.
  useEffect(() => {
    if (!workspaceId || !persistenceBranch) {
      hydratedKeyRef.current = null;
      return;
    }
    const key = `${workspaceId}.${persistenceBranch}`;
    if (hydratedKeyRef.current !== key) {
      hydratedKeyRef.current = null;
    }
  }, [workspaceId, persistenceBranch]);

  // ── Auto-persist tabs to localStorage (debounced) ─────────────────────────

  useEffect(() => {
    if (!workspaceId || !persistenceBranch) return;
    const key = `${workspaceId}.${persistenceBranch}`;
    if (hydratedKeyRef.current !== key) return;

    const handle = window.setTimeout(() => {
      try {
        const payload: PersistedTabState = {
          paths: openTabs.map((t) => t.path),
          activePath: activeTabPath,
        };
        localStorage.setItem(tabsKey(workspaceId, persistenceBranch), JSON.stringify(payload));
      } catch (err) {
        console.warn('Failed to persist tabs:', err);
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [openTabs, activeTabPath, workspaceId, persistenceBranch]);

  const deleteWorkspace = useCallback(async () => {
    if (!workspaceId) return;
    try {
      await deleteWorkspaceApi(workspaceId);
      closeAllTabs();
      // Re-bootstrap on the SAME branch the user was viewing. Without
      // passing `persistenceBranch`, getOrCreateWorkspace falls back to
      // the default branch (`target-company-state`), which silently
      // swaps the user onto a different branch after a delete.
      const branch = persistenceBranchRef.current ?? undefined;
      const { workspace, fileTree: tree } = await getOrCreateWorkspace(branch);
      setWorkspaceId(workspace.id);
      setKbDirName(workspace.kbDirName);
      setFileTree(tree);
    } catch (err) {
      console.error('Failed to delete workspace:', err);
    }
  }, [workspaceId, closeAllTabs]);

  // ── Live updates: react to other users' / agent's edits ───────────────────
  //
  // When the backend's lock-release commits + pushes a file, the workflow
  // event bus pushes a `file-changed` event to every session focused on
  // this workspace+branch. We:
  //
  //   1. Refresh the file tree (the path may be new or deleted).
  //   2. For an open tab matching the changed path, refetch the content
  //      and replace the buffer unconditionally. The dirty bit is cleared
  //      because the local buffer is now superseded by what's on disk.
  //
  // **Why we don't filter by "is it our own save"** — when the user's own
  // lock-release fires, the SSE event echoes back to this tab. We refetch,
  // the new content equals `savedContent` (we just wrote it), and the
  // comparison short-circuits the state update entirely (no re-render).
  // Same code path handles "another user changed the file" and "I just
  // saved" without needing to know the current user's id.
  //
  // **Why we don't preserve a dirty buffer** — the alternative is a silent
  // last-write-wins overwrite when this user next acquires the lock and
  // saves: the cached pre-update content + their typing would clobber the
  // teammate's commit. Auto-reloading is louder than silent overwrite and
  // is the right default given how the lock pipeline serialises writes.
  //
  // The bus only delivers workspace-scoped events for the currently
  // focused workspace (set by `EventBusFocusBinder`), so the workspace
  // filter on the handler is belt-and-braces.
  // Track the current workspaceId in a ref so the async readFile handler
  // below can detect a workspace switch that happened after it was
  // subscribed but before its fetch resolved — otherwise a stale resolve
  // would call `setOpenTabs` on the new workspace's tabs, replacing the
  // wrong file's content with bytes from the old branch.
  const workspaceIdRef = useRef<string | null>(workspaceId);
  useEffect(() => { workspaceIdRef.current = workspaceId; }, [workspaceId]);

  // Reset the optimistic-overlay state on workspace switch. Without this,
  // pending entries from a partly-uploaded folder on branch A linger in
  // the explorer after the user switches to branch B, and the async
  // dispatchUpload tail can keep mutating these refs for the old
  // workspace. Clearing both refs + the rendered Map together keeps the
  // overlay tied to the workspace it was generated for. The setState in
  // here is the intentional "reset on key change" pattern — the other
  // useEffect in this file uses the same exemption.
  useEffect(() => {
    pendingUploadsRef.current = new Map();
    pendingDeletePathsRef.current = new Set();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingUploads(new Map());
  }, [workspaceId]);

  const bus = useEventBus();
  useEffect(() => {
    if (!bus || !workspaceId) return;
    // Pin the workspaceId at subscription time. The handler closure
    // already captures `workspaceId`, but the in-flight readFile that
    // each invocation kicks off may resolve AFTER the workspace has
    // switched. The check against `workspaceIdRef.current` below
    // discards stale resolves so we never apply old-branch bytes to a
    // new-branch tab.
    const subscribedWorkspaceId = workspaceId;
    // Canonicalise once for every subsequent comparison — see the
    // helper's doc for why the two sides arrive in different
    // encodings. Without this, every feature branch with `/` in the
    // name silently drops every event.
    const subscribedCanon = canonicalizeWorkspaceId(subscribedWorkspaceId);
    const offFileChanged = bus.subscribe('file-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      void refreshFileTree();
      // (No access-denied tab recovery here: a tab whose read 403s auto-closes
      // immediately, so there is never a denied tab to revive. A re-granted
      // file reappears in the refreshed tree instead.)
      const matchingTab = openTabsRef.current.find((t) => t.path === event.path);
      if (!matchingTab) return;
      // Don't clobber a pending agent preview the user is reviewing.
      // The agent's bytes are still on disk; the user is comparing
      // them against the current accepted content. Overwriting with
      // freshly-fetched disk bytes (which may include the agent's
      // write) would silently end their review.
      if (matchingTab.pendingFileContent !== null) return;
      readFile(subscribedWorkspaceId, event.path)
        .then((content) => {
          if (workspaceIdRef.current !== subscribedWorkspaceId) {
            // Workspace switched while the refetch was in flight. The
            // tab list we'd be mutating is for a different branch now
            // — discard the stale result rather than apply old-branch
            // bytes to the new branch.
            return;
          }
          setOpenTabs((tabs) =>
            tabs.map((t) => {
              if (t.path !== event.path) return t;
              // Re-check pending status inside the updater — `setPendingContent`
              // may have landed during the readFile await.
              if (t.pendingFileContent !== null) return t;
              // Self-save echo: backend emits the event for our own
              // releaseLock too. Skip the update so the tab doesn't
              // re-render uselessly.
              if (content === t.savedContent && content === t.content) return t;
              return {
                ...t,
                content,
                savedContent: content,
                isDirty: false,
                pendingFileContent: null,
              };
            }),
          );
        })
        .catch((err) => {
          if (err instanceof WorkspaceApiError && err.status === 403) {
            // Read access revoked underneath us — auto-close the tab instead
            // of leaving previously-loaded bytes visible.
            if (workspaceIdRef.current !== subscribedWorkspaceId) return;
            dropTabByPath(event.path);
            return;
          }
          console.warn(`[workspace] refetch on file-changed failed for "${event.path}":`, err);
        });
    });
    const offFsTreeChanged = bus.subscribe('fs-tree-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      void refreshFileTree();
    });
    // Belt-and-suspenders: also refetch on `lock-released` for any open
    // tab. The teammate's save emits both `lock-released` and (when the
    // commit landed) `file-changed`, but if file-changed didn't fire —
    // e.g. the backend gated it on `if (change)` and `commitFile`
    // returned null for some edge case (whitespace-only diff stripped by
    // line-ending normalization, etc.) — the lock-released event still
    // gives us a signal that something MAY have changed. Refetching is
    // idempotent: identical bytes hit the same-content short-circuit
    // below and yield no re-render.
    const offLockReleased = bus.subscribe('lock-released', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      const matchingTab = openTabsRef.current.find((t) => t.path === event.path);
      if (!matchingTab) return;
      // Skip if WE just released the lock — that path is already
      // handled by `saveFile` updating the tab + the `file-changed`
      // self-echo. Refetching here would race against that and is
      // wasted work.
      if (matchingTab.isDirty) return;
      // Don't clobber a pending agent preview — see file-changed
      // handler above for the same guard's rationale.
      if (matchingTab.pendingFileContent !== null) return;
      readFile(subscribedWorkspaceId, event.path)
        .then((content) => {
          if (workspaceIdRef.current !== subscribedWorkspaceId) return;
          setOpenTabs((tabs) => tabs.map((t) => {
            if (t.path !== event.path) return t;
            if (t.pendingFileContent !== null) return t;
            if (content === t.savedContent && content === t.content) return t;
            return {
              ...t,
              content,
              savedContent: content,
              isDirty: false,
              pendingFileContent: null,
            };
          }));
        })
        .catch((err) => {
          if (err instanceof WorkspaceApiError && err.status === 403) {
            // Read access revoked underneath us — auto-close the tab.
            if (workspaceIdRef.current !== subscribedWorkspaceId) return;
            dropTabByPath(event.path);
            return;
          }
          console.warn(`[workspace] refetch on lock-released failed for "${event.path}":`, err);
        });
    });
    return () => {
      offFileChanged();
      offFsTreeChanged();
      offLockReleased();
    };
  }, [bus, workspaceId, refreshFileTree, dropTabByPath]);

  // ── Derived values ────────────────────────────────────────────────────────

  const activeTab = useMemo(
    () => openTabs.find((t) => t.path === activeTabPath) ?? null,
    [openTabs, activeTabPath],
  );
  const dirtyTabFilenames = useMemo(
    () => openTabs.filter((t) => t.isDirty).map((t) => basename(t.path)),
    [openTabs],
  );
  const hasUnsavedFileChanges = dirtyTabFilenames.length > 0;
  const openFilePath = activeTab?.path ?? null;
  const openFileContent = activeTab?.content ?? null;
  const openFileSavedContent = activeTab?.savedContent ?? null;
  const pendingFileContent = activeTab?.pendingFileContent ?? null;

  return useMemo(() => ({
    workspaceId,
    kbDirName,
    fileTree,
    openTabs,
    activeTab,
    dirtyTabFilenames,
    openFilePath,
    openFileContent,
    openFileSavedContent,
    hasUnsavedFileChanges,
    pendingFileContent,
    setHasUnsavedFileChanges,
    setActiveTabContent,
    fsRevision,
    uploadError,
    uploadNotice,
    clearUploadNotice,
    isUploading,
    uploadProgress,
    pendingUploads,
    refreshFileTree,
    bumpFsRevision: bumpFs,
    addTab,
    closeTab,
    activateTab,
    reorderTab,
    closeAllTabs,
    hydrateTabs,
    createFile,
    createDirectory,
    unzipHere,
    uploadFiles,
    dispatchUpload,
    clearUploadError,
    deleteEntry,
    moveEntry,
    saveFile,
    reloadTabFromDisk,
    setPendingContent,
    acceptPendingContent,
    rejectPendingContent,
    setPersistenceBranch,
    deleteWorkspace,
  }), [
    workspaceId, kbDirName, fileTree, openTabs, activeTab, dirtyTabFilenames,
    openFilePath, openFileContent, openFileSavedContent, hasUnsavedFileChanges, pendingFileContent,
    setHasUnsavedFileChanges, setActiveTabContent, fsRevision, uploadError, uploadNotice, clearUploadNotice, isUploading, uploadProgress, pendingUploads, refreshFileTree, bumpFs,
    addTab, closeTab, activateTab, reorderTab, closeAllTabs, hydrateTabs,
    createFile, createDirectory, unzipHere, uploadFiles, dispatchUpload, clearUploadError,
    deleteEntry, moveEntry, saveFile, reloadTabFromDisk,
    setPendingContent, acceptPendingContent, rejectPendingContent,
    setPersistenceBranch, deleteWorkspace,
  ]);
}

/*
 * The shell's own stand-in for the workspace session, for suites that mount
 * the whole shell. It is typed against `WorkspaceContextValue` from the
 * workspace module's entry, so a field the session gains fails type-checking
 * here rather than in each suite's object literal, and the shell's tests
 * never reach into the workspace module's own test files.
 */
import type { WorkspaceContextValue } from '../../modules/workspace';

/** An idle session on `main` with nothing open; `overrides` set the rest. */
export function makeShellWorkspace(overrides: Partial<WorkspaceContextValue> = {}): WorkspaceContextValue {
  return {
    workspaceId: 'ws-1',
    kbDirName: 'knowledge-base',
    fileTree: null,
    bootstrapError: null,
    workspaceBranch: 'main',
    retryBootstrap: () => {},
    openTabs: [],
    activeTab: null,
    dirtyTabFilenames: [],
    openFilePath: null,
    openFileContent: null,
    openFileSavedContent: null,
    hasUnsavedFileChanges: false,
    pendingFileContent: null,
    setActiveTabContent: () => {},
    bumpFsRevision: () => {},
    setPersistenceBranch: () => {},
    fsRevision: 0,
    uploadErrors: new Map(),
    uploadNotices: new Map(),
    clearUploadNotice: () => {},
    isUploading: false,
    uploadProgress: null,
    pendingUploads: new Map(),
    refreshFileTree: async () => null,
    addTab: async () => true,
    closeTab: async () => ({ closed: true, newActivePath: null }),
    activateTab: () => {},
    reorderTab: () => {},
    closeAllTabs: () => {},
    hydrateTabs: async () => ({ surviving: [], dropped: [], denied: [], superseded: false }),
    createFile: async () => {},
    createDirectory: async () => {},
    unzipHere: async () => ({ extracted: 0, skipped: [], destination: '' }),
    uploadFiles: async () => {},
    dispatchUpload: async () => {},
    clearUploadError: () => {},
    deleteEntry: async () => {},
    moveEntry: async () => {},
    saveFile: async () => {},
    reloadTabFromDisk: async () => {},
    setPendingContent: () => {},
    acceptPendingContent: async () => {},
    rejectPendingContent: async () => {},
    ...overrides,
  };
}

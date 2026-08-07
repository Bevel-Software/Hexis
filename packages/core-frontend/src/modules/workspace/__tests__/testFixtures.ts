// Shared test fixtures for WorkspaceContextValue. Avoids the trap where each
// test file ad-hocs its own object literal — the moment the interface gains a
// required field, every one of those literals fails type-checking. Centralise
// the defaults here so adding `unzipHere`, `bumpFsRevision`, etc. is a
// one-line edit instead of a sweep.

import type { WorkspaceContextValue } from '../state/workspace.context';

export function makeWorkspaceFixture(
  overrides: Partial<WorkspaceContextValue> = {},
): WorkspaceContextValue {
  return {
    workspaceId: 'ws-1',
    kbDirName: 'knowledge-base',
    fileTree: null,
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
    uploadError: null,
    uploadNotice: null,
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
    hydrateTabs: async () => ({ surviving: [], dropped: [], denied: [] }),
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

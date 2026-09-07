import { useMemo } from 'react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { useWorkspace, type PendingEntry } from '../state/workspace.context';
import { mergePendingIntoTree, pathExistsInTree } from '../utils/fileTree';
import { useOpenChangeRequests } from './useOpenChangeRequests';

/**
 * The branch's tree with two overlays: the caller's pending uploads (a
 * dropped file shows within a frame, before its commit echoes back) and the
 * files their own open change requests propose that this branch does not have
 * yet. ONE hook, because two navs read the same workspace — the Knowledge
 * explorer and the Library's Skills tree — and an overlay one of them lacked
 * would be a file that exists in one sidebar and not the other.
 */
export function useMergedWorkspaceTree(): {
  tree: FileTreeEntry | null;
  /** Paths synthesized from the caller's own requests → the request's number. */
  suggestionOnlyPaths: ReadonlyMap<string, number>;
} {
  const { fileTree, kbDirName, pendingUploads } = useWorkspace();
  const serverTree = useMemo(
    () => (fileTree ? mergePendingIntoTree(fileTree, pendingUploads) : null),
    [fileTree, pendingUploads],
  );

  // The caller's own proposed files that do NOT exist on this branch — they
  // live only on the personal suggestions branch behind an open change
  // request. The tree shows them beside the branch's real files (synthesized
  // below), coloured differently, and clicking one opens the request.
  const openChangeRequests = useOpenChangeRequests();
  const suggestionOnlyPaths = useMemo(() => {
    const map = new Map<string, number>();
    if (!serverTree) return map;
    /**
     * "Not in the tree" has TWO causes, and only one earns a row: the file is
     * new on the suggestions branch — or the server FILTERED it (.bevelignore,
     * read gates). The client cannot evaluate those rules itself, but it can
     * read their verdict off the tree: if the path's top-level folder under
     * the repo root is absent, the whole subtree is hidden (a skill proposal
     * under a bevelignored `Plugins/` was the observed leak), so the overlay
     * must not resurrect it. The known cost: a proposal that CREATES a new
     * top-level root folder shows no row until it merges.
     */
    const hiddenRoot = (path: string): boolean => {
      const prefix = kbDirName && path.startsWith(`${kbDirName}/`) ? `${kbDirName}/` : '';
      const segments = path.slice(prefix.length).split('/');
      if (segments.length < 2) return false; // directly under the repo root
      return !pathExistsInTree(serverTree, `${prefix}${segments[0]}`);
    };
    for (const [path, crNumber] of openChangeRequests.minePaths) {
      if (!pathExistsInTree(serverTree, path) && !hiddenRoot(path)) {
        map.set(path, crNumber);
      }
    }
    return map;
  }, [serverTree, openChangeRequests, kbDirName]);

  const tree = useMemo(() => {
    if (!serverTree || suggestionOnlyPaths.size === 0) return serverTree;
    // Reuses the pending-upload synthesizer: same parent-directory creation,
    // same sort order, and a real entry always wins over a synthesized one.
    const asEntries = new Map<string, PendingEntry>();
    for (const path of suggestionOnlyPaths.keys()) {
      asEntries.set(path, { fullPath: path, type: 'file' });
    }
    return mergePendingIntoTree(serverTree, asEntries);
  }, [serverTree, suggestionOnlyPaths]);

  return { tree, suggestionOnlyPaths };
}

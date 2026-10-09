import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { fetchFileAccessBatch } from '../../access/api';
import { useWorkspace } from '../state/workspace.context';
import { useMergedWorkspaceTree } from './useMergedWorkspaceTree';
import { findEntryByPath } from '../utils/fileTree';

/**
 * Where New page writes for the person signed in, on the branch on screen:
 * `folder` is a workspace-relative Knowledge folder, or null — while the
 * check has not answered (`settled` false), and once it has when there is
 * nowhere they may write. Everything that offers New page hides it while
 * `folder` is null.
 */
export interface KnowledgeWriteTarget {
  folder: string | null;
  settled: boolean;
  /**
   * Ask again now, past the debounce, and resolve with the new answer — what
   * a refused write does, since the refusal says the last answer is stale.
   */
  recheck(): Promise<string | null>;
}

/** The access endpoint answers at most this many paths per call. */
export const ACCESS_BATCH_LIMIT = 500;

/**
 * How long a change to the tree or the page on screen waits before it is
 * asked about. The tree is rebuilt on every file event, often several in a
 * row; the first check of all runs at once, so the list never waits on this.
 */
export const WRITE_TARGET_DEBOUNCE_MS = 250;

/** Every folder under `entry`, depth first in the tree's own order; dot-folders are not places for pages. */
export function knowledgeFoldersInOrder(entry: FileTreeEntry | null, out: string[] = []): string[] {
  for (const child of entry?.children ?? []) {
    if (child.type !== 'directory' || child.name.startsWith('.')) continue;
    out.push(child.relativePath);
    knowledgeFoldersInOrder(child, out);
  }
  return out;
}

/**
 * The folder a page goes in, asked of the batch access endpoint in pages of
 * at most {@link ACCESS_BATCH_LIMIT} paths: the Knowledge folder when the
 * person may write it (admins, as before); else the folder of the page on
 * screen when they may write that; else the first folder they may write, in
 * file tree order. Stops at the first page that answers. Throws when a
 * request fails, which the hook reads as "nowhere" (see below).
 */
export async function findKnowledgeWriteTarget(
  workspaceId: string,
  kbDirName: string,
  knowledgeRoot: string,
  openFolder: string | null,
  folders: readonly string[],
): Promise<string | null> {
  // Asked in the order requirement 1 picks in, so the first page carries the
  // two folders that win outright, and no path is asked about twice.
  const ordered = [knowledgeRoot, ...(openFolder && openFolder !== knowledgeRoot ? [openFolder] : [])];
  for (const folder of folders) if (!ordered.includes(folder)) ordered.push(folder);
  const toRepo = (path: string) => path.slice(kbDirName.length + 1);
  for (let start = 0; start < ordered.length; start += ACCESS_BATCH_LIMIT) {
    const page = ordered.slice(start, start + ACCESS_BATCH_LIMIT);
    const { results } = await fetchFileAccessBatch(workspaceId, page.map(toRepo));
    const found = page.find((path) => results[toRepo(path)] === true);
    if (found) return found;
  }
  return null;
}

/**
 * {@link KnowledgeWriteTarget} for the workspace on screen. Asked once on
 * mount and again (debounced) whenever the file tree or the page on screen
 * changes — which is how a folder an admin shares later brings New page
 * without a reload — and on demand through `recheck`.
 *
 * A request that fails settles with no folder: New page is hidden until a
 * later check succeeds, rather than offered where it can only be refused.
 * The last answer stays while a new one is on its way, so nothing that hangs
 * off it flickers on every tree refresh.
 */
export function useKnowledgeWriteTarget(knowledgeRoot: string | null): KnowledgeWriteTarget {
  const { workspaceId, kbDirName, openFilePath } = useWorkspace();
  const { tree } = useMergedWorkspaceTree();
  const [answer, setAnswer] = useState<{ folder: string | null; settled: boolean }>({
    folder: null,
    settled: false,
  });

  const openFolder =
    openFilePath && knowledgeRoot && openFilePath.startsWith(`${knowledgeRoot}/`)
      ? openFilePath.slice(0, openFilePath.lastIndexOf('/'))
      : null;
  const folders = useMemo(
    () => (knowledgeRoot ? knowledgeFoldersInOrder(findEntryByPath(tree, knowledgeRoot)) : []),
    [tree, knowledgeRoot],
  );

  // Only the latest question's answer lands: a slow reply to an older tree
  // must not overwrite a newer one.
  const asked = useRef(0);
  const ask = useCallback(async (): Promise<string | null> => {
    if (!workspaceId || !kbDirName || !knowledgeRoot) return null;
    const n = ++asked.current;
    let folder: string | null;
    try {
      folder = await findKnowledgeWriteTarget(workspaceId, kbDirName, knowledgeRoot, openFolder, folders);
    } catch {
      folder = null;
    }
    if (n === asked.current) setAnswer({ folder, settled: true });
    return folder;
  }, [workspaceId, kbDirName, knowledgeRoot, openFolder, folders]);

  const answeredOnce = useRef(false);
  useEffect(() => {
    if (!workspaceId || !kbDirName || !knowledgeRoot) return;
    if (!answeredOnce.current) {
      answeredOnce.current = true;
      void ask();
      return;
    }
    const timer = setTimeout(() => void ask(), WRITE_TARGET_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ask, workspaceId, kbDirName, knowledgeRoot]);

  return { folder: answer.folder, settled: answer.settled, recheck: ask };
}

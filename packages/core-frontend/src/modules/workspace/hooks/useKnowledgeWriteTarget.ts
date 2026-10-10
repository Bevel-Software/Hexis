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
   * Whether `folder` was asked for the workspace, branch and page on screen
   * now. Mid-switch the last answer stays up, so nothing flickers, but it may
   * name the page or branch just left: a create asks again first.
   */
  current: boolean;
  /**
   * Ask again now, past the debounce, and resolve with the new answer — what
   * a refused write does, since the refusal says the last answer is stale.
   */
  recheck(): Promise<string | null>;
  /**
   * Take New page away on this workspace and branch: a write was refused
   * where the check still says the person may write, so the refusal is not
   * about folders (a protected branch) and no folder here would take it.
   * Lifted by a switch of workspace or branch.
   */
  withdraw(): void;
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
  const seen = new Set(ordered);
  for (const folder of folders) {
    if (seen.has(folder)) continue;
    seen.add(folder);
    ordered.push(folder);
  }
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
 * {@link KnowledgeWriteTarget} for the workspace on screen. Asked once the
 * file tree is there — before it, only the top of Knowledge could be asked
 * about, and someone who may write only a folder below would see New page
 * arrive late — and again whenever the tree or the page on screen changes:
 * at once for a workspace or branch not yet asked about, debounced after
 * that. That is how a folder an admin shares later brings New page without
 * a reload. `recheck` asks on demand.
 *
 * A request that fails settles with no folder: New page is hidden until a
 * later check succeeds, rather than offered where it can only be refused.
 * The last answer stays while a new one is on its way, so nothing that hangs
 * off it flickers on every tree refresh.
 */
export function useKnowledgeWriteTarget(knowledgeRoot: string | null): KnowledgeWriteTarget {
  const { workspaceId, workspaceBranch, kbDirName, openFilePath } = useWorkspace();
  const { tree } = useMergedWorkspaceTree();
  const [answer, setAnswer] = useState<{ folder: string | null; settled: boolean; askedFor: string | null }>({
    folder: null,
    settled: false,
    askedFor: null,
  });

  const openFolder =
    openFilePath && knowledgeRoot && openFilePath.startsWith(`${knowledgeRoot}/`)
      ? openFilePath.slice(0, openFilePath.lastIndexOf('/'))
      : null;
  const folders = useMemo(
    () => (knowledgeRoot ? knowledgeFoldersInOrder(findEntryByPath(tree, knowledgeRoot)) : []),
    [tree, knowledgeRoot],
  );
  // What an answer was asked about; an answer about anything else is out of date.
  const workspaceKey = `${workspaceId}\n${workspaceBranch}\n${knowledgeRoot}`;
  const askingFor = `${workspaceKey}\n${openFolder}`;

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
    if (n === asked.current) setAnswer({ folder, settled: true, askedFor: askingFor });
    return folder;
  }, [workspaceId, kbDirName, knowledgeRoot, openFolder, folders, askingFor]);

  const askedWorkspace = useRef<string | null>(null);
  const hasTree = tree !== null;
  useEffect(() => {
    if (!workspaceId || !kbDirName || !knowledgeRoot || !hasTree) return;
    if (askedWorkspace.current !== workspaceKey) {
      askedWorkspace.current = workspaceKey;
      void ask();
      return;
    }
    const timer = setTimeout(() => void ask(), WRITE_TARGET_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ask, workspaceId, kbDirName, knowledgeRoot, hasTree, workspaceKey]);

  const [withdrawnFor, setWithdrawnFor] = useState<string | null>(null);
  // A switch lifts a withdrawal for good, so coming back to that branch
  // offers New page again; so does a withdrawal that lands after a switch.
  if (withdrawnFor !== null && withdrawnFor !== workspaceKey) setWithdrawnFor(null);
  const withdrawn = withdrawnFor === workspaceKey;
  const withdraw = useCallback(() => setWithdrawnFor(workspaceKey), [workspaceKey]);

  return {
    folder: withdrawn ? null : answer.folder,
    settled: answer.settled,
    current: answer.settled && answer.askedFor === askingFor,
    recheck: ask,
    withdraw,
  };
}

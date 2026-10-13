import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentBranchModel, isProtectedBranch, type FileTreeEntry } from '@bevel-software/platform-shared';
import { fetchFileAccessBatch } from '../../access/api';
import { useWorkspace } from '../state/workspace.context';
import { useMergedWorkspaceTree } from './useMergedWorkspaceTree';
import { findEntryByPath } from '../utils/fileTree';
import { useLatestRequest } from '../../../lib/latest-request';

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
   * The answer is for what is on screen when it resolves: if the page or the
   * branch changed while it was out, it is asked again for the new one.
   */
  recheck(): Promise<string | null>;
  /**
   * The folder for what is on screen NOW: the last answer when it was asked
   * about this page and branch, else a {@link recheck}. What a create writes
   * to — never the folder of a page just left, which `folder` may still show
   * during the debounce after a page change.
   */
  resolve(): Promise<string | null>;
  /**
   * Take New page away on this workspace and branch: a write was refused
   * where the check still says the person may write, so the refusal is not
   * about folders (a protected branch) and no folder here would take it.
   * Lifted by a switch of workspace or branch.
   */
  withdraw(): void;
}

/** The access endpoint answers at most this many paths per call. */
const ACCESS_BATCH_LIMIT = 500;

/**
 * How long a change to the tree or the page on screen waits before it is
 * asked about. The tree is rebuilt on every file event, often several in a
 * row; the first check of all runs at once, so the list never waits on this.
 */
const WRITE_TARGET_DEBOUNCE_MS = 250;

/** Every folder under `entry`, depth first in the tree's own order; dot-folders are not places for pages. */
function knowledgeFoldersInOrder(entry: FileTreeEntry | null, out: string[] = []): string[] {
  for (const child of entry?.children ?? []) {
    if (child.type !== 'directory' || child.name.startsWith('.')) continue;
    out.push(child.relativePath);
    knowledgeFoldersInOrder(child, out);
  }
  return out;
}

/**
 * The folders a page may go in, in the order requirement 1 picks them: the
 * Knowledge folder, the folder of the page on screen, then every folder in
 * file tree order — each once.
 */
function candidateFolders(knowledgeRoot: string, openFolder: string | null, folders: readonly string[]): string[] {
  const ordered = [knowledgeRoot, ...(openFolder && openFolder !== knowledgeRoot ? [openFolder] : [])];
  const seen = new Set(ordered);
  for (const folder of folders) {
    if (seen.has(folder)) continue;
    seen.add(folder);
    ordered.push(folder);
  }
  return ordered;
}

/**
 * The folder a page goes in, asked of the batch access endpoint in pages of
 * at most {@link ACCESS_BATCH_LIMIT} paths: the Knowledge folder when the
 * person may `verb` it; else the folder of the page on screen when they may;
 * else the first folder they may, in file tree order. Stops at the first
 * page that answers. Throws when a request fails, which the hook reads as
 * "nowhere" (see below).
 *
 * A protected branch asks `write` (admins get the top, as before). A draft
 * asks `read`: there no write grant is needed and the server's only gate is
 * READ-BEFORE-WRITE, a new page lands only in a folder its author may read.
 * The tree cannot say which folders those are — it shows a folder the person
 * may not read whenever something inside it is shared with them — so every
 * candidate is asked, in one request for all but the largest trees.
 */
async function findKnowledgeTarget(
  verb: 'write' | 'read',
  workspaceId: string,
  kbDirName: string,
  knowledgeRoot: string,
  openFolder: string | null,
  folders: readonly string[],
): Promise<string | null> {
  // The first page carries the two folders that win outright.
  const ordered = candidateFolders(knowledgeRoot, openFolder, folders);
  const toRepo = (path: string) => path.slice(kbDirName.length + 1);
  for (let start = 0; start < ordered.length; start += ACCESS_BATCH_LIMIT) {
    const page = ordered.slice(start, start + ACCESS_BATCH_LIMIT);
    const { results } = await fetchFileAccessBatch(workspaceId, page.map(toRepo), verb);
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
 * A protected branch asks who may WRITE. Anywhere else the server lets
 * anyone write where they may read, so a draft asks who may READ, in the
 * same order ({@link findKnowledgeTarget}); a tree with no Knowledge folder
 * in it has nothing they may read there, and is answered without a request.
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
  const knowledgeEntry = useMemo(
    () => (knowledgeRoot ? findEntryByPath(tree, knowledgeRoot) : null),
    [tree, knowledgeRoot],
  );
  const folders = useMemo(() => knowledgeFoldersInOrder(knowledgeEntry), [knowledgeEntry]);
  // Not yet known (null) is asked about as protected: the stricter answer.
  const draft = workspaceBranch !== null && !isProtectedBranch(currentBranchModel(), workspaceBranch);
  const knowledgeShown = knowledgeEntry !== null;
  // What an answer was asked about; an answer about anything else is out of date.
  const workspaceKey = `${workspaceId}\n${workspaceBranch}\n${knowledgeRoot}`;
  const askingFor = `${workspaceKey}\n${openFolder}`;

  // Only the latest question's answer lands: a slow reply to an older tree
  // must not overwrite a newer one. And only the latest answer is RETURNED:
  // a caller that asked before a switch (`recheck` from a create) is handed
  // the answer for what is on screen now, never the folder of a branch or
  // page just left, which it would otherwise write to.
  // (`LatestRequest`, the one protocol for it.)
  // Each answer carries what it was asked about, so a caller can tell an
  // answer for the page on screen from one for a page just left.
  const questions = useLatestRequest<{ folder: string | null; askedFor: string | null }>();
  const ask = useCallback(async (): Promise<{ folder: string | null; askedFor: string | null }> => {
    if (!workspaceId || !kbDirName || !knowledgeRoot) return { folder: null, askedFor: null };
    return questions.run(
      async () => {
        if (draft && !knowledgeShown) return { folder: null, askedFor: askingFor };
        try {
          const folder = await findKnowledgeTarget(draft ? 'read' : 'write', workspaceId, kbDirName, knowledgeRoot, openFolder, folders);
          return { folder, askedFor: askingFor };
        } catch {
          return { folder: null, askedFor: askingFor };
        }
      },
      ({ folder }) => setAnswer({ folder, settled: true, askedFor: askingFor }),
    );
  }, [questions, workspaceId, kbDirName, knowledgeRoot, openFolder, folders, askingFor, draft, knowledgeShown]);

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

  // What is on screen, the question to ask about it and the last answer, as
  // of the latest render: a create holds `recheck` / `resolve` across waits,
  // and must ask about the page on screen when it asks, not the one it was
  // started on.
  const screen = useRef({ askingFor, ask, answer, withdrawn });
  useEffect(() => {
    screen.current = { askingFor, ask, answer, withdrawn };
  });
  const recheck = useCallback(async (): Promise<string | null> => {
    for (;;) {
      const { folder, askedFor } = await screen.current.ask();
      // The newest answer is about where the person was, not where they are
      // (they moved inside the debounce): ask about where they are.
      if (askedFor === null || askedFor === screen.current.askingFor) return folder;
    }
  }, []);
  const resolve = useCallback(async (): Promise<string | null> => {
    const { answer: last, askingFor: now, withdrawn: gone } = screen.current;
    if (last.settled && last.askedFor === now) return gone ? null : last.folder;
    return recheck();
  }, [recheck]);

  return {
    folder: withdrawn ? null : answer.folder,
    settled: answer.settled,
    current: answer.settled && answer.askedFor === askingFor,
    recheck,
    resolve,
    withdraw,
  };
}

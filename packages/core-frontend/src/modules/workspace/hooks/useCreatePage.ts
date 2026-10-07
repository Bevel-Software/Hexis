import { useCallback } from 'react';
import { KNOWLEDGE_BASE_DIR, type FileTreeEntry } from '@bevel-software/platform-shared';
import { useWorkspace } from '../state/workspace.context';
import { WorkspaceApiError } from '../services/workspace.api';
import { useFileNav } from '../routing/kb-routes';
import { useMergedWorkspaceTree } from './useMergedWorkspaceTree';
import { pathExistsInTree } from '../utils/fileTree';

/**
 * What "New page" writes: a title, so the page is a page from its first save,
 * and a blank line under it for the cursor to land on.
 */
export const NEW_PAGE_CONTENT = '# Untitled\n\n';

/** `Untitled.md` for the first page, `Untitled N.md` after it. */
export function untitledPagePath(folder: string, n: number): string {
  return n === 1 ? `${folder}/Untitled.md` : `${folder}/Untitled ${n}.md`;
}

/**
 * The first number, from `from` on, whose untitled name the tree does not
 * already hold — a second New page makes a second page rather than reusing
 * the first one's name.
 */
function freeUntitledNumber(tree: FileTreeEntry | null, folder: string, from = 1): number {
  let n = from;
  while (pathExistsInTree(tree, untitledPagePath(folder, n))) n++;
  return n;
}

/**
 * How many names New page tries before it gives up. The tree it picks from
 * can be a moment behind (a teammate or an agent creating pages too), so a
 * refusal moves on to the next name; a handful covers any real race.
 */
const NEW_PAGE_ATTEMPTS = 5;

/**
 * The exclusive create's "that name is taken": 409, for a file that exists
 * now — or one somebody holds the lock on, which is a page being made there.
 */
function isNameTaken(err: unknown): boolean {
  return err instanceof WorkspaceApiError && err.status === 409;
}

export interface CreatePage {
  /** The Knowledge folder pages are created in, or null before the workspace has bootstrapped. */
  knowledgeRoot: string | null;
  /**
   * Create `Untitled.md` (or the next free `Untitled N.md`) in the Knowledge
   * folder and open it in edit mode. Resolves with the path; rejects with an
   * Error whose message is ready to show ("Couldn’t create the page: …").
   */
  createPage(): Promise<string>;
}

/**
 * "New page", shared by everything that offers it — the Get set up list and
 * the command menu — so both pick names the same way and neither can ever
 * overwrite a page.
 *
 * The create is EXCLUSIVE (`ifAbsent`): the name comes from the tree on
 * screen, which may not yet show a page someone else just made, and a plain
 * write would replace that page with an empty one. The page opens through
 * `openWorkspacePath(path, { edit: true })`, which the viewer honours the way
 * an Edit click is honoured — lock, fresh read and all.
 *
 * The caller owns how it says "busy" and where it shows a failure: the
 * column keeps it on its step, the menu reopens with it.
 */
export function useCreatePage(): CreatePage {
  const { kbDirName, createFile } = useWorkspace();
  const { tree } = useMergedWorkspaceTree();
  const { openWorkspacePath } = useFileNav();
  const knowledgeRoot = kbDirName ? `${kbDirName}/${KNOWLEDGE_BASE_DIR}` : null;

  const createPage = useCallback(async (): Promise<string> => {
    if (!knowledgeRoot) throw new Error('Couldn’t create the page: the workspace is still loading.');
    let n = freeUntitledNumber(tree, knowledgeRoot);
    let path = untitledPagePath(knowledgeRoot, n);
    for (let attempt = 1; ; attempt++) {
      try {
        await createFile(path, NEW_PAGE_CONTENT, { ifAbsent: true });
        break;
      } catch (err) {
        if (isNameTaken(err) && attempt < NEW_PAGE_ATTEMPTS) {
          n = freeUntitledNumber(tree, knowledgeRoot, n + 1);
          path = untitledPagePath(knowledgeRoot, n);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Couldn’t create the page: ${msg}`, { cause: err });
      }
    }
    openWorkspacePath(path, { edit: true });
    return path;
  }, [knowledgeRoot, tree, createFile, openWorkspacePath]);

  return { knowledgeRoot, createPage };
}

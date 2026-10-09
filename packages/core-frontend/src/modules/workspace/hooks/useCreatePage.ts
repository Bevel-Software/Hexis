import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { KNOWLEDGE_BASE_DIR, type FileTreeEntry } from '@bevel-software/platform-shared';
import { useWorkspace } from '../state/workspace.context';
import { WorkspaceApiError } from '../services/workspace.api';
import { branchFromPathname, useFileNav } from '../routing/kb-routes';
import { useMergedWorkspaceTree } from './useMergedWorkspaceTree';
import { pathExistsInTree } from '../utils/fileTree';
import { useKnowledgeWriteTarget } from './useKnowledgeWriteTarget';

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

/**
 * A refusal to write there: 403. Access rules and a protected branch's gate
 * both answer it, so it is only a cue to ask again where the person may
 * write — the fresh answer tells the two apart.
 */
function isRefused(err: unknown): boolean {
  return err instanceof WorkspaceApiError && err.status === 403;
}

export interface CreatePage {
  /**
   * The Knowledge folder, or null while there is nowhere safe to create a
   * page: before the workspace has bootstrapped, and while the workspace on
   * screen is not yet the branch the URL names.
   */
  knowledgeRoot: string | null;
  /**
   * Create `Untitled.md` (or the next free `Untitled N.md`) in `pageFolder`
   * and open it in edit mode. Resolves with the path, or with null when the
   * write was refused and a fresh check found nowhere the person may write
   * (New page then disappears; there is nothing to say). Rejects with an
   * Error whose message is ready to show ("Couldn’t create the page: …").
   */
  createPage(): Promise<string | null>;
  /**
   * The Knowledge folder New page writes to (`useKnowledgeWriteTarget`): the
   * Knowledge folder itself when the person may write it, else the folder of
   * the page on screen, else the first they may write in file tree order.
   * Null while the check runs and when there is nowhere — everything that
   * offers New page hides it while this is null.
   */
  pageFolder: string | null;
  /** Whether that check has answered, so a list can wait for it rather than flash. */
  pageFolderSettled: boolean;
}

/**
 * "New page", shared by everything that offers it — the Get set up list and
 * the command menu — so both pick names the same way and neither can ever
 * overwrite a page. It writes where the person may write (`pageFolder`),
 * and a refused write asks again rather than showing who may write there.
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
  const { kbDirName, createFile, workspaceBranch } = useWorkspace();
  const { tree } = useMergedWorkspaceTree();
  const { openWorkspacePath } = useFileNav();
  const { pathname } = useLocation();
  // Where the page would be WRITTEN against where it would OPEN. `createFile`
  // writes to the workspace on screen (`workspaceBranch`), while the page
  // opens on the branch the URL names; mid-switch those differ, the URL
  // already naming the destination. A page made in that gap lands on the
  // branch the person just left, and the viewer then looks for it on the new
  // one and finds nothing. So there is no folder to create in until the two
  // agree. No branch in the URL (the Library) means the workspace on screen
  // is the destination, as `openWorkspacePath` reads it.
  const destination = branchFromPathname(pathname) ?? workspaceBranch;
  const ready = kbDirName !== null && workspaceBranch !== null && destination === workspaceBranch;
  const knowledgeRoot = ready ? `${kbDirName}/${KNOWLEDGE_BASE_DIR}` : null;

  // Where the person may write is asked of the workspace on screen whatever
  // the URL says, so the list and the menu know it mid-switch too; only the
  // create waits for the two to agree.
  const {
    folder: pageFolder,
    settled: pageFolderSettled,
    current: pageFolderCurrent,
    recheck,
  } = useKnowledgeWriteTarget(kbDirName !== null ? `${kbDirName}/${KNOWLEDGE_BASE_DIR}` : null);

  const createPage = useCallback(async (): Promise<string | null> => {
    if (!knowledgeRoot || !pageFolderSettled) {
      throw new Error('Couldn’t create the page: the workspace is still loading.');
    }
    // An answer from before a switch of branch or page may name a folder
    // other than where the person is looking: ask again before writing.
    let folder = pageFolderCurrent ? pageFolder : await recheck();
    // One fresh check after a refusal: access changed since the last answer.
    let rechecked = false;
    while (folder) {
      let n = freeUntitledNumber(tree, folder);
      let path = untitledPagePath(folder, n);
      for (let attempt = 1; ; attempt++) {
        try {
          await createFile(path, NEW_PAGE_CONTENT, { ifAbsent: true });
          openWorkspacePath(path, { edit: true });
          return path;
        } catch (err) {
          if (isNameTaken(err) && attempt < NEW_PAGE_ATTEMPTS) {
            n = freeUntitledNumber(tree, folder, n + 1);
            path = untitledPagePath(folder, n);
            continue;
          }
          if (isRefused(err) && !rechecked) {
            rechecked = true;
            const next = await recheck();
            // Still "may write" there: the refusal was not about access (a
            // protected branch's gate), so it is said as it was.
            if (next !== folder) {
              folder = next;
              break;
            }
          }
          // Who may write there is nobody's business here, whatever answered.
          const msg = (err instanceof Error ? err.message : String(err)).replace(/\s*Eligible:[\s\S]*$/, '');
          throw new Error(`Couldn’t create the page: ${msg}`, { cause: err });
        }
      }
    }
    // Nowhere left to write: the fresh answer has hidden New page, which says it.
    return null;
  }, [knowledgeRoot, pageFolder, pageFolderSettled, pageFolderCurrent, recheck, tree, createFile, openWorkspacePath]);

  return { knowledgeRoot, createPage, pageFolder, pageFolderSettled };
}

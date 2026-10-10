import { kbFileUrl } from './kb-routes';
import { LIBRARY_ROOT, isLibraryLocation, libraryItemWorkspacePath } from '../../library/routes/library-paths';

/**
 * Where the page lands once the file on screen has closed — deleted from the
 * sidebar, or closed from the "This file was deleted" notice: the tab that is
 * left, or with none left the home of the surface the person was on. A Library
 * item's page has no Knowledge home behind it, so it lands on Skills & Tools;
 * every other file page lands on Knowledge home on its branch. Callers
 * navigate with `replace`, so Back never returns to a file that is gone.
 */
export function landingAfterClose(pathname: string, branch: string, newActivePath: string | null): string {
  if (newActivePath === null && isLibraryLocation(pathname)) return LIBRARY_ROOT;
  return kbFileUrl(branch, newActivePath ?? undefined);
}

/**
 * Whether deleting `deletedPath` took the Library item on screen with it — a
 * skill's or a tool's page, which holds no tab, so `deleteEntry` cannot say
 * it closed the active one. True when the file the page's URL names is the
 * deleted path or under it, and when the deleted path is the `SKILL.md` of
 * the skill whose file is on screen: without it there is no skill. The
 * caller lands as `landingAfterClose` says for no tab left: Skills & Tools.
 */
export function deleteTookLibraryItem(pathname: string, kbDirName: string | null, deletedPath: string): boolean {
  if (!isLibraryLocation(pathname)) return false;
  const onScreen = libraryItemWorkspacePath(pathname, kbDirName);
  if (onScreen === null) return false;
  if (onScreen === deletedPath || onScreen.startsWith(`${deletedPath}/`)) return true;
  const skillMd = '/SKILL.md';
  return deletedPath.endsWith(skillMd) && onScreen.startsWith(deletedPath.slice(0, -skillMd.length + 1));
}

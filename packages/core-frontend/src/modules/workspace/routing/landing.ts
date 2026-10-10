import { kbFileUrl } from './kb-routes';
import { LIBRARY_ROOT, isLibraryLocation } from '../../library/routes/library-paths';

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
